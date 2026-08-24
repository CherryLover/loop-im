// 已经跑起来的库要能平滑升级到「Web Push 订阅」。
//
// push_subscriptions 整张表都是新的，而且**故意不放进 schema.sql**：
// CREATE TABLE IF NOT EXISTS 对已经存在的库什么也不做，只写进 schema.sql 的话
// 新库有、老库永远没有。所以建表和两个索引全部走 db.js 的 MIGRATIONS，
// column 传 null 那一档（幂等由 DDL 自带的 IF NOT EXISTS 保证）。
//
// 这里要验的就是这条约定真的成立：老库补得上、新库建得出、跑两遍不炸。
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

/** 升级后的快照：表在不在、两个索引在不在、老数据还剩多少。 */
const SNAPSHOT = `
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  const indexes = db.all("PRAGMA index_list(push_subscriptions)").map((r) => ({ name: r.name, unique: r.unique }));
  const columns = db.all('PRAGMA table_info(push_subscriptions)').map((c) => c.name);
  const notNull = db.all('PRAGMA table_info(push_subscriptions)').filter((c) => c.notnull).map((c) => c.name);
  const subs = db.all('SELECT id, user_id, endpoint FROM push_subscriptions ORDER BY created_at, rowid');
  const users = db.all('SELECT id, name FROM users ORDER BY created_at, rowid');
  const messages = db.all('SELECT id, body FROM messages ORDER BY created_at, rowid');
  process.stdout.write(JSON.stringify({ tables, indexes, columns, notNull, subs, users, messages }));
`;

const indexNamed = (snapshot, name) => snapshot.indexes.find((i) => i.name === name);

const LEGACY_TS = 1_700_000_000_000;

before(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  legacyDir = mkdtempSync(join(tmpdir(), 'loop-im-legacy-push-'));
  const legacy = new DatabaseSync(join(legacyDir, 'loop.db'));
  // 升级前的库：连 push_subscriptions 都还没有，但已经有真实数据了。
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

describe('push_subscriptions 的库迁移', () => {
  it('老库升级后补上整张表，字段一个不少，历史数据一条不丢', () => {
    const snap = inspect(legacyDir, SNAPSHOT);

    assert.ok(snap.tables.includes('push_subscriptions'), '应当补上 push_subscriptions 表');
    assert.deepEqual(snap.columns, [
      'id', 'user_id', 'device_id', 'endpoint', 'p256dh', 'auth', 'ua', 'created_at', 'last_ok_at', 'fail_count',
    ]);
    // device_id 是 2C 判「这台设备在不在线」的键，可空就等于这条判定可以静默失效。
    assert.ok(snap.notNull.includes('device_id'), 'device_id 必须 NOT NULL');
    assert.ok(snap.notNull.includes('user_id'));
    assert.ok(snap.notNull.includes('endpoint'));
    assert.ok(snap.notNull.includes('p256dh'));
    assert.ok(snap.notNull.includes('auth'));
    // ua / last_ok_at 是可空的：老设备回填不了，别拿 NOT NULL 把自己框死。
    assert.equal(snap.notNull.includes('ua'), false, 'ua 应当可空');
    assert.equal(snap.notNull.includes('last_ok_at'), false, 'last_ok_at 应当可空');

    assert.equal(snap.messages.length, 2, '升级不能丢数据');
    assert.deepEqual(snap.users.map((u) => u.id), ['u_old']);
    assert.deepEqual(snap.subs, [], '老库没有订阅，留空即可，没有可回填的东西');
  });

  it('两个索引都真的建出来了，而且 endpoint 那个是唯一索引', () => {
    const snap = inspect(legacyDir, SNAPSHOT);
    // endpoint 唯一是安全边界（同一台设备换人登录不能留下两行），不是去重优化，
    // 所以这里验的是 unique = 1，不是「有个叫这名字的索引」。
    assert.equal(indexNamed(snap, 'idx_push_subs_endpoint')?.unique, 1, 'endpoint 必须是唯一索引');
    assert.equal(indexNamed(snap, 'idx_push_subs_user')?.unique, 0, 'user_id 是查询索引，不能是唯一的');
  });

  it('再启动一次不会重复建表/建索引、也不会报错（迁移是幂等的）', () => {
    const snap = inspect(legacyDir, SNAPSHOT);
    assert.equal(snap.indexes.filter((i) => i.name === 'idx_push_subs_endpoint').length, 1);
    assert.equal(snap.indexes.filter((i) => i.name === 'idx_push_subs_user').length, 1);
    assert.equal(snap.messages.length, 2, '第二次启动同样不该动数据');
  });

  it('升级完的老库可以正常写订阅，同一个 endpoint 的第二行被唯一索引挡住', () => {
    const out = inspect(legacyDir, `
      db.run("INSERT INTO push_subscriptions (id, user_id, device_id, endpoint, p256dh, auth, created_at, fail_count)"
             + " VALUES ('ps_1', 'u_old', 'dev-1', 'https://web.push.apple.com/aaa', 'k', 'a', 1700000009999, 0)");
      let duplicate = null;
      try {
        db.run("INSERT INTO push_subscriptions (id, user_id, device_id, endpoint, p256dh, auth, created_at, fail_count)"
               + " VALUES ('ps_2', 'u_other', 'dev-2', 'https://web.push.apple.com/aaa', 'k', 'a', 1700000010000, 0)");
      } catch (err) { duplicate = err.message; }
      const rows = db.all('SELECT id, user_id, endpoint, fail_count FROM push_subscriptions');
      process.stdout.write(JSON.stringify({ duplicate, rows }));
    `);
    assert.equal(out.rows.length, 1, '同一个 endpoint 的第二行必须插不进去');
    assert.equal(out.rows[0].user_id, 'u_old');
    assert.equal(out.rows[0].fail_count, 0, 'fail_count 的默认值应当是 0');
    assert.match(out.duplicate || '', /UNIQUE|constraint/i);
  });

  it('订阅表没有外键：删掉用户那一行，订阅仍然留着（清理必须是显式的）', () => {
    // 这是刻意的设计（见 db.js 里那段注释）：账号生命周期上的清理写在
    // routes/users.js 的停用路径里，看得见、测得到，不靠 ON DELETE 悄悄发生。
    const out = inspect(legacyDir, `
      db.run("DELETE FROM users WHERE id = 'u_old'");
      const left = db.all('SELECT id FROM push_subscriptions').length;
      process.stdout.write(JSON.stringify({ left }));
    `);
    assert.equal(out.left, 1, '外键级联要是真存在，这里就会变成 0——那样清理就成了看不见的行为');
  });
});

describe('全新的库', () => {
  it('第一次启动就把表和两个索引都建好，订阅为空', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'loop-im-fresh-push-'));
    const snap = inspect(fresh, SNAPSHOT);
    assert.ok(snap.tables.includes('push_subscriptions'));
    assert.equal(indexNamed(snap, 'idx_push_subs_endpoint')?.unique, 1);
    assert.ok(indexNamed(snap, 'idx_push_subs_user'));
    assert.deepEqual(snap.subs, []);
  });
});
