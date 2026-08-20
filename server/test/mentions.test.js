// @ 解析：名字互为前缀、正文里出现邮箱时不能误标提及。
// 误标不只是通知错人 —— parseMentions 的结果会定档进 messages.ai_visible 并决定
// shouldReply，所以一次误匹配等于让 Aria 读到不该读的消息、或者莫名其妙插话。
import { startServer, waitFor } from './helpers.js';
import { group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, db, parseMentions;
let li, liming, zhou, ariadne, room;

const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const aiRepliesIn = async (id, token) => (await messagesOf(id, token)).filter((m) => m.isAI).length;
const aiVisibleOf = (messageId) => db.get('SELECT ai_visible FROM messages WHERE id = ?', messageId).ai_visible;
const sortIds = (ids) => [...ids].sort();

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  ({ parseMentions } = await import('../src/ai.js'));
  db = await import('../src/db.js');

  li = await member('李', { dept: '后端' });
  liming = await member('李明', { dept: '前端' });
  zhou = await member('zhou', { dept: '测试' });
  ariadne = await member('Ariadne', { dept: '设计' });
  room = await group(api, adminToken, '发版协作', [li.id, liming.id, zhou.id, ariadne.id]);
});
after(async () => { await api.close(); });

// ---- 纯函数 -------------------------------------------------------------

const roster = [
  { id: 'ai', name: 'Aria' },
  { id: 'u_li', name: '李' },
  { id: 'u_liming', name: '李明' },
  { id: 'u_zhou', name: 'zhou' },
  { id: 'u_ariadne', name: 'Ariadne' },
  { id: 'u_liming_en', name: 'Li Ming' },
];

describe('@ 解析 · 前缀名', () => {
  it('@李明 只标记李明，不连带标记李', () => {
    assert.deepEqual(parseMentions('@李明 你好', roster), ['u_liming']);
    assert.deepEqual(parseMentions('@李明的接口好了吗', roster), ['u_liming']);
  });

  it('@李 只标记李', () => {
    assert.deepEqual(parseMentions('@李 你好', roster), ['u_li']);
  });

  it('同一条消息里两个前缀名各归各的', () => {
    assert.deepEqual(sortIds(parseMentions('@李 @李明 同步一下', roster)), ['u_li', 'u_liming']);
  });
});

describe('@ 解析 · 邮箱不是提及', () => {
  it('正文里的邮箱地址不会误标成提及', () => {
    assert.deepEqual(parseMentions('发到 zhou@example.com 那边', roster), []);
    assert.deepEqual(parseMentions('邮件发到 aria@system 就行', roster), []);
    assert.deepEqual(parseMentions('li.ming+work@example.com 抄送我', roster), []);
  });

  it('邮箱和真提及可以同时出现，只认真提及', () => {
    assert.deepEqual(parseMentions('@李明 发到 zhou@example.com 那边', roster), ['u_liming']);
  });
});

describe('@ 解析 · 带空格的名字', () => {
  it('原样写和去掉空格写都能命中', () => {
    assert.deepEqual(parseMentions('@Li Ming 看下这个', roster), ['u_liming_en']);
    assert.deepEqual(parseMentions('@LiMing 看下这个', roster), ['u_liming_en']);
  });
});

describe('@ 解析 · Aria', () => {
  it('@Aria / @aria 命中 AI', () => {
    assert.deepEqual(parseMentions('@Aria 看一下', roster), ['ai']);
    assert.deepEqual(parseMentions('@aria 看一下', roster), ['ai']);
  });

  it('群里另有以 Aria 开头的名字时不串味', () => {
    assert.deepEqual(parseMentions('@Ariadne 帮忙出个图', roster), ['u_ariadne']);
    assert.deepEqual(parseMentions('@Aria 帮忙出个图', roster), ['ai']);
    assert.deepEqual(sortIds(parseMentions('@Aria @Ariadne 一起看', roster)), ['ai', 'u_ariadne']);
  });
});

describe('@ 解析 · 全员', () => {
  it('四种写法都还在', () => {
    for (const body of ['@全员 站会推迟', '@所有人 注意', '@everyone heads up', '@all heads up']) {
      assert.deepEqual(parseMentions(body, roster), ['all'], body);
    }
  });

  it('@allow 这种只是以 all 开头的词不算 @全员', () => {
    assert.deepEqual(parseMentions('走 @allowlist 那条路', roster), []);
  });
});

describe('@ 解析 · 大小写与空结果', () => {
  it('大小写不敏感', () => {
    assert.deepEqual(parseMentions('@ARIA 看一下', roster), ['ai']);
    assert.deepEqual(parseMentions('@ariaDNE 出个图', roster), ['u_ariadne']);
    assert.deepEqual(parseMentions('@ALL 注意', roster), ['all']);
    assert.deepEqual(parseMentions('@EVERYONE 注意', roster), ['all']);
  });

  it('没有 @ 或者 @ 的是陌生名字时返回空', () => {
    assert.deepEqual(parseMentions('周五能发版吗？', roster), []);
    assert.deepEqual(parseMentions('@王五 在吗', roster), []);
    assert.deepEqual(parseMentions('', roster), []);
  });
});

// ---- 走真实接口：误匹配不应让 Aria 读到 / 回复 ---------------------------

describe('@ 误匹配不会让 Aria 越权读取或插话', () => {
  it('关掉静默读取后，@Ariadne 既不入 Aria 的上下文也不触发回复', async () => {
    await api.put('/api/ai/settings', { silentRead: false, replyAtAll: false }, adminToken);
    const before = await aiRepliesIn(room.id, adminToken);

    const res = await api.post(`/api/conversations/${room.id}/messages`,
      { body: '@Ariadne 这版发版稿只发给你，别外传' }, adminToken);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.message.mentions, [ariadne.id], '不应连带标记 Aria');
    assert.equal(aiVisibleOf(res.body.message.id), 0, '没被 @ 到的 Aria 不该读到这条');

    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await aiRepliesIn(room.id, adminToken), before, 'Aria 不该插话');

    // 对照组：真的 @Aria 时一切照旧。
    const real = await api.post(`/api/conversations/${room.id}/messages`, { body: '@Aria 帮我看下风险' }, adminToken);
    assert.deepEqual(real.body.message.mentions, ['ai']);
    assert.equal(aiVisibleOf(real.body.message.id), 1);
    await waitFor(async () => (await aiRepliesIn(room.id, adminToken)) > before);
  });

  it('@李明 与正文里的邮箱都不会误标到别人身上', async () => {
    await api.put('/api/ai/settings', { silentRead: false, replyAtAll: false }, adminToken);
    const before = await aiRepliesIn(room.id, adminToken);

    const res = await api.post(`/api/conversations/${room.id}/messages`,
      { body: '@李明 联调时间定了吗，纪要发到 zhou@example.com' }, adminToken);
    assert.deepEqual(res.body.message.mentions, [liming.id], '李 和 zhou 都不该被标记');
    assert.equal(aiVisibleOf(res.body.message.id), 0);

    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await aiRepliesIn(room.id, adminToken), before);

    await api.put('/api/ai/settings', { silentRead: true }, adminToken);
  });
});
