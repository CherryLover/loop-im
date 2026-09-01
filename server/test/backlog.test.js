// 群聊补课的纯逻辑面（src/hapi/backlog.js）：批次怎么切、日期怎么标、附件怎么占位、
// 水位怎么推。走完整 HTTP 的行为面在 agent-turns.test.js 的「群聊补课」一节。
// 不需要假 hub：这层只读写本地库，直接插数据最直白。
import './helpers.js';                                     // 先把 DATA_DIR 指到临时目录
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, uid, now } from '../src/db.js';
import { buildGroupBacklog, advanceWatermark, stripAttachments } from '../src/hapi/backlog.js';

process.env.HAPI_TZ = 'Asia/Shanghai';

const CONVO = 'c_backlog';
let seq = 0;
function insertMessage({ sender, body, at = now(), kind = 'user', convo = CONVO }) {
  const id = `m_bl_${seq++}`;
  run('INSERT INTO messages (id, conversation_id, sender_id, body, mentions, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, convo, sender, body, '[]', kind, at);
  return id;
}

before(() => {
  const ts = now();
  for (const [id, name, role] of [['u_h', '何伟', 'member'], ['ai-claude', 'Claude-Code', 'ai'], ['ai-codex', 'Codex', 'ai']]) {
    run('INSERT INTO users (id, name, email, role, created_at) VALUES (?, ?, ?, ?, ?)', id, name, `${id}@t.local`, role, ts);
  }
  run("INSERT INTO conversations (id, type, created_at) VALUES (?, 'group', ?)", CONVO, ts);
  for (const u of ['u_h', 'ai-claude']) {
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, 0)', CONVO, u);
  }
  run('INSERT INTO hapi_sessions (agent_key, conversation_id, session_id, updated_at) VALUES (?, ?, ?, ?)',
    'claude', CONVO, 's_x', ts);
});

describe('批次的切法', () => {
  it('水位之后、触发为止；自己的不带、系统提示不带、其他 AI 的带；发送成功前水位不动', () => {
    const a = insertMessage({ sender: 'u_h', body: '早' });
    insertMessage({ sender: 'ai-claude', body: '我自己说过的' });
    insertMessage({ sender: 'u_h', body: '何伟加入了群聊', kind: 'system' });
    const c = insertMessage({ sender: 'ai-codex', body: '同事 AI 插话' });
    const trig = insertMessage({ sender: 'u_h', body: '@Claude-Code 看看' });

    const batch = buildGroupBacklog({ agentKey: 'claude', agentUserId: 'ai-claude', conversationId: CONVO, triggerMessageId: trig });
    assert.equal(batch.count, 3, `带上 ${a}/${c}/触发，排掉自己和系统提示`);
    assert.ok(batch.text.includes('何伟：早') && batch.text.includes('Codex：同事 AI 插话'));
    assert.ok(!batch.text.includes('我自己说过的') && !batch.text.includes('加入了群聊'));
    assert.ok(batch.text.endsWith('何伟：@Claude-Code 看看'), '触发消息永远是最后一行');

    // 没推水位（发送失败的情形）：同一批还能再组出来，一条不少
    const again = buildGroupBacklog({ agentKey: 'claude', agentUserId: 'ai-claude', conversationId: CONVO, triggerMessageId: trig });
    assert.equal(again.count, 3, '失败重来，宁可重见不能永久丢');

    advanceWatermark('claude', CONVO, batch.lastRowid);
    const after = buildGroupBacklog({ agentKey: 'claude', agentUserId: 'ai-claude', conversationId: CONVO, triggerMessageId: trig });
    assert.equal(after.count, 0, '推完水位这批就翻篇了');
  });

  it('水位只往前不往后：旧批次的推进拽不回新水位', () => {
    const trig = insertMessage({ sender: 'u_h', body: '@Claude-Code 又来' });
    const batch = buildGroupBacklog({ agentKey: 'claude', agentUserId: 'ai-claude', conversationId: CONVO, triggerMessageId: trig });
    advanceWatermark('claude', CONVO, batch.lastRowid);
    advanceWatermark('claude', CONVO, batch.lastRowid - 10);   // 迟到的旧推进
    const after = buildGroupBacklog({ agentKey: 'claude', agentUserId: 'ai-claude', conversationId: CONVO, triggerMessageId: trig });
    assert.equal(after.count, 0);
  });

  it('只算进群之后的：joined_at 之前的消息不在补课范围', () => {
    const convo = 'c_joined';
    run("INSERT INTO conversations (id, type, created_at) VALUES (?, 'group', ?)", convo, now());
    insertMessage({ sender: 'u_h', body: '进群前的旧闻', at: now() - 1000, convo });
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', convo, 'ai-claude', now());
    const trig = insertMessage({ sender: 'u_h', body: '@Claude-Code 你好', at: now() + 1, convo });
    const batch = buildGroupBacklog({ agentKey: 'claude', agentUserId: 'ai-claude', conversationId: convo, triggerMessageId: trig });
    assert.equal(batch.count, 1, '它不在场时的话不算数');
    assert.ok(!batch.text.includes('旧闻'));
  });

  it('首次进老群封顶（HAPI_BACKLOG_CAP）：只补最近的，不灌全部历史', () => {
    const convo = 'c_cap';
    run("INSERT INTO conversations (id, type, created_at) VALUES (?, 'group', ?)", convo, now());
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, 0)', convo, 'ai-claude');
    for (let i = 1; i <= 8; i += 1) insertMessage({ sender: 'u_h', body: `第${i}条`, at: now() - 100 + i, convo });
    const trig = insertMessage({ sender: 'u_h', body: '@Claude-Code 到此为止', convo });
    process.env.HAPI_BACKLOG_CAP = '5';
    try {
      const batch = buildGroupBacklog({ agentKey: 'claude', agentUserId: 'ai-claude', conversationId: convo, triggerMessageId: trig });
      assert.equal(batch.count, 5);
      assert.ok(!batch.text.includes('第4条') && batch.text.includes('第5条'), '掐掉的是最老的那头');
      assert.ok(batch.text.endsWith('到此为止'));
    } finally {
      delete process.env.HAPI_BACKLOG_CAP;
    }
  });
});

describe('时间与日期的标法', () => {
  it('每行 [HH:MM]（北京时间）；跨天插日期行，第一条不是今天也先标日期', () => {
    const convo = 'c_days';
    run("INSERT INTO conversations (id, type, created_at) VALUES (?, 'group', ?)", convo, now());
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, 0)', convo, 'ai-claude');
    // 北京时间 2026-08-30 23:30 与 2026-08-31 00:05（跨了一个午夜）
    insertMessage({ sender: 'u_h', body: '晚安前说一句', at: Date.UTC(2026, 7, 30, 15, 30), convo });
    insertMessage({ sender: 'u_h', body: '过零点了', at: Date.UTC(2026, 7, 30, 16, 5), convo });
    const trig = insertMessage({ sender: 'u_h', body: '@Claude-Code 今天的', convo });
    const batch = buildGroupBacklog({ agentKey: 'claude', agentUserId: 'ai-claude', conversationId: convo, triggerMessageId: trig });
    const lines = batch.text.split('\n');
    assert.equal(lines[0], '—— 8月30日 ——', '第一条不是今天 → 先标哪天的');
    assert.equal(lines[1], '[23:30] 何伟：晚安前说一句');
    assert.equal(lines[2], '—— 8月31日 ——', '跨天处插日期行');
    assert.equal(lines[3], '[00:05] 何伟：过零点了');
    assert.match(lines[4], /^—— \d+月\d+日 ——$/, '回到今天也要标——不标的话「今天」会被误读成 8月31日');
    assert.match(lines[5], /^\[\d{2}:\d{2}\] 何伟：@Claude-Code 今天的$/);
  });
});

describe('附件占位（stripAttachments）', () => {
  it('站内图变 [图片]、站内文件变 [文件：名字]；外链不动', () => {
    assert.equal(stripAttachments('看 ![截图](/uploads/a.png) 和 [报告.pdf](/uploads/b)'), '看 [图片] 和 [文件：报告.pdf]');
    assert.equal(stripAttachments('[](/uploads/c)'), '[文件：未命名]');
    assert.equal(stripAttachments('官网 [首页](https://example.com) 和 ![logo](https://example.com/l.png)'),
      '官网 [首页](https://example.com) 和 ![logo](https://example.com/l.png)');
  });
});
