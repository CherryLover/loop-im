// 已经跑起来的库要能平滑升级：messages 加 reply_to 走的是 db.js 里的 MIGRATIONS
// 表机制（缺什么列补什么列），不是把 schema.sql 改一改就算数 —— CREATE TABLE
// IF NOT EXISTS 对已经存在的表什么也不做。
//
// 这里造一个「升级前」的库：messages 只有最早那几列（连 kind 都还没有），
// 里面已经有数据。然后在子进程里以它为 DATA_DIR 引一次 db.js，看列补上了没有、
// 老数据还在不在。必须用子进程：db.js 在模块顶层就打开了库，同一个进程里换不了 DATA_DIR。
import './helpers.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = new URL('../src/db.js', import.meta.url).href;

let legacyDir;

/** 在 dir 上引一次 db.js（跑完全部迁移），然后执行 body 并把结果 JSON 打回来。 */
const inspect = (dir, body) => JSON.parse(execFileSync(
  process.execPath,
  ['--input-type=module', '-e', `import('${DB_URL}').then((db) => { ${body} });`],
  { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' },
));

const COLUMNS_AND_ROWS = `
  const columns = db.all('PRAGMA table_info(messages)').map((c) => c.name);
  const rows = db.all('SELECT id, body, mentions, reply_to FROM messages ORDER BY created_at, rowid');
  process.stdout.write(JSON.stringify({ columns, rows }));
`;

before(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  legacyDir = mkdtempSync(join(tmpdir(), 'loop-im-legacy-'));
  const legacy = new DatabaseSync(join(legacyDir, 'loop.db'));
  const ts = 1_700_000_000_000;
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      dept TEXT NOT NULL DEFAULT '成员', role TEXT NOT NULL DEFAULT 'member',
      password_hash TEXT, avatar_url TEXT, last_seen_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT, created_by TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE conversation_members (
      conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );
    -- 升级前的 messages：没有 kind、更没有 reply_to
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    );
    INSERT INTO users (id, name, email, created_at) VALUES ('u_old', '老用户', 'old@test.local', ${ts});
    INSERT INTO conversations (id, type, title, created_by, created_at)
      VALUES ('c_old', 'group', '升级前就有的群', 'u_old', ${ts});
    INSERT INTO conversation_members VALUES ('c_old', 'u_old', ${ts});
    INSERT INTO messages VALUES ('m_old_1', 'c_old', 'u_old', '升级前的第一条', '[]', ${ts});
    INSERT INTO messages VALUES ('m_old_2', 'c_old', 'u_old', '升级前的第二条 @全员', '["all"]', ${ts + 1});
  `);
  legacy.close();
});

after(() => {
  // 临时目录留给操作系统清理；这里只是标记一下 legacyDir 用完了。
  legacyDir = null;
});

describe('messages.reply_to 的库迁移', () => {
  it('老库升级后补上 reply_to，历史消息一条不少、正文不变、默认没有引用', () => {
    const dir = legacyDir;
    const { columns, rows } = inspect(dir, COLUMNS_AND_ROWS);

    assert.ok(columns.includes('reply_to'), '应当补上 reply_to 列');
    // 同一套机制补的另一列也顺带确认一下，说明迁移链是整条跑通的
    // （ai_visible 已随 Aria 清除不再补列，老库里已有的留在原地不再读写）
    assert.ok(columns.includes('kind'));
    assert.ok(!columns.includes('ai_visible'), 'ai_visible 不该再被迁移补出来');

    assert.equal(rows.length, 2, '升级不能丢数据');
    assert.deepEqual(rows.map((r) => r.id), ['m_old_1', 'm_old_2']);
    assert.equal(rows[0].body, '升级前的第一条');
    assert.equal(rows[1].mentions, '["all"]', '别的列不该被迁移动过');
    assert.equal(rows[0].reply_to, null, '历史消息没有引用，留空即可，不需要回填');
  });

  it('再启动一次不会重复加列、也不会报错（迁移是幂等的）', () => {
    const dir = legacyDir;
    const { columns, rows } = inspect(dir, COLUMNS_AND_ROWS);
    assert.equal(columns.filter((c) => c === 'reply_to').length, 1);
    assert.equal(rows.length, 2, '第二次启动同样不该动数据');
  });

  it('升级完的老库可以正常写入并读回引用', () => {
    const dir = legacyDir;
    const out = inspect(dir, `
      db.run("INSERT INTO messages (id, conversation_id, sender_id, body, mentions, reply_to, created_at)"
        + " VALUES ('m_new', 'c_old', 'u_old', '升级后的新消息', '[]', 'm_old_1', 1700000009999)");
      const row = db.get("SELECT reply_to FROM messages WHERE id = 'm_new'");
      const quoted = db.get("SELECT body FROM messages WHERE id = ?", row.reply_to);
      process.stdout.write(JSON.stringify({ replyTo: row.reply_to, quotedBody: quoted.body }));
    `);
    assert.equal(out.replyTo, 'm_old_1');
    assert.equal(out.quotedBody, '升级前的第一条', '老消息能被新消息引用');
  });
});
