// Aria 彻底清除（purgeLegacyAi）：老库里它留下的一切都要被删干净，
// 而人类之间的数据一个字节都不能动。2026-08-28 用户拍板不做兼容——
// 线上没人跟它聊过，与其留一个永久停用的幽灵账号，不如当它从未存在过。
import { startServer } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, db, purgeLegacyAi;

before(async () => {
  api = await startServer();
  db = await import('../src/db.js');
  ({ purgeLegacyAi } = db);
});
after(async () => { await api.close(); });

/** 手工捏一个「升级前」形状的最小现场：Aria 用户 + AI 私聊 + 群里的欢迎语。 */
function seedLegacyAria(humanId) {
  const ts = Date.now();
  db.run(`INSERT INTO users (id, name, email, dept, role, password_hash, last_seen_at, created_at)
          VALUES ('ai', 'Aria', 'aria@system', '系统 AI', 'ai', NULL, 0, ?)`, ts);
  // AI 私聊：人类 ↔ Aria
  db.run(`INSERT INTO conversations (id, type, title, created_by, created_at) VALUES ('c_aidm', 'ai', NULL, ?, ?)`, humanId, ts);
  for (const uid of [humanId, 'ai']) {
    db.run(`INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('c_aidm', ?, ?)`, uid, ts);
  }
  db.run(`INSERT INTO messages (id, conversation_id, sender_id, body, mentions, created_at)
          VALUES ('m_dm1', 'c_aidm', ?, '在吗', '[]', ?)`, humanId, ts);
  db.run(`INSERT INTO messages (id, conversation_id, sender_id, body, mentions, created_at)
          VALUES ('m_dm2', 'c_aidm', 'ai', '在的', '[]', ?)`, ts + 1);
  // 人类群，Aria 是成员并发过欢迎语，欢迎语上还有人点过赞
  db.run(`INSERT INTO conversations (id, type, title, created_by, created_at) VALUES ('c_grp', 'group', '老群', ?, ?)`, humanId, ts);
  for (const uid of [humanId, 'ai']) {
    db.run(`INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('c_grp', ?, ?)`, uid, ts);
  }
  db.run(`INSERT INTO messages (id, conversation_id, sender_id, body, mentions, created_at)
          VALUES ('m_hello', 'c_grp', 'ai', '群聊已创建', '[]', ?)`, ts);
  db.run(`INSERT INTO messages (id, conversation_id, sender_id, body, mentions, created_at)
          VALUES ('m_human', 'c_grp', ?, '人类的消息', '[]', ?)`, humanId, ts + 2);
  db.run(`INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES ('m_hello', ?, '👍', ?)`, humanId, ts);
  db.run(`INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES ('m_human', ?, '👍', ?)`, humanId, ts);
  db.run(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_at, updated_at) VALUES ('c_grp', 'ai', ?, ?)`, ts, ts);
}

describe('Aria 彻底清除', () => {
  it('老库里的 Aria 用户、AI 私聊、欢迎语、成员行全被删掉，人类数据原样', async () => {
    const human = await member('清除测试甲');
    seedLegacyAria(human.id);

    assert.equal(purgeLegacyAi(), true, '有东西可删时应返回 true');

    // Aria 的一切都没了
    assert.equal(db.get(`SELECT 1 AS x FROM users WHERE id = 'ai'`), undefined);
    assert.equal(db.get(`SELECT 1 AS x FROM conversations WHERE id = 'c_aidm'`), undefined);
    assert.equal(db.get(`SELECT count(*) AS n FROM messages WHERE conversation_id = 'c_aidm'`).n, 0);
    assert.equal(db.get(`SELECT count(*) AS n FROM messages WHERE sender_id = 'ai'`).n, 0);
    assert.equal(db.get(`SELECT count(*) AS n FROM conversation_members WHERE user_id = 'ai'`).n, 0);
    assert.equal(db.get(`SELECT count(*) AS n FROM conversation_reads WHERE user_id = 'ai'`).n, 0);
    assert.equal(db.get(`SELECT count(*) AS n FROM message_reactions WHERE message_id = 'm_hello'`).n, 0,
      'Aria 消息上的表情回应要跟着消息一起走');

    // 人类的群、消息、回应一个不少
    assert.equal(db.get(`SELECT 1 AS x FROM conversations WHERE id = 'c_grp'`).x, 1);
    assert.equal(db.get(`SELECT body FROM messages WHERE id = 'm_human'`).body, '人类的消息');
    assert.equal(db.get(`SELECT count(*) AS n FROM message_reactions WHERE message_id = 'm_human'`).n, 1);
    assert.equal(db.get(`SELECT 1 AS x FROM users WHERE id = ?`, human.id).x, 1);
  });

  it('幂等：删空之后再跑什么也不做', () => {
    assert.equal(purgeLegacyAi(), false);
  });

  it('ai_settings / ai_profiles 两张表不存在（新库不建，老库被 DROP）', () => {
    for (const t of ['ai_settings', 'ai_profiles']) {
      assert.equal(
        db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t),
        undefined,
        `${t} 不该存在`,
      );
    }
  });
});
