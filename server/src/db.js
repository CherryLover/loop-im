import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
];
for (const [table, column, ddl] of MIGRATIONS) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) db.exec(ddl);
}

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export const now = () => Date.now();
export const uid = (prefix) => `${prefix}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
