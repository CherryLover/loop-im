import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachmentKeysIn } from './attachments.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(here, '..', 'data');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');

mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'loop.db'));
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

// 老库升级：CREATE TABLE IF NOT EXISTS 补不上新增的列，这里缺什么补什么，启动即生效。
const MIGRATIONS = [
  // messages.ai_visible：历史消息按当时的行为默认可见，不改动已有数据。
  ['messages', 'ai_visible', 'ALTER TABLE messages ADD COLUMN ai_visible INTEGER NOT NULL DEFAULT 1'],
  // users.auth_version：改密码时 +1，让之前签发的 token 全部作废。
  ['users', 'auth_version', 'ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1'],
  // messages.kind：系统提示（谁加入/退出群、群名改了）与普通消息分开渲染。
  ['messages', 'kind', "ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'"],
  // messages.reply_to：引用回复指向的原消息 id。可空，历史消息一律为 NULL（没有引用），
  // 所以不需要回填。故意不加外键：原消息被删掉之后这一列要能留着，界面才能显示
  // 「消息已不可用」；加了 ON DELETE 之后要么写不进去、要么被悄悄置空，都不是想要的。
  ['messages', 'reply_to', 'ALTER TABLE messages ADD COLUMN reply_to TEXT'],
  // conversation_members.pinned / muted：置顶与免打扰是「每个用户对每个会话」的个人偏好，
  // 所以挂在成员行上而不是 conversations 上 —— 挂到会话上会变成全局属性，A 一置顶 B 也跟着变。
  // 老库里已有的成员行按「没置顶、没免打扰」补齐，行为与升级前完全一致，不需要回填。
  ['conversation_members', 'pinned', 'ALTER TABLE conversation_members ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0'],
  ['conversation_members', 'muted', 'ALTER TABLE conversation_members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0'],
  // message_reactions 的唯一约束：同一个人对同一条消息的同一个表情只能有一行，
  // 再点一次是取消而不是加一行。这是索引不是列，所以 column 传 null（见下面的循环）：
  // 幂等由 DDL 自带的 IF NOT EXISTS 保证。约束不写进 schema.sql 的建表语句，
  // 是因为 CREATE TABLE IF NOT EXISTS 对已经建好的表什么也不做——那样老库补不上它。
  [null, null, `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reactions_unique
                ON message_reactions(message_id, user_id, emoji)`],
  // users.disabled_at：账号被停用的时刻，NULL 表示正常。停用不是删除，users 那一行、
  // 他发过的消息、群成员身份全部原样留着，只是不能再登录、也不能再用旧凭据。
  // 存时间戳而不是 0/1：出了事要能答「什么时候停的」，而这一列本来就要写一次。
  // 历史账号一律为 NULL（正常），所以不需要回填。
  ['users', 'disabled_at', 'ALTER TABLE users ADD COLUMN disabled_at INTEGER'],
  // attachment_refs 的索引。表本身在 schema.sql（CREATE TABLE IF NOT EXISTS 对新老库都补得上），
  // 索引照 message_reactions 的先例放这里。
  // 唯一索引 (key, message_id)：同一条消息里把同一张图贴两次也只记一行，回填因此天然幂等。
  [null, null, `CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_refs_unique
                ON attachment_refs(key, message_id)`],
  // 鉴权的热路径是「这个 key 出现在哪些会话里」，按 key 建索引。
  [null, null, 'CREATE INDEX IF NOT EXISTS idx_attachment_refs_key ON attachment_refs(key)'],
  // 回源时要按 url 反查 attachments 那一行（判断归属、判断是不是孤儿）。
  [null, null, 'CREATE INDEX IF NOT EXISTS idx_attachments_url ON attachments(url)'],
];
for (const [table, column, ddl] of MIGRATIONS) {
  // column 为 null：这条迁移不是补列（索引、新表之类），DDL 自己保证幂等，直接跑。
  if (!column) {
    db.exec(ddl);
    continue;
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) db.exec(ddl);
}

/**
 * 一次性数据回填：把历史消息正文里已经贴出去的附件补进 attachment_refs。
 *
 * 为什么必须回填：附件下载从这一版起要校验「你是不是该附件所在会话的成员」，
 * 而这条关联在改造之前根本没有被记录过 —— 唯一的线索就是消息正文里那个 Markdown 链接。
 * 不回填的话，升级后全部历史图片都会掉进「查无关联」的降级分支，安全性和可用性都更差。
 *
 * 只扫一次：加列型迁移能靠 PRAGMA table_info 判断做没做过，数据回填不能，
 * 所以用 schema_meta 记一个标记位。就算标记位丢了重跑也无害 ——
 * INSERT OR IGNORE 撞上 (key, message_id) 唯一索引，重复行进不来。
 *
 * 已知边界：这里假设 messages.body 是明文。今天确实如此（secret-box 只加密 ai_settings.api_key，
 * routes/search.js 的注释也记着同一条假设）。哪天正文改成落库加密，这段和 attachment-access.js
 * 里那条 instr() 兜底查询都要跟着改成先 decrypt 再匹配。
 */
const BACKFILL_KEY = 'attachment_refs_backfilled_v1';
function backfillAttachmentRefs() {
  if (db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(BACKFILL_KEY)) return 0;
  const rows = db.prepare(
    `SELECT id, conversation_id, body, created_at FROM messages WHERE body LIKE '%/uploads/%'`,
  ).all();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO attachment_refs (key, conversation_id, message_id, created_at) VALUES (?, ?, ?, ?)',
  );
  let n = 0;
  for (const row of rows) {
    for (const key of attachmentKeysIn(row.body)) {
      insert.run(key, row.conversation_id, row.id, row.created_at);
      n += 1;
    }
  }
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)')
    .run(BACKFILL_KEY, String(n), Date.now());
  return n;
}
backfillAttachmentRefs();

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export const now = () => Date.now();
export const uid = (prefix) => `${prefix}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
