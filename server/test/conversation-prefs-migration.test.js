// 已经跑起来的库要能平滑升级：conversation_members 加 pinned / muted 走的是 db.js 里的
// MIGRATIONS 表机制（缺什么列补什么列），不是把 schema.sql 改一改就算数 ——
// CREATE TABLE IF NOT EXISTS 对已经存在的表什么也不做。
//
// 这里造一个「升级前」的库：conversation_members 只有最早那三列，里面已经有成员行。
// 然后在子进程里以它为 DATA_DIR 引一次 db.js，看列补上了没有、老数据还在不在。
// 必须用子进程：db.js 在模块顶层就打开了库，同一个进程里换不了 DATA_DIR。
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
  const columns = db.all('PRAGMA table_info(conversation_members)').map((c) => c.name);
  const rows = db.all('SELECT conversation_id, user_id, joined_at, pinned, muted'
    + ' FROM conversation_members ORDER BY joined_at, user_id');
  process.stdout.write(JSON.stringify({ columns, rows }));
`;

before(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  legacyDir = mkdtempSync(join(tmpdir(), 'loop-im-prefs-legacy-'));
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
    -- 升级前的 conversation_members：只有成员关系，没有 pinned、也没有 muted
    CREATE TABLE conversation_members (
      conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    );
    INSERT INTO users (id, name, email, created_at) VALUES ('u_a', '老甲', 'a@test.local', ${ts});
    INSERT INTO users (id, name, email, created_at) VALUES ('u_b', '老乙', 'b@test.local', ${ts});
    INSERT INTO conversations (id, type, title, created_by, created_at)
      VALUES ('c_old', 'group', '升级前就有的群', 'u_a', ${ts});
    INSERT INTO conversation_members VALUES ('c_old', 'u_a', ${ts});
    INSERT INTO conversation_members VALUES ('c_old', 'u_b', ${ts + 1});
  `);
  legacy.close();
});

after(() => {
  // 临时目录留给操作系统清理；这里只是标记一下 legacyDir 用完了。
  legacyDir = null;
});

describe('conversation_members.pinned / muted 的库迁移', () => {
  it('老库升级后补上两列，成员行一条不少，默认都是「没置顶、没免打扰」', () => {
    const { columns, rows } = inspect(legacyDir, COLUMNS_AND_ROWS);

    assert.ok(columns.includes('pinned'), '应当补上 pinned 列');
    assert.ok(columns.includes('muted'), '应当补上 muted 列');

    assert.equal(rows.length, 2, '升级不能丢数据');
    assert.deepEqual(rows.map((r) => r.user_id), ['u_a', 'u_b']);
    assert.equal(rows[0].joined_at, 1_700_000_000_000, '别的列不该被迁移动过');
    // 升级前没有这两个概念，补成 0 与升级前的行为完全一致，不需要回填。
    assert.deepEqual(rows.map((r) => r.pinned), [0, 0]);
    assert.deepEqual(rows.map((r) => r.muted), [0, 0]);
  });

  it('再启动一次不会重复加列、也不会报错（迁移是幂等的）', () => {
    const { columns, rows } = inspect(legacyDir, COLUMNS_AND_ROWS);
    assert.equal(columns.filter((c) => c === 'pinned').length, 1);
    assert.equal(columns.filter((c) => c === 'muted').length, 1);
    assert.equal(rows.length, 2, '第二次启动同样不该动数据');
  });

  it('已经设过置顶的库再升级一次，设置不会被冲掉', () => {
    // 幂等不只是「不报错」：跑过迁移之后写进去的值，下次启动必须还在。
    const out = inspect(legacyDir, `
      db.run("UPDATE conversation_members SET pinned = 1, muted = 1 WHERE user_id = 'u_a'");
      process.stdout.write(JSON.stringify({ ok: true }));
    `);
    assert.equal(out.ok, true);

    const { rows } = inspect(legacyDir, COLUMNS_AND_ROWS);
    const a = rows.find((r) => r.user_id === 'u_a');
    const b = rows.find((r) => r.user_id === 'u_b');
    assert.equal(a.pinned, 1);
    assert.equal(a.muted, 1);
    assert.equal(b.pinned, 0, '一个人的设置不该串到另一个人身上');
    assert.equal(b.muted, 0);
  });
});
