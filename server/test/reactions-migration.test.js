// 已经跑起来的库要能平滑升级到「消息表情回应」。
//
// 建表本身靠 schema.sql 的 CREATE TABLE IF NOT EXISTS，但唯一约束不行：
// CREATE TABLE IF NOT EXISTS 对已经存在的表什么也不做，约束写在建表语句里的话，
// 一个更早版本建出来的 message_reactions 永远补不上它。所以约束走 db.js 的
// MIGRATIONS（具名唯一索引 + IF NOT EXISTS）。这里两种老库都要验：
// 1. 压根没有 message_reactions 的库；
// 2. 有表、但表上没有唯一约束、而且已经存了重复行的库。
//
// 必须用子进程：db.js 在模块顶层就打开了库，同一个进程里换不了 DATA_DIR。
import './helpers.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = new URL('../src/db.js', import.meta.url).href;

let legacyDir;

/** 在 dir 上引一次 db.js（跑完全部迁移），然后执行 body 并把结果 JSON 打回来。 */
const inspect = (dir, body) => JSON.parse(execFileSync(
  process.execPath,
  ['--input-type=module', '-e', `import('${DB_URL}').then((db) => { ${body} });`],
  { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' },
));

/** 升级后的快照：表在不在、唯一索引在不在、老数据还剩多少。 */
const SNAPSHOT = `
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  const indexes = db.all("PRAGMA index_list(message_reactions)").map((r) => ({ name: r.name, unique: r.unique }));
  const columns = db.all('PRAGMA table_info(message_reactions)').map((c) => c.name);
  const messages = db.all('SELECT id, body FROM messages ORDER BY created_at, rowid');
  const reactions = db.all('SELECT message_id, user_id, emoji FROM message_reactions ORDER BY created_at, rowid');
  process.stdout.write(JSON.stringify({ tables, indexes, columns, messages, reactions }));
`;

/** 迁移建的那条唯一索引（名字见 db.js 的 MIGRATIONS）。 */
const uniqueIndex = (snapshot) => snapshot.indexes.find((i) => i.name === 'idx_message_reactions_unique');

const LEGACY_TS = 1_700_000_000_000;

before(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  legacyDir = mkdtempSync(join(tmpdir(), 'loop-im-legacy-reactions-'));
  const legacy = new DatabaseSync(join(legacyDir, 'loop.db'));
  // 升级前的库：连 message_reactions 都还没有，但已经有真实数据了。
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
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    );
    INSERT INTO users (id, name, email, created_at) VALUES ('u_old', '老用户', 'old@test.local', ${LEGACY_TS});
    INSERT INTO conversations (id, type, title, created_by, created_at)
      VALUES ('c_old', 'group', '升级前就有的群', 'u_old', ${LEGACY_TS});
    INSERT INTO conversation_members VALUES ('c_old', 'u_old', ${LEGACY_TS});
    INSERT INTO messages VALUES ('m_old_1', 'c_old', 'u_old', '升级前的第一条', '[]', ${LEGACY_TS});
    INSERT INTO messages VALUES ('m_old_2', 'c_old', 'u_old', '升级前的第二条', '[]', ${LEGACY_TS + 1});
  `);
  legacy.close();
});

describe('message_reactions 的库迁移', () => {
  it('老库升级后补上表和唯一索引，历史消息一条不少', () => {
    const snap = inspect(legacyDir, SNAPSHOT);

    assert.ok(snap.tables.includes('message_reactions'), '应当补上 message_reactions 表');
    assert.deepEqual(snap.columns, ['message_id', 'user_id', 'emoji', 'created_at']);
    assert.equal(uniqueIndex(snap)?.unique, 1, '唯一约束必须真的建出来，不能只有表');

    assert.equal(snap.messages.length, 2, '升级不能丢数据');
    assert.deepEqual(snap.messages.map((m) => m.id), ['m_old_1', 'm_old_2']);
    assert.equal(snap.messages[0].body, '升级前的第一条');
    assert.deepEqual(snap.reactions, [], '历史消息没有回应，留空即可，不需要回填');
  });

  it('再启动一次不会重复建索引、也不会报错（迁移是幂等的）', () => {
    const snap = inspect(legacyDir, SNAPSHOT);
    assert.equal(snap.indexes.filter((i) => i.name === 'idx_message_reactions_unique').length, 1);
    assert.equal(snap.messages.length, 2, '第二次启动同样不该动数据');
  });

  it('升级完的老库可以正常点回应，重复点被唯一索引挡住', () => {
    const out = inspect(legacyDir, `
      db.run("INSERT INTO message_reactions VALUES ('m_old_1', 'u_old', '👍', 1700000009999)");
      let duplicate = null;
      try {
        db.run("INSERT INTO message_reactions VALUES ('m_old_1', 'u_old', '👍', 1700000010000)");
      } catch (err) { duplicate = err.message; }
      const rows = db.all("SELECT message_id, user_id, emoji FROM message_reactions");
      process.stdout.write(JSON.stringify({ duplicate, rows }));
    `);
    assert.equal(out.rows.length, 1, '重复的那一行必须插不进去');
    assert.equal(out.rows[0].emoji, '👍', '多字节表情原样存回，没有被按字节截断');
    assert.match(out.duplicate || '', /UNIQUE|constraint/i);
  });

  it('删掉消息时，升级后的老库同样会把回应级联清掉', () => {
    const out = inspect(legacyDir, `
      db.run("DELETE FROM messages WHERE id = 'm_old_1'");
      const left = db.get('SELECT count(*) AS n FROM message_reactions').n;
      process.stdout.write(JSON.stringify({ left }));
    `);
    assert.equal(out.left, 0, '外键级联要在老库上一样生效，不留孤儿');
  });
});

describe('表已存在但没有唯一约束的老库', () => {
  it('索引补得上；库里原本就有重复行时启动会明确报错，而不是悄悄跳过', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'loop-im-legacy-dup-'));
    const legacy = new DatabaseSync(join(dir, 'loop.db'));
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
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
      );
      -- 没有唯一约束的老表，而且已经攒下了两行一模一样的回应
      CREATE TABLE message_reactions (
        message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO users (id, name, email, created_at) VALUES ('u_old', '老用户', 'old@test.local', ${LEGACY_TS});
      INSERT INTO messages VALUES ('m_old_1', 'c_old', 'u_old', '老消息', '[]', ${LEGACY_TS});
      INSERT INTO message_reactions VALUES ('m_old_1', 'u_old', '👍', ${LEGACY_TS});
      INSERT INTO message_reactions VALUES ('m_old_1', 'u_old', '👍', ${LEGACY_TS + 1});
    `);
    legacy.close();

    // 这种库启动会失败——这是想要的行为：与其带着重复数据继续跑，不如当场喊出来。
    assert.throws(
      () => inspect(dir, 'process.stdout.write("{}");'),
      // 子进程的报错在 stderr 里，execFileSync 把它挂在 err.stderr 上
      (err) => /UNIQUE|constraint/i.test(`${err.message}\n${err.stderr || ''}`),
      '重复数据上建唯一索引必须报错，不能静默放过',
    );

    // 清掉重复行之后再启动，索引就补上了，剩下那一行还在。
    const cleaned = new DatabaseSync(join(dir, 'loop.db'));
    cleaned.exec('DELETE FROM message_reactions WHERE rowid NOT IN (SELECT min(rowid) FROM message_reactions GROUP BY message_id, user_id, emoji)');
    cleaned.close();

    const snap = inspect(dir, SNAPSHOT);
    assert.equal(uniqueIndex(snap)?.unique, 1, '老表上要能补出唯一约束');
    assert.equal(snap.reactions.length, 1, '剩下那一行不能被迁移弄丢');
  });
});
