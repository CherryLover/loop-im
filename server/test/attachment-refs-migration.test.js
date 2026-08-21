/**
 * 「某个对象属于哪个会话」这条关联的库迁移。
 *
 * 附件下载鉴权要查 attachment_refs，可这张表在改造之前根本不存在 ——
 * 历史附件唯一的线索是消息正文里那个 `![名字](/uploads/<key>)` 的 Markdown 链接。
 * 所以迁移有两半：
 *   1. 建表 + 建索引（schema.sql 的 CREATE TABLE IF NOT EXISTS 与 db.js 的 MIGRATIONS）；
 *   2. 一次性回填：扫历史消息正文，把已经贴出去的附件补进 attachment_refs。
 *
 * 第 2 半没法靠 PRAGMA table_info 判断做没做过（它不是加列），所以用 schema_meta 记标记位。
 * 下面把「回填对不对」「重启一次会不会重复回填」「标记位丢了重跑会不会写重」全验一遍。
 *
 * 必须用子进程：db.js 在模块顶层就打开了库，同一个进程里换不了 DATA_DIR。
 */
import './helpers.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = new URL('../src/db.js', import.meta.url).href;

let legacyDir;

const inspect = (dir, body) => JSON.parse(execFileSync(
  process.execPath,
  ['--input-type=module', '-e', `import('${DB_URL}').then((db) => { ${body} });`],
  { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' },
));

const SNAPSHOT = `
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  const indexes = db.all("PRAGMA index_list(attachment_refs)").map((r) => ({ name: r.name, unique: r.unique }));
  const columns = db.all('PRAGMA table_info(attachment_refs)').map((c) => c.name);
  const refs = db.all('SELECT key, conversation_id, message_id FROM attachment_refs ORDER BY key, message_id');
  const messages = db.all('SELECT id, body FROM messages ORDER BY created_at, rowid');
  const marker = db.get("SELECT value FROM schema_meta WHERE key = 'attachment_refs_backfilled_v1'");
  process.stdout.write(JSON.stringify({ tables, indexes, columns, refs, messages, marker }));
`;

const LEGACY_TS = 1_700_000_000_000;

before(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  legacyDir = mkdtempSync(join(tmpdir(), 'loop-im-legacy-attach-'));
  const legacy = new DatabaseSync(join(legacyDir, 'loop.db'));
  // 升级前的库：有 attachments 表，但没有任何「附件属于哪个会话」的记录。
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
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, filename TEXT NOT NULL, url TEXT NOT NULL,
      mime TEXT, bytes INTEGER, created_at INTEGER NOT NULL
    );
    INSERT INTO users (id, name, email, avatar_url, created_at)
      VALUES ('u_old', '老王', 'old@test.local', '/uploads/avatar-old.png', ${LEGACY_TS});
    INSERT INTO conversations (id, type, title, created_by, created_at)
      VALUES ('c_a', 'group', '升级前就有的 A 群', 'u_old', ${LEGACY_TS});
    INSERT INTO conversations (id, type, title, created_by, created_at)
      VALUES ('c_b', 'group', '升级前就有的 B 群', 'u_old', ${LEGACY_TS});
    INSERT INTO conversation_members VALUES ('c_a', 'u_old', ${LEGACY_TS});
    INSERT INTO conversation_members VALUES ('c_b', 'u_old', ${LEGACY_TS});

    -- 一张图片：A 群
    INSERT INTO messages VALUES ('m1', 'c_a', 'u_old', '![发版流程](/uploads/pic-a.png)', '[]', ${LEGACY_TS});
    -- 一个文件：B 群
    INSERT INTO messages VALUES ('m2', 'c_b', 'u_old', '清单在这里 [发版清单.pdf](/uploads/doc-b.bin)', '[]', ${LEGACY_TS + 1});
    -- 一条消息里两个附件
    INSERT INTO messages VALUES ('m3', 'c_a', 'u_old', '![一](/uploads/x1.png) 和 ![二](/uploads/x2.png)', '[]', ${LEGACY_TS + 2});
    -- 同一条消息里同一个附件贴了两次：只该记一行
    INSERT INTO messages VALUES ('m4', 'c_b', 'u_old', '![同](/uploads/dup.png) ![同](/uploads/dup.png)', '[]', ${LEGACY_TS + 3});
    -- 不带附件的普通消息：一条 ref 都不该产生
    INSERT INTO messages VALUES ('m5', 'c_a', 'u_old', '排期改到下周二', '[]', ${LEGACY_TS + 4});

    INSERT INTO attachments VALUES ('a1', 'u_old', '发版流程.png', '/uploads/pic-a.png', 'image/png', 100, ${LEGACY_TS});
    -- 传了但从来没发出去的那一个：回填之后仍然没有 ref，这是对的
    INSERT INTO attachments VALUES ('a9', 'u_old', '没发出去.png', '/uploads/never-sent.png', 'image/png', 100, ${LEGACY_TS});
  `);
  legacy.close();
});

describe('attachment_refs 的库迁移', () => {
  it('老库升级后补上表、唯一索引，历史消息一条不少', () => {
    const snap = inspect(legacyDir, SNAPSHOT);
    assert.ok(snap.tables.includes('attachment_refs'), '应当补上 attachment_refs 表');
    assert.ok(snap.tables.includes('schema_meta'), '应当补上迁移标记表');
    assert.deepEqual(snap.columns, ['key', 'conversation_id', 'message_id', 'created_at']);
    assert.equal(
      snap.indexes.find((i) => i.name === 'idx_attachment_refs_unique')?.unique, 1,
      '唯一索引必须真的建出来：回填的幂等性全靠它',
    );
    assert.equal(snap.messages.length, 5, '升级不能丢数据');
  });

  it('回填把历史消息里已经贴出去的附件全挂上了正确的会话', () => {
    const { refs } = inspect(legacyDir, SNAPSHOT);
    assert.deepEqual(refs, [
      { key: 'doc-b.bin', conversation_id: 'c_b', message_id: 'm2' },
      { key: 'dup.png', conversation_id: 'c_b', message_id: 'm4' },
      { key: 'pic-a.png', conversation_id: 'c_a', message_id: 'm1' },
      { key: 'x1.png', conversation_id: 'c_a', message_id: 'm3' },
      { key: 'x2.png', conversation_id: 'c_a', message_id: 'm3' },
    ]);
  });

  it('同一条消息里贴两次同一个附件只记一行', () => {
    const { refs } = inspect(legacyDir, SNAPSHOT);
    assert.equal(refs.filter((r) => r.key === 'dup.png').length, 1);
  });

  it('传了但没发出去的对象不会凭空多出一条 ref', () => {
    const { refs } = inspect(legacyDir, SNAPSHOT);
    assert.equal(refs.some((r) => r.key === 'never-sent.png'), false);
  });

  it('头像不会被回填成某个会话的附件（它压根没出现在消息正文里）', () => {
    const { refs } = inspect(legacyDir, SNAPSHOT);
    assert.equal(refs.some((r) => r.key === 'avatar-old.png'), false);
  });

  it('再启动一次不会重复回填，也不会报错（迁移是幂等的）', () => {
    const before = inspect(legacyDir, SNAPSHOT);
    const after = inspect(legacyDir, SNAPSHOT);
    assert.deepEqual(after.refs, before.refs);
    assert.equal(after.indexes.filter((i) => i.name === 'idx_attachment_refs_unique').length, 1);
    assert.equal(after.messages.length, 5);
    assert.ok(after.marker, '标记位应当留在 schema_meta 里');
  });

  it('标记位被人抹掉、重跑回填，靠唯一索引照样写不出重复行', () => {
    const out = inspect(legacyDir, `
      db.run("DELETE FROM schema_meta WHERE key = 'attachment_refs_backfilled_v1'");
      process.stdout.write(JSON.stringify({ ok: 1 }));
    `);
    assert.equal(out.ok, 1);
    const snap = inspect(legacyDir, SNAPSHOT);        // 这一次启动会再回填一遍
    assert.equal(snap.refs.length, 5, '重跑回填不该多出任何一行');
  });

  it('升级完的老库上，删掉消息会把它的 ref 一起级联清掉', () => {
    const out = inspect(legacyDir, `
      db.run("DELETE FROM messages WHERE id = 'm3'");
      const left = db.all("SELECT key FROM attachment_refs ORDER BY key").map((r) => r.key);
      process.stdout.write(JSON.stringify({ left }));
    `);
    // x1/x2 跟着 m3 一起走，孤儿清理才有机会把这两个对象真正回收掉。
    assert.deepEqual(out.left, ['doc-b.bin', 'dup.png', 'pic-a.png']);
  });
});

describe('全新的库', () => {
  it('第一次启动就把表、索引、标记位都建好，refs 为空', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'loop-im-fresh-attach-'));
    const snap = inspect(fresh, SNAPSHOT);
    assert.ok(snap.tables.includes('attachment_refs'));
    assert.deepEqual(snap.refs, []);
    assert.equal(snap.marker?.value, '0', '没有历史消息可回填，记 0');
  });
});
