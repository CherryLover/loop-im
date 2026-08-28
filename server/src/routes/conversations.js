import { Router } from 'express';
import { all, get, run, now, uid } from '../db.js';
import { authenticate, isDisabled, publicUser, requireAdmin } from '../auth.js';
import { emitTo } from '../events.js';
import { queuePush, reportPushFailure } from '../push-decide.js';
import { parseMentions } from '../mentions.js';
import { decrypt } from '../secret-box.js';
import { escapeLike } from '../sql.js';
import { linkAttachmentsToMessage } from '../attachment-access.js';
import { addReaction, groupReactions, normalizeEmoji, reactionRows, reactionsOf, removeReaction } from '../reactions.js';
import { truncate } from '../text.js';
import { consumeQuota, limitUsage, quotaState, rejectOverQuota } from '../usage-limit.js';
import { logError, logEvent } from '../log.js';

export const router = Router();
router.use(authenticate);

const memberIds = (conversationId) =>
  all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conversationId).map((r) => r.user_id);

const memberRows = (conversationId) =>
  all(
    `SELECT u.*, cm.joined_at FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ? ORDER BY cm.joined_at, u.rowid`,
    conversationId,
  );

function requireMembership(req, res, id) {
  const convo = get('SELECT * FROM conversations WHERE id = ?', id);
  if (!convo || !memberIds(id).includes(req.user.id)) {
    res.status(404).json({ error: '会话不存在' });
    return null;
  }
  return convo;
}

// ---- 已读位置 ----------------------------------------------------------
// 未读计数和已读回执共用 conversation_reads：一个人在一个会话里读到哪一刻。

const lastReadAt = (conversationId, userId) =>
  get('SELECT last_read_at FROM conversation_reads WHERE conversation_id = ? AND user_id = ?',
    conversationId, userId)?.last_read_at || 0;

// ---- 个人偏好：置顶 / 免打扰 -------------------------------------------
// 两者都写在 conversation_members 里「我自己」那一行上，是「这个人在这个会话里」的
// 设置，不是会话的全局属性：A 把某个群置顶或设为免打扰，B 那边一个字都不会变。
//
// 免打扰（muted）的语义只有一条，务必守住：**不打扰，不是不计数**。
// 消息照收、未读照算、@我 照样统计，muted 只影响「怎么提醒」——不弹桌面通知、
// 会话列表徽标弱化。所以 unreadSummary 那段 SQL 里绝不能掺进 muted：
// 一旦掺进去就成了「静音即已读」，那是另一回事，也是这块最容易做错的地方。

/** 我对这个会话的个人偏好。成员行不在（历史脏数据）时一律按默认值走。 */
const prefsOf = (conversationId, userId) => {
  const row = get(
    'SELECT pinned, muted FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    conversationId, userId,
  );
  return { pinned: !!row?.pinned, muted: !!row?.muted };
};

/**
 * 把这个会话设成免打扰的人。推送判定的输入之一（push-decide.js 的规则 4）。
 *
 * ⚠️ 免打扰**一票否决**，@我 也不推。用户原话：「跟谁 @ 谁没关系，只要设置了免打扰
 * 就不推送」。所以这里查的就是全部 muted 成员，不需要也不许再和 mentions 交叉。
 * 完整出处和被否决的备选见 push-decide.js 顶部那段注释。
 */
const mutedMemberIds = (conversationId) => new Set(
  all('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND muted = 1', conversationId)
    .map((r) => r.user_id),
);

/**
 * 会话列表的排序口径：置顶的整体排在前面，置顶组与非置顶组各自内部仍按
 * 最后消息时间倒序（没有消息的算 0，排在本组最后）。置顶只改分组，不改组内规则。
 * 导出供前端之外的测试直接验证，前端 lib/conversations.ts 是同一份口径的镜像。
 */
export const compareConversations = (a, b) =>
  Number(!!b.pinned) - Number(!!a.pinned)
  || (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0);

/**
 * messages.mentions 存的是 JSON 数组文本（如 `["u_1","all"]`），要在 SQL 里判断
 * 「有没有我」只能做文本匹配。裸着 LIKE '%id%' 会踩 id 互为前缀的坑：u_1 会命中
 * ["u_12"]。所以连着两侧的引号一起匹配 —— `"u_1"` 这个模式在 `["u_12"]` 里不存在，
 * 引号就是明确的分隔符（id 由 uid() 生成，不含引号和反斜杠，JSON 里不会被转义）。
 *
 * 另一半坑在 LIKE 自己身上：id 里的 `_` 是 LIKE 的单字符通配符，不转义的话
 * `"u_1"` 会匹配到 `"uX1"`。转义交给 escapeLike，查询侧配 ESCAPE '\'。
 */
export const mentionLike = (value) => `%"${escapeLike(value)}"%`;

/**
 * 一次扫描同时给出两个数：
 * - unread：比我的已读位置更新、且不是我自己发的消息；
 * - mentions：上面这些未读里，`mentions` 含我的 id 或 'all'（@全员）的条数。
 * 「不是我自己发的」这一条同时管住了「自己 @全员 不算自己被 @」。
 *
 * 会话列表每次刷新都会调，所以计数留在 SQL 里做，绝不把消息捞出来在 JS 里过滤。
 */
const unreadSummary = (conversationId, userId) => {
  const row = get(
    `SELECT count(*) AS unread,
            coalesce(sum(CASE WHEN mentions LIKE ? ESCAPE '\\' OR mentions LIKE ? ESCAPE '\\'
                              THEN 1 ELSE 0 END), 0) AS mentions
     FROM messages WHERE conversation_id = ? AND sender_id != ? AND created_at > ?`,
    mentionLike(userId), mentionLike('all'),
    conversationId, userId, lastReadAt(conversationId, userId),
  );
  return { unread: row.unread, mentions: Number(row.mentions) };
};

/** 未读 = 比我的已读位置更新、且不是我自己发的消息。 */
const unreadCount = (conversationId, userId) => unreadSummary(conversationId, userId).unread;

/** 未读里「有人 @ 我」的条数（含 @全员）。导出供测试直接验证 SQL 判定口径。 */
export const mentionUnreadCount = (conversationId, userId) => unreadSummary(conversationId, userId).mentions;

/**
 * 会话里其他人的已读位置。一次性给出来，前端自己算每条消息被谁读过，
 * 避免为每条消息都查一次库。AI 不参与已读统计。
 */
const readsOf = (conversationId, viewerId) => all(
  `SELECT r.user_id, r.last_read_at FROM conversation_reads r
   JOIN users u ON u.id = r.user_id
   WHERE r.conversation_id = ? AND r.user_id != ? AND u.role != 'ai'`,
  conversationId, viewerId,
).map((r) => ({ userId: r.user_id, lastReadAt: r.last_read_at }));

/**
 * 站内视频附件的 Markdown 写法（两种都算）。
 *
 * 判据是 **URL 的扩展名**，不是 Markdown 语法——口径和前端 `web/src/lib/md.ts` 的
 * `isVideoAttachment` 完全一致，理由也一样：`/uploads/<key>` 里的扩展名是服务端按真实
 * 字节嗅探出来再拼上去的（见 attachments.js），是服务端替我们背书过的事实；
 * 而「写 `![片子](…)` 还是 `[片子](…)`」是发消息的人说了算的，同一段视频在库里两种写法
 * 都有（Composer 现在走链接写法，AI 生成的和手打的都可能不一样）。只按语法区分，
 * 等于让同一个附件在预览里有两种叫法。
 *
 * 和 md.ts 一样，先把 `?query` / `#hash` 切掉再看后缀：正文是用户手打的，
 * `[x](/uploads/a.bin?v=.mp4)` 不能因此被叫成视频。
 */
const VIDEO_ATTACHMENT = /!?\[[^\]]*\]\(\/uploads\/[^)\s?#]*\.(?:mp4|webm)(?:[?#][^)]*)?\)/gi;

/**
 * 推送正文的长度。会话列表那一行是 26 字，推送要长得多。
 *
 * 为什么是 120 而不是「完整消息」：通知本身有系统级的长度限制，锁屏上折叠态
 * iOS 大约 4 行、安卓 1~2 行，再长的部分**根本不会被显示**，只是白白占 payload
 * （Web Push 的密文体有 4KB 上限，中文一个字 3 字节，一条超长正文能把它吃掉一大半）。
 * 120 个字对 IM 消息来说已经覆盖了绝大多数「一条消息」的全长，超出的那一小撮
 * 本来在通知里也读不完，点进去看才是对的。
 */
export const PUSH_PREVIEW_LIMIT = 120;

// 截断走 text.js 的 truncate（按字素簇），不能用 slice —— slice 按 UTF-16 码元切，
// 正好切在 emoji 中间就留下半个代理对，预览里是个 �。理由与样例见 text.js。
//
// 导出是给推送用的（push-decide.js 的正文就是这里出来的）：会话列表最后一条消息和
// 推送正文必须是**同一个函数**算出来的，不是同一份逻辑抄两遍，否则迟早只改一边。
export const previewOf = (body, limit = 26) =>
  truncate(
    String(body ?? '')
      // 视频要排在图片和文件两条前面：它两种写法都占，被前面任何一条先吃掉就成了
      // 「[图片]」或者「[文件] 名字」，视频在预览里就永远露不出面。
      .replace(VIDEO_ATTACHMENT, '[视频]')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
      // 非图片附件是普通链接，会话列表里只显示「[文件] 名字」，不把 /uploads/ 路径抖出来。
      .replace(/\[([^\]]*)\]\(\/uploads\/[^)]*\)/g, '[文件] $1')
      .replace(/[#*`\-\n]/g, ' ').replace(/\s+/g, ' ').trim(),
    limit,
  );

// 引用块比会话列表那一行宽，可以多给几个字，但也只是一眼扫过去认出「回的是哪条」。
const QUOTE_PREVIEW_LIMIT = 48;
/** 原消息查不到（被删了、id 是伪造的）时统一这么说，界面照此降级。 */
export const QUOTE_UNAVAILABLE = '消息已不可用';

/**
 * 被引用消息的摘要：发送者名字 + 正文截断，跟着消息一起下发，前端不用再发一轮请求。
 *
 * 三件事必须守住：
 * 1. 查询条件里带上 conversation_id —— 这是跨会话引用的第二道防线。就算库里因为
 *    历史数据或别处的 bug 存进了一个属于别的会话的 reply_to，摘要也绝不会把那边的
 *    正文带出来，只会降级成「消息已不可用」。
 * 2. 只展开一层：这里返回的是纯数据，不含被引用消息自己的 quote / replyTo，
 *    所以 A 引用 B、B 引用 C 时不会顺着链子递归下去。
 * 3. 正文走 decrypt()：今天 messages.body 是明文，decrypt() 对明文是原样返回；
 *    真到了正文落库加密的那天，摘要读的也一定是解密后的值，而不是 v1: 开头的密文。
 *
 * 发送者已退群不影响摘要 —— 退群删的是 conversation_members，users 那行还在，名字照常。
 * 只有连 users 那行都没了（历史脏数据）才用 LEFT JOIN 兜底给个占位名。
 */
export function quoteOf(replyToId, conversationId) {
  if (!replyToId) return null;
  const row = get(
    `SELECT m.body, u.name AS sender_name FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.id = ? AND m.conversation_id = ?`,
    replyToId, conversationId,
  );
  if (!row) return { senderName: '', preview: QUOTE_UNAVAILABLE, available: false };
  return {
    senderName: row.sender_name || '已注销的成员',
    preview: previewOf(decrypt(row.body), QUOTE_PREVIEW_LIMIT) || QUOTE_UNAVAILABLE,
    available: true,
  };
}

/**
 * reactions 由调用方批量查好再传进来（见 reactions.js 的 reactionsOf）：一页最多 200 条，
 * 在这里现查就是 200 次往返。刚写入的消息还不可能有回应，默认空数组即可。
 */
export function serializeMessage(row, sender, reactions = []) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: sender?.name || row.sender_id,
    senderAvatarUrl: sender?.avatar_url || null,
    body: row.body,
    mentions: JSON.parse(row.mentions || '[]'),
    createdAt: row.created_at,
    // 兼容两代 AI：退役的 Aria（sender_id 固定 'ai'）与将来的 hapi Agent 用户（role='ai'）。
    isAI: sender?.role === 'ai' || row.sender_id === 'ai',
    kind: row.kind || 'user',
    replyTo: row.reply_to || null,               // 被引用消息的 id，前端据此跳转
    quote: quoteOf(row.reply_to, row.conversation_id),
    reactions,                                   // 每种表情：谁点了、多少个、我点没点
  };
}

/**
 * 成员变动、改群名之类的系统提示。挂在操作者名下但标成 system：
 * 不能借任何成员的口说，也不该被 AI 当成对话内容学习，所以 ai_visible 一律为 0。
 */
function insertSystemMessage(conversationId, actorId, body) {
  const id = uid('m');
  run(
    `INSERT INTO messages (id, conversation_id, sender_id, body, mentions, ai_visible, kind, created_at)
     VALUES (?, ?, ?, ?, '[]', 0, 'system', ?)`,
    id, conversationId, actorId, body, now(),
  );
  const row = get('SELECT * FROM messages WHERE id = ?', id);
  const actor = get('SELECT * FROM users WHERE id = ?', actorId);
  emitTo(memberIds(conversationId), 'message', { message: serializeMessage(row, actor) });
  return row;
}

/**
 * 建群 / 加成员时把停用的账号挡掉：他登不进来，拉进新群只会多一个永远不说话的人。
 * 前端也不会把他列进可选名单（见 CreateGroupModal / ManageGroupModal），这里是后端那一道。
 * 注意只挡「新拉进来」——已经在群里的停用成员照常留着，历史和成员名单都不动。
 * 返回一句错误文案，没有停用的人则返回空字符串。
 */
function disabledAmong(rows) {
  const blocked = rows.filter(isDisabled);
  return blocked.length ? `${blocked.map((u) => u.name).join('、')} 的账号已停用，无法加入群聊` : '';
}

/** 群里能改成员和群名的人：建群者本人，或系统管理员。 */
function canManageGroup(convo, user) {
  return convo.type === 'group' && (convo.created_by === user.id || user.role === 'admin');
}

function serializeConversation(convo, viewerId) {
  // Creator first, AI last — the reading order the design shows in the member pane.
  const members = memberRows(convo.id).sort((a, b) => {
    const rank = (u) => (u.id === convo.created_by ? 0 : u.role === 'ai' ? 2 : 1);
    return rank(a) - rank(b) || a.joined_at - b.joined_at;
  });
  const peer = convo.type !== 'group' ? members.find((m) => m.id !== viewerId) : null;
  const counts = unreadSummary(convo.id, viewerId);
  const prefs = prefsOf(convo.id, viewerId);
  const last = get(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    convo.id,
  );
  return {
    id: convo.id,
    type: convo.type,
    title: convo.type === 'group' ? convo.title : peer?.name || '会话',
    peerId: peer?.id || null,
    createdBy: convo.created_by || null,        // 前端据此判断谁能管理成员与群名
    members: members.map((m) => ({ ...publicUser(m), roleInGroup: m.id === convo.created_by ? '管理员' : m.role === 'ai' ? '常驻' : m.dept })),
    lastMessage: last
      ? { preview: `${last.sender_id === viewerId ? '我：' : ''}${previewOf(last.body)}`, createdAt: last.created_at }
      : null,
    unread: counts.unread,
    mentionsUnread: counts.mentions,      // 未读里「有人 @ 我」的条数，前端据此高亮
    // 下面两个是「我」的个人设置，同一个会话对不同的人可以给出不同的值。
    pinned: prefs.pinned,
    // 注意 muted 与 unread 是两回事：muted 为 true 时 unread 照样在涨，
    // 免打扰改的是提醒方式（不弹通知、徽标弱化），不是把未读抹掉。
    muted: prefs.muted,
  };
}

router.get('/', (req, res) => {
  const rows = all(
    `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE cm.user_id = ?`,
    req.user.id,
  ).map((c) => serializeConversation(c, req.user.id));
  // 置顶的排在最前面，两组内部照旧按最后消息时间倒序（见 compareConversations）。
  rows.sort(compareConversations);
  res.json({ conversations: rows });
});

router.get('/:id', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  res.json({ conversation: serializeConversation(convo, req.user.id) });
});

/** 只允许改这两项，也只有这两项会被拼进 SET 子句（白名单，不接受任意列名）。 */
const PREF_COLUMNS = ['pinned', 'muted'];

/**
 * 置顶 / 取消置顶、免打扰 / 取消免打扰。两项可以分开改也可以一起改。
 *
 * 写的是 conversation_members 里「我自己」那一行 —— WHERE 同时带上 conversation_id
 * 和 req.user.id，所以任何情况下都只会动到自己的设置，别人的行原封不动。
 * 免打扰在这里只是存一个标记，未读计数那条路径完全不看它（免打扰 ≠ 不计未读）。
 */
router.patch('/:id/prefs', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;

  const body = req.body || {};
  const changing = PREF_COLUMNS.filter((key) => body[key] !== undefined);
  if (!changing.length) return res.status(400).json({ error: '请指定 pinned 或 muted' });
  if (changing.some((key) => typeof body[key] !== 'boolean')) {
    return res.status(400).json({ error: 'pinned 与 muted 只能是 true 或 false' });
  }

  run(
    `UPDATE conversation_members SET ${changing.map((key) => `${key} = ?`).join(', ')}
     WHERE conversation_id = ? AND user_id = ?`,
    ...changing.map((key) => (body[key] ? 1 : 0)), convo.id, req.user.id,
  );
  res.json({ conversation: serializeConversation(convo, req.user.id) });
});

// 管理员建群。人数只要求至少 1 人，建完还可以随时增减。
// （曾经 AI 助手默认加入，Aria 退役后新群默认没有任何 AI 成员，
//  将来 hapi 的 Agent 用户由管理员按需拉入 —— 见 docs/hapi-Agent-接入方案.md D8。）
router.post('/group', requireAdmin, limitUsage('write'), (req, res) => {
  const title = String(req.body?.title || '').trim() || '新群聊';
  const picked = [...new Set((req.body?.memberIds || []).filter((id) => id !== req.user.id))];
  if (!picked.length) return res.status(400).json({ error: '请至少选择 1 名成员' });
  const known = all(`SELECT * FROM users WHERE id IN (${picked.map(() => '?').join(',')})`, ...picked);
  if (known.length !== picked.length) return res.status(400).json({ error: '成员不存在' });
  const blocked = disabledAmong(known);
  if (blocked) return res.status(400).json({ error: blocked });

  const id = uid('c');
  const ts = now();
  run('INSERT INTO conversations (id, type, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    id, 'group', title, req.user.id, ts);
  for (const m of [req.user.id, ...picked]) {
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', id, m, ts);
  }
  const convo = get('SELECT * FROM conversations WHERE id = ?', id);
  logEvent('group.created', { reqId: req.id, actorId: req.user.id, conversationId: id, memberCount: picked.length + 1 });
  const serialized = serializeConversation(convo, req.user.id);
  emitTo([req.user.id, ...picked], 'conversation-created', { conversationId: id });
  res.status(201).json({ conversation: serialized });
});

// 联系人页「去聊天」：拿到或新建一对一会话。
// type='ai' 这一档保留：历史上与 Aria 的私聊是这个类型，将来 hapi Agent 私聊也走它。
router.post('/direct', (req, res) => {
  const peerId = String(req.body?.userId || '');
  const peer = get('SELECT * FROM users WHERE id = ?', peerId);
  if (!peer || peer.id === req.user.id) return res.status(400).json({ error: '联系人不存在' });

  const type = peer.role === 'ai' ? 'ai' : 'dm';
  const existing = get(
    `SELECT c.id FROM conversations c
     JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
     JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
     WHERE c.type = ? LIMIT 1`,
    req.user.id, peer.id, type,
  );
  if (existing) {
    // 已经聊过就照常打开：停用不是删除，那段历史是双方共有的，任何时候都要能翻回来。
    // 这一条故意排在下面的停用校验之前。
    return res.json({ conversation: serializeConversation(get('SELECT * FROM conversations WHERE id = ?', existing.id), req.user.id) });
  }
  // 但不给「新开」一个跟停用账号的私聊：对方永远不会看见，凭空多一个空会话没有意义。
  if (isDisabled(peer)) return res.status(400).json({ error: `${peer.name} 的账号已停用，无法发起新的会话` });
  const id = uid('c');
  const ts = now();
  run('INSERT INTO conversations (id, type, title, created_by, created_at) VALUES (?, ?, NULL, ?, ?)', id, type, req.user.id, ts);
  run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', id, req.user.id, ts);
  run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', id, peer.id, ts);
  emitTo([req.user.id, peer.id], 'conversation-created', { conversationId: id });
  res.status(201).json({ conversation: serializeConversation(get('SELECT * FROM conversations WHERE id = ?', id), req.user.id) });
});

// ---- 群成员与群名管理 ---------------------------------------------------
// 建群者与系统管理员可以增减成员、改群名；任何成员都可以自己退群。

router.post('/:id/members', limitUsage('write'), (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  if (!canManageGroup(convo, req.user)) return res.status(403).json({ error: '只有群主或管理员可以添加成员' });

  const existing = new Set(memberIds(convo.id));
  const picked = [...new Set((req.body?.userIds || []).map(String))].filter((id) => !existing.has(id));
  if (!picked.length) return res.status(400).json({ error: '请选择要添加的成员' });

  const rows = all(`SELECT * FROM users WHERE id IN (${picked.map(() => '?').join(',')})`, ...picked);
  if (rows.length !== picked.length) return res.status(400).json({ error: '成员不存在' });
  const blocked = disabledAmong(rows);
  if (blocked) return res.status(400).json({ error: blocked });

  const ts = now();
  for (const u of rows) {
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', convo.id, u.id, ts);
  }
  // 只记 id，不记群名和成员名字：谁把谁加进了哪个群，靠 id 就能查清楚。
  logEvent('group.members_added', { reqId: req.id, actorId: req.user.id, conversationId: convo.id, targetIds: rows.map((u) => u.id) });
  insertSystemMessage(convo.id, req.user.id, `${req.user.name} 邀请 ${rows.map((u) => u.name).join('、')} 加入了群聊`);
  // 新成员此前不在群里，收不到上面那条广播，单独通知他们会话有变。
  emitTo(memberIds(convo.id), 'conversation-created', { conversationId: convo.id });
  res.json({ conversation: serializeConversation(convo, req.user.id) });
});

router.delete('/:id/members/:userId', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  if (!canManageGroup(convo, req.user)) return res.status(403).json({ error: '只有群主或管理员可以移除成员' });

  const target = req.params.userId;
  if (target === convo.created_by) return res.status(400).json({ error: '不能移除群主，群主请使用退出群聊' });
  if (!memberIds(convo.id).includes(target)) return res.status(404).json({ error: '该成员不在群里' });

  const user = get('SELECT * FROM users WHERE id = ?', target);
  const audience = memberIds(convo.id);          // 先取，被移除的人也应收到这条提示
  run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', convo.id, target);
  logEvent('group.member_removed', { reqId: req.id, actorId: req.user.id, conversationId: convo.id, targetId: target });
  insertSystemMessage(convo.id, req.user.id, `${req.user.name} 将 ${user.name} 移出了群聊`);
  emitTo(audience, 'conversation-created', { conversationId: convo.id });
  res.json({ conversation: serializeConversation(convo, req.user.id) });
});

router.patch('/:id', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  if (!canManageGroup(convo, req.user)) return res.status(403).json({ error: '只有群主或管理员可以改群名' });

  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: '群名称不能为空' });
  if (title === convo.title) return res.json({ conversation: serializeConversation(convo, req.user.id) });

  run('UPDATE conversations SET title = ? WHERE id = ?', title, convo.id);
  insertSystemMessage(convo.id, req.user.id, `${req.user.name} 把群名改为「${title}」`);
  const updated = get('SELECT * FROM conversations WHERE id = ?', convo.id);
  res.json({ conversation: serializeConversation(updated, req.user.id) });
});

/** 自己退群。群主退群后群仍然存在，剩下的成员由管理员接手管理。 */
router.post('/:id/leave', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  if (convo.type !== 'group') return res.status(400).json({ error: '只有群聊可以退出' });

  const audience = memberIds(convo.id);
  run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', convo.id, req.user.id);
  insertSystemMessage(convo.id, req.user.id, `${req.user.name} 退出了群聊`);
  emitTo(audience, 'conversation-created', { conversationId: convo.id });
  res.json({ ok: true });
});

// 分页：默认只给最新的一页，再往前用 before 游标翻。原来是把整个会话的历史
// 一次性返回，消息一多就是几 MB 的响应加上前端一次渲染几千个气泡。
export const MESSAGE_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

router.get('/:id/messages', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;

  const asked = Number(req.query.limit);
  const limit = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : MESSAGE_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  // before 传的是一条消息的 id，取比它更早的那些。同一毫秒内的多条消息用 rowid
  // 兜底定序，否则翻页会漏掉或重复。
  const before = req.query.before ? String(req.query.before) : '';
  const anchor = before
    ? get('SELECT created_at, rowid FROM messages WHERE id = ? AND conversation_id = ?', before, convo.id)
    : null;
  if (before && !anchor) return res.status(400).json({ error: '游标无效' });

  // 多取一条用来判断还有没有更早的，不用再跑一次 count。
  const rows = anchor
    ? all(
      `SELECT m.*, u.name AS sender_name, u.avatar_url FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? AND (m.created_at < ? OR (m.created_at = ? AND m.rowid < ?))
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      convo.id, anchor.created_at, anchor.created_at, anchor.rowid, limit + 1,
    )
    : all(
      `SELECT m.*, u.name AS sender_name, u.avatar_url FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      convo.id, limit + 1,
    );

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse();   // 返回给前端仍是由早到晚
  // 整页的回应一次查完再分发给每条消息：逐条去查就是一页 200 次往返。
  const reactions = reactionsOf(page.map((r) => r.id), req.user.id);
  res.json({
    messages: page.map((r) => serializeMessage(r, { name: r.sender_name, avatar_url: r.avatar_url }, reactions.get(r.id) || [])),
    hasMore,
    nextBefore: hasMore && page.length ? page[0].id : null,          // 下一页从本页最早那条往前翻
    reads: readsOf(convo.id, req.user.id),                          // 谁读到了哪一刻，前端据此标已读
  });
});

/**
 * 上报已读位置。upTo 省略时按此刻算；只允许前进，也不允许超过当前时间
 * （否则客户端传一个很大的值就能把以后收到的消息也预先标成已读）。
 */
router.post('/:id/read', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;

  const ts = now();
  const asked = Number(req.body?.upTo);
  const upTo = Math.min(Number.isFinite(asked) && asked > 0 ? asked : ts, ts);
  const current = lastReadAt(convo.id, req.user.id);
  const next = Math.max(current, upTo);

  run(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_id)
     DO UPDATE SET last_read_at = excluded.last_read_at, updated_at = excluded.updated_at`,
    convo.id, req.user.id, next, ts,
  );
  // 位置没变就不用惊动别人，省掉一轮无意义的广播。
  if (next !== current) {
    emitTo(memberIds(convo.id), 'read', { conversationId: convo.id, userId: req.user.id, lastReadAt: next });
  }
  res.json({ conversationId: convo.id, lastReadAt: next, unread: unreadCount(convo.id, req.user.id) });
});

/**
 * 一条刚发出去的消息，该推的推走。**发射后不管**。
 *
 * 调用点都在 `emitTo(...)` / `res.json(...)` 之后，所以这里绝不能把异常放出去：
 * 响应已经发了，之后冒出来的 rejection 会被 Express 5 转给错误中间件，那时
 * `headersSent` 已是 true，撞 `ERR_HTTP_HEADERS_SENT`，在日志里留下与真实故障
 * 无关的堆栈（issue #19 那个坑）。所以两道都要有：
 *   - `queuePush` 内部自己兜住所有异步错误、永远 resolve；
 *   - 这里的 try 兜住同步部分（下面那两次 SQL 查询）；
 *   - 末尾的 .catch 只是第三道保险。
 * **发推送失败绝不能让发消息这个请求失败。**
 *
 * `insertSystemMessage` 那处不接：它发的是 `kind: 'system'`，规则 3 本来就会全挡掉，
 * 不接省一次无谓的查询，也少一处将来会忘的调用点。
 */
export function pushForMessage(convo, message, audience, deps) {
  try {
    queuePush({
      message,
      conversation: convo,
      // 推送正文和会话列表最后一条消息走的是同一个 previewOf，只是给的字数不同。
      body: previewOf(message.body, PUSH_PREVIEW_LIMIT),
      memberIds: audience,
      mutedBy: mutedMemberIds(convo.id),
    }, deps).catch(reportPushFailure);
  } catch (err) {
    reportPushFailure(err);
  }
}

router.post('/:id/messages', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: '消息不能为空' });

  // 引用回复：被引用的消息必须存在，而且必须属于同一个会话。少了后半句，任何人
  // 都能拿别的群的消息 id 当 replyTo 发一条，再从引用摘要里把那边的正文读出来 ——
  // 会话成员校验就等于白做了。两种失败给同一句提示：分开说等于告诉调用方
  // 「这个 id 在别处存在」，接口就成了消息是否存在的探针。
  const replyTo = req.body?.replyTo ? String(req.body.replyTo) : null;
  if (replyTo && !get('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', replyTo, convo.id)) {
    return res.status(400).json({ error: '引用的消息不存在或不属于当前会话' });
  }

  const roster = memberRows(convo.id);
  const mentions = parseMentions(body, roster);
  const audience = roster.map((m) => m.id);

  // ---- 限流 -------------------------------------------------------------
  // 检查放在参数校验之后、写库之前：空消息、非法引用这类 400 不该白吃掉额度。
  // 计数放在写库成功之后，所以这一档数的是「成功发出去几条」——语义上和登录那套
  // 「只数失败、成功清零」正相反，两者各用各的模块，见 usage-limit.js 开头。
  const state = quotaState('message', req.user.id);
  if (!state.allowed) return rejectOverQuota(res, 'message', state, { userId: req.user.id, route: req.originalUrl });

  const id = uid('m');
  // ai_visible 列已随 Aria 退役停用（列保留，统一写 0），见 docs/hapi-Agent-接入方案.md §F。
  run('INSERT INTO messages (id, conversation_id, sender_id, body, mentions, ai_visible, reply_to, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    id, convo.id, req.user.id, body, JSON.stringify(mentions), replyTo, now());
  consumeQuota('message', req.user.id);
  // 正文里引用到的附件挂到这个会话上：附件的下载鉴权就是查这张关联表（见 attachment-access.js）。
  linkAttachmentsToMessage({ body, conversationId: convo.id, messageId: id, senderId: req.user.id });
  const message = serializeMessage(get('SELECT * FROM messages WHERE id = ?', id), req.user);
  emitTo(audience, 'message', { message });
  res.status(201).json({ message });

  // 响应已经发出去了。推送是「发射后不管」，失败不影响这次发消息的结果
  // （消息已经入库、201 已经回了）。
  pushForMessage(convo, message, audience);
});

// ---- 消息表情回应 -------------------------------------------------------
// 给消息点 👍 ❤️ 之类，省掉一屏「收到」「好的」。加和取消是两个接口，各自幂等：
// 重复点不会多出一行（唯一索引在库里），没点过时取消也不算错误。

/**
 * 加和取消共用的失败提示。「这条消息不存在」和「消息存在但不在我能看到的会话里」
 * 必须是同一句话——分开说等于告诉调用方「这个 id 在别处是存在的」，接口就成了
 * 消息存在性探针。引用回复那边（见上面的 POST /:id/messages）是同样的处理。
 */
export const REACTION_TARGET_MISSING = '消息不存在或无权访问';

/**
 * 定位要回应的那条消息。一条 SQL 同时管住两件事：消息属于 URL 上的这个会话，
 * 而且我确实是这个会话的成员。任何一条不满足都走同一个 404，外面看不出差别。
 */
function reactionTarget(req, res) {
  const row = get(
    `SELECT m.id, m.conversation_id FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
     WHERE m.id = ? AND m.conversation_id = ?`,
    req.user.id, req.params.messageId, req.params.id,
  );
  if (!row) {
    res.status(404).json({ error: REACTION_TARGET_MISSING });
    return null;
  }
  return row;
}

/**
 * 回应变了：广播给会话里每个人，并把「相对调用者」的那一份返回给他。
 * mine 是相对观察者的，所以每人一份；但库只查一次，折叠在内存里做。
 */
function publishReactions(conversationId, messageId, viewerId) {
  const rows = reactionRows([messageId]);
  const viewOf = (userId) => groupReactions(rows, userId).get(messageId) || [];
  for (const userId of memberIds(conversationId)) {
    emitTo([userId], 'reaction', { conversationId, messageId, reactions: viewOf(userId) });
  }
  return viewOf(viewerId);
}

router.post('/:id/messages/:messageId/reactions', (req, res) => {
  const target = reactionTarget(req, res);
  if (!target) return;
  // 白名单：客户端传什么就存什么的话，「表情」里能塞进一整段文本甚至 HTML。
  const emoji = normalizeEmoji(req.body?.emoji);
  if (!emoji) return res.status(400).json({ error: '不支持的表情' });

  addReaction(target.id, req.user.id, emoji);    // 已经点过就什么也不发生，不是错误
  res.json({ messageId: target.id, reactions: publishReactions(target.conversation_id, target.id, req.user.id) });
});

router.delete('/:id/messages/:messageId/reactions', (req, res) => {
  const target = reactionTarget(req, res);
  if (!target) return;
  // 表情走查询串而不是请求体：DELETE 带 body 在中间层里不一定活得下来。
  const emoji = normalizeEmoji(req.query.emoji);
  if (!emoji) return res.status(400).json({ error: '不支持的表情' });

  removeReaction(target.id, req.user.id, emoji); // 没点过就删 0 行，同样不是错误
  res.json({ messageId: target.id, reactions: publishReactions(target.conversation_id, target.id, req.user.id) });
});
