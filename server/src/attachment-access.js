/**
 * 附件的「谁能下载」与「什么时候能删」。
 *
 * 改造之前 /uploads 是完全公开的：拿到 URL 就能下载，不需要登录，更不看你是不是那个群的人。
 * 现在收紧成「该附件所在会话的成员才能下载」，判定的依据是 attachment_refs
 * （消息落库时写入，见 linkAttachmentsToMessage；历史数据由 db.js 的回填补上）。
 *
 * 拒绝一律用同一个状态码 + 同一句话（见 DENIED）：分开说「不存在」和「你不是成员」
 * 就等于把接口变成附件存在性探针 —— routes/conversations.js 的 requireMembership
 * 早就是这么做的，这里保持一致。
 */
import { all, get, run, now } from './db.js';
import { attachmentKeysIn, keyFromUrl } from './attachments.js';
import { deleteObject } from './storage.js';
import { logEvent, logWarn } from './log.js';

/** 所有拒绝共用这一档。404 而不是 403：连「有没有这个附件」都不该泄露。 */
export const DENIED = { status: 404, error: '附件不存在' };

/**
 * 历史附件（在 attachments 表里查不到任何一行的对象）的降级策略。
 *
 *   'authenticated'（默认）—— 登录且未停用即可下载
 *   'deny'                 —— 一律拒绝
 *
 * 为什么默认放行而不是默认拒绝：这一档指的是**连 attachments 行都没有**的对象，
 * 也就是 attachments 表存在之前落盘的、或运维手工放进 uploads 目录的文件。
 * 数据库里没有任何线索能说出它属于哪个会话，回填也救不了它（回填靠的是消息正文，
 * 而这些对象根本没有对应的 attachments 记录说明它是什么）。
 *
 * 两害相权：
 *   - 默认拒绝 = 升级当天所有这类老图直接 404，且没有任何修复路径，只能人工排查；
 *   - 默认放行 = 从「谁都能下载、连登录都不用」收紧成「必须是本站有效账号」。
 * 后者相对现状是**严格收紧**，不是放松，也不会造成任何回归。想更严的部署可以设
 * UPLOADS_LEGACY_ACCESS=deny，代价是自己确认没有还在被引用的老对象。
 *
 * 注意这一档**不**包含「有 attachments 行但没有 refs」的对象 —— 那种是「传了没发」，
 * 只有上传者本人能取（见下面的 authorizeDownload），不走这条降级。
 */
const legacyPolicy = () => (process.env.UPLOADS_LEGACY_ACCESS === 'deny' ? 'deny' : 'authenticated');

const isMemberOfAny = (key, userId) => !!get(
  `SELECT 1 FROM attachment_refs r
   JOIN conversation_members cm ON cm.conversation_id = r.conversation_id
   WHERE r.key = ? AND cm.user_id = ? LIMIT 1`,
  key, userId,
);

const hasAnyRef = (key) => !!get('SELECT 1 FROM attachment_refs WHERE key = ? LIMIT 1', key);

/**
 * 头像是**全员可见**的，规则和聊天附件不同，所以单独判一档。
 *
 * 理由：头像会出现在成员列表、@提及候选、搜索结果、历史消息里——任何一个登录用户本来
 * 就能通过 /api/users 看到全站所有人的 avatarUrl。给头像套「同会话成员」的规则，
 * 会让还没建立过会话的两个人互相看不到头像，而且挡不住任何东西（URL 本来就发给他了）。
 * 所以头像只要求「登录且未停用」，这一条由 authenticate 中间件保证。
 *
 * 依据是 users.avatar_url 本身，不额外建表：它就是「这个 key 是不是某人的头像」的唯一事实来源。
 */
const isAvatar = (key) => !!get('SELECT 1 FROM users WHERE avatar_url = ? LIMIT 1', `/uploads/${key}`);

/**
 * 能不能下载。调用方保证 req.user 已经过 authenticate（未登录 401、已停用 401 都在那一层）。
 * @returns {{ok:true, reason:string} | {ok:false, reason:string}}
 */
export function authorizeDownload(key, user) {
  if (!user) return { ok: false, reason: 'anonymous' };
  if (isAvatar(key)) return { ok: true, reason: 'avatar' };
  if (hasAnyRef(key)) {
    return isMemberOfAny(key, user.id)
      ? { ok: true, reason: 'member' }
      : { ok: false, reason: 'not-a-member' };
  }
  const row = get('SELECT owner_id FROM attachments WHERE url = ?', `/uploads/${key}`);
  if (row) {
    // 传了还没发出去：只有上传者本人能取回。别人拿到 key 也没用。
    return row.owner_id === user.id
      ? { ok: true, reason: 'own-unsent' }
      : { ok: false, reason: 'unsent-not-owner' };
  }
  return legacyPolicy() === 'authenticated'
    ? { ok: true, reason: 'legacy' }
    : { ok: false, reason: 'legacy-denied' };
}

/**
 * 消息落库后把它引用到的附件挂到这个会话上。**只挂发送者本来就能读到的那些** ——
 * 否则任何人都能编一条 `![x](/uploads/<别人的key>)` 发进自己的群，把自己加进白名单。
 * （key 是 randomUUID，本来就猜不出来；这里是纵深防御，不是唯一防线。）
 *
 * 转发是允许的：A 在甲群发的图，B（甲群成员）复制进乙群，乙群会多一条 ref。
 * 这跟 B 把图下载下来重新上传是同一件事，拦它没有意义。
 */
export function linkAttachmentsToMessage({ body, conversationId, messageId, senderId, at = now() }) {
  const keys = attachmentKeysIn(body);
  if (!keys.length) return 0;
  const sender = get('SELECT * FROM users WHERE id = ?', senderId);
  let linked = 0;
  for (const key of keys) {
    if (!authorizeDownload(key, sender).ok) continue;
    run(
      'INSERT OR IGNORE INTO attachment_refs (key, conversation_id, message_id, created_at) VALUES (?, ?, ?, ?)',
      key, conversationId, messageId, at,
    );
    linked += 1;
  }
  return linked;
}

// ---- 孤儿对象清理 --------------------------------------------------------
// Composer 在**选中文件的那一刻**就上传了。用户改主意移除附件、或者干脆不发，
// 对象已经落库/落桶了，而且此前全仓没有任何一处会删除它 —— 桶只会一直涨。

const ORPHAN_TTL_HOURS = () => {
  const raw = Number(process.env.UPLOAD_ORPHAN_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
};
export const orphanTtlMs = () => ORPHAN_TTL_HOURS() * 60 * 60 * 1000;

const SWEEP_INTERVAL_MS = () => {
  const raw = Number(process.env.UPLOAD_SWEEP_INTERVAL_MINUTES);
  return (Number.isFinite(raw) && raw > 0 ? raw : 60) * 60 * 1000;
};

/**
 * 一个对象够得上「孤儿」的全部条件，缺一不可：
 *
 *   1. 有 attachments 行 —— 只清理**我们自己记过账**的对象。没有行的（回填也认不出的
 *      历史文件）一律不碰：删错了没法恢复，而漏删只是占点磁盘。
 *   2. 上传时间早于 now - TTL（默认 24 小时）—— 刚传还没发的一律不动，这是本函数
 *      最重要的一条，用例见 test/orphan-sweep.test.js「刚上传还没发送的对象不会被误删」。
 *   3. attachment_refs 里没有任何一条引用它。
 *   4. 没有任何一条消息的正文提到它。第 3 条理论上已经覆盖第 4 条，但这一条是
 *      **兜底**：万一哪条写消息的路径忘了调 linkAttachmentsToMessage（比如以后新增的
 *      系统消息、AI 消息），refs 会是空的，而正文里明明白白引着它。宁可少删。
 *   5. 不是任何人的头像。头像不进 attachments 表，这里再挡一道。
 *
 * 第 4 条依赖 messages.body 是明文，同 db.js 回填那段的说明。
 */
export function findOrphanCandidates({ olderThanMs = orphanTtlMs(), at = now() } = {}) {
  return all(
    `SELECT a.id, a.url, a.created_at FROM attachments a
     WHERE a.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM attachment_refs r WHERE '/uploads/' || r.key = a.url)
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE instr(m.body, a.url) > 0)
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_url = a.url)`,
    at - olderThanMs,
  );
}

/** 跑一轮清理。返回 { scanned, deleted, failed }。 */
export async function sweepOrphanObjects(options = {}) {
  const candidates = findOrphanCandidates(options);
  let deleted = 0;
  let failed = 0;
  for (const row of candidates) {
    const key = keyFromUrl(row.url);
    if (!key) { failed += 1; continue; }
    try {
      await deleteObject(key);
      run('DELETE FROM attachments WHERE id = ?', row.id);
      deleted += 1;
    } catch (err) {
      // 删不掉就留着，下一轮再试。不删 attachments 行，免得记录没了对象还在。
      failed += 1;
      logWarn('uploads.sweep_failed', { attachmentId: row.id, err: String(err?.message || err) });
    }
  }
  // 只记条数，不记 key、不记文件名 —— 见 log.js 顶上的红线。
  if (candidates.length) logEvent('uploads.sweep', { scanned: candidates.length, deleted, failed });
  return { scanned: candidates.length, deleted, failed };
}

/**
 * 起一个后台定时器跑清理。只在 index.js 里调用，不放进 createApp：
 * 测试跑几百个 app 实例，每个都挂一个定时器纯属添乱（用例直接调 sweepOrphanObjects）。
 * 返回停止函数。
 */
export function startOrphanSweeper() {
  const interval = SWEEP_INTERVAL_MS();
  const tick = () => { sweepOrphanObjects().catch(() => {}); };
  const timer = setInterval(tick, interval);
  timer.unref?.();                                   // 别让它拖住进程退出
  return () => clearInterval(timer);
}
