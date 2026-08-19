import { startServer, waitFor } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chenToken, chen, zhou, release, dm;

const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const aiRepliesIn = async (id, token) => (await messagesOf(id, token)).filter((m) => m.isAI).length;

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  chenToken = await api.login(chen.email);
  release = await group(api, adminToken, '产品 · 发版协作', [chen.id, zhou.id]);
  dm = await direct(api, adminToken, chen.id);
});
after(async () => { await api.close(); });

beforeEach(async () => {
  // Reset the AI rules to their defaults between cases.
  await api.put('/api/ai/settings', { silentRead: true, replyAtAll: false, allowDm: true }, adminToken);
});

describe('发消息', () => {
  it('消息按 Markdown 原样存储并回读', async () => {
    const body = '字段沿用 `snake_case`，**别改**\n- 一\n- 二';
    const res = await api.post(`/api/conversations/${dm.id}/messages`, { body }, adminToken);
    assert.equal(res.status, 201);
    assert.equal(res.body.message.body, body);
    assert.equal(res.body.message.senderName, '测试管理员');

    const messages = await messagesOf(dm.id, chenToken);
    assert.equal(messages.at(-1).body, body);
  });

  it('空消息会被拒绝', async () => {
    assert.equal((await api.post(`/api/conversations/${dm.id}/messages`, { body: '   ' }, adminToken)).status, 400);
  });

  it('消息按时间顺序返回', async () => {
    await api.post(`/api/conversations/${dm.id}/messages`, { body: '第一条' }, adminToken);
    await api.post(`/api/conversations/${dm.id}/messages`, { body: '第二条' }, chenToken);
    const times = (await messagesOf(dm.id, adminToken)).map((m) => m.createdAt);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });
});

describe('@ 机制', () => {
  it('@Aria 时必定回复', async () => {
    const before = await aiRepliesIn(release.id, adminToken);
    const res = await api.post(`/api/conversations/${release.id}/messages`, { body: '@Aria 周五能发版吗？' }, adminToken);
    assert.deepEqual(res.body.message.mentions, ['ai']);
    await waitFor(async () => (await aiRepliesIn(release.id, adminToken)) > before);
  });

  it('@某个人不会触发 AI，AI 只是静默读取', async () => {
    const before = await aiRepliesIn(release.id, adminToken);
    const res = await api.post(`/api/conversations/${release.id}/messages`, { body: '@周明 联调时间定了吗' }, adminToken);
    assert.deepEqual(res.body.message.mentions, [zhou.id]);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await aiRepliesIn(release.id, adminToken), before);
  });

  it('@全员 是否触发 AI 由「@全员时 AI 也回复」开关决定', async () => {
    const off = await aiRepliesIn(release.id, adminToken);
    await api.post(`/api/conversations/${release.id}/messages`, { body: '@全员 今天站会推迟' }, adminToken);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await aiRepliesIn(release.id, adminToken), off, '关闭时不应回复');

    await api.put('/api/ai/settings', { replyAtAll: true }, adminToken);
    const on = await aiRepliesIn(release.id, adminToken);
    await api.post(`/api/conversations/${release.id}/messages`, { body: '@全员 补充一下排期' }, adminToken);
    await waitFor(async () => (await aiRepliesIn(release.id, adminToken)) > on, { timeout: 5000 });
  });
});

describe('AI 私聊', () => {
  it('私聊里不用 @ 也会回复', async () => {
    const conversation = await direct(api, chenToken, 'ai');
    await api.post(`/api/conversations/${conversation.id}/messages`, { body: '帮我总结今天的排期结论' }, chenToken);
    const reply = await waitFor(async () => {
      const list = await messagesOf(conversation.id, chenToken);
      return list.find((m) => m.isAI);
    });
    assert.ok(reply.body.length > 0);
  });

  it('管理员关闭 AI 私聊后不能再新建 AI 会话', async () => {
    await api.put('/api/ai/settings', { allowDm: false }, adminToken);
    const zhouToken = await api.login(zhou.email);
    const res = await api.post('/api/conversations/direct', { userId: 'ai' }, zhouToken);
    assert.equal(res.status, 403);
  });
});

describe('群内 AI 上下文摘要', () => {
  it('成员也能读到 AI 掌握的上下文，并包含成员人数', async () => {
    const res = await api.get(`/api/conversations/${release.id}/ai-context`, chenToken);
    assert.equal(res.status, 200);
    assert.match(res.body.line, /相关成员 \d+ 人/);
  });
});
