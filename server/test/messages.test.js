import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chenToken, chen, zhou, release, dm;

const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;

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
  it('@某个人：提及被解析并随消息返回', async () => {
    const res = await api.post(`/api/conversations/${release.id}/messages`, { body: '@周明 联调时间定了吗' }, adminToken);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.message.mentions, [zhou.id]);
  });

  it('@全员 解析为 all', async () => {
    const res = await api.post(`/api/conversations/${release.id}/messages`, { body: '@全员 今天站会推迟' }, adminToken);
    assert.deepEqual(res.body.message.mentions, ['all']);
  });

  // Aria 退役后系统里暂时没有任何 AI（hapi Agent 接入前）：
  // 任何消息都不该触发 AI 回复，也不该出现 isAI 的消息。
  it('没有任何消息会触发 AI 回复', async () => {
    await new Promise((r) => setTimeout(r, 400));
    const all = await messagesOf(release.id, adminToken);
    assert.equal(all.filter((m) => m.isAI).length, 0);
  });
});
