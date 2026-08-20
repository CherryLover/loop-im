// users 加 disabled_at 走的是 db.js 里的 MIGRATIONS 表机制（缺什么列补什么列），
// 不是改一改 schema.sql 就算数 —— CREATE TABLE IF NOT EXISTS 对已经存在的表什么也不做。
//
// 这里造一个「升级前」的库：users 只有最早那几列（连 auth_version 都还没有），里面已经
// 有账号和聊天记录。然后在子进程里以它为 DATA_DIR 引一次 db.js，看列补上了没有、老数据
// 还在不在。必须用子进程：db.js 在模块顶层就打开了库，同一个进程里换不了 DATA_DIR。
//
// 停用这件事对迁移的要求比别的列更硬：它的全部意义就是「不删数据」，
// 升级过程本身要是把人或消息弄丢了，那还不如不做。
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

const SNAPSHOT = `
  const columns = db.all('PRAGMA table_info(users)').map((c) => c.name);
  const users = db.all('SELECT id, name, email, avatar_url, disabled_at FROM users ORDER BY created_at, rowid');
  const messages = db.all('SELECT id, sender_id, body FROM messages ORDER BY created_at, rowid');
  const members = db.all('SELECT conversation_id, user_id FROM conversation_members');
  process.stdout.write(JSON.stringify({ columns, users, messages, members }));
`;

before(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  legacyDir = mkdtempSync(join(tmpdir(), 'loop-im-legacy-disable-'));
  const legacy = new DatabaseSync(join(legacyDir, 'loop.db'));
  const ts = 1_700_000_000_000;
  legacy.exec(`
    -- 升级前的 users：没有 auth_version，更没有 disabled_at
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
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    );
    INSERT INTO users (id, name, email, avatar_url, created_at)
      VALUES ('u_old', '离职的老王', 'old@test.local', '/uploads/avatar-old.png', ${ts});
    INSERT INTO users (id, name, email, created_at)
      VALUES ('u_stay', '还在职的小李', 'stay@test.local', ${ts + 1});
    INSERT INTO conversations (id, type, title, created_by, created_at)
      VALUES ('c_old', 'group', '升级前就有的群', 'u_stay', ${ts});
    INSERT INTO conversation_members VALUES ('c_old', 'u_old', ${ts});
    INSERT INTO conversation_members VALUES ('c_old', 'u_stay', ${ts});
    INSERT INTO messages VALUES ('m_old_1', 'c_old', 'u_old', '升级前老王说的话', '[]', ${ts});
    INSERT INTO messages VALUES ('m_old_2', 'c_old', 'u_stay', '升级前小李说的话', '[]', ${ts + 1});
  `);
  legacy.close();
});

after(() => {
  // 临时目录留给操作系统清理；这里只是标记一下 legacyDir 用完了。
  legacyDir = null;
});

describe('users.disabled_at 的库迁移', () => {
  it('老库升级后补上 disabled_at，已有账号一律算正常（NULL），不需要回填', () => {
    const { columns, users } = inspect(legacyDir, SNAPSHOT);

    assert.ok(columns.includes('disabled_at'), '应当补上 disabled_at 列');
    // 同一套机制补的 auth_version 也顺带确认一下，说明迁移链是整条跑通的
    assert.ok(columns.includes('auth_version'));

    assert.equal(users.length, 2, '升级不能丢账号');
    assert.deepEqual(users.map((u) => u.id), ['u_old', 'u_stay']);
    for (const u of users) assert.equal(u.disabled_at, null, '升级前的账号默认都是正常的');
  });

  it('升级不动别的数据：名字、头像、聊天记录、群成员身份原样都在', () => {
    const { users, messages, members } = inspect(legacyDir, SNAPSHOT);

    assert.equal(users[0].name, '离职的老王');
    assert.equal(users[0].avatar_url, '/uploads/avatar-old.png');
    assert.equal(messages.length, 2, '升级不能丢消息');
    assert.equal(messages[0].body, '升级前老王说的话');
    assert.equal(messages[0].sender_id, 'u_old');
    assert.equal(members.length, 2, '群成员身份也要留着');
  });

  it('再启动一次不会重复加列、也不会报错（迁移是幂等的）', () => {
    const { columns, users, messages } = inspect(legacyDir, SNAPSHOT);
    assert.equal(columns.filter((c) => c === 'disabled_at').length, 1);
    assert.equal(users.length, 2, '第二次启动同样不该动数据');
    assert.equal(messages.length, 2);
  });

  it('升级完的老库可以停用、也可以恢复，历史消息一条不动', () => {
    const out = inspect(legacyDir, `
      db.run("UPDATE users SET disabled_at = 1700000099999 WHERE id = 'u_old'");
      const off = db.get("SELECT disabled_at FROM users WHERE id = 'u_old'").disabled_at;
      const keptWhileOff = db.get("SELECT count(*) AS n FROM messages WHERE sender_id = 'u_old'").n;
      db.run("UPDATE users SET disabled_at = NULL WHERE id = 'u_old'");
      const on = db.get("SELECT disabled_at FROM users WHERE id = 'u_old'").disabled_at;
      process.stdout.write(JSON.stringify({ off, keptWhileOff, on }));
    `);
    assert.equal(out.off, 1_700_000_099_999);
    assert.equal(out.keptWhileOff, 1, '停用不删消息');
    assert.equal(out.on, null, '恢复就是把标记抹掉');
  });
});
