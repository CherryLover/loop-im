import { startServer } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, adminToken, chen, zhou, su, admin;

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  admin = (await api.get('/api/auth/me', adminToken)).body.user;
  [chen, zhou, su] = [
    await member('陈子航', { dept: '后端' }),
    await member('周明', { dept: '前端' }),
    await member('苏晴', { dept: '设计' }),
  ];
});
after(async () => { await api.close(); });

describe('会话列表', () => {
  it('只返回自己参与的会话，并带上最后一条消息预览', async () => {
    const release = await group(api, adminToken, '产品 · 发版协作', [chen.id, zhou.id]);
    // Aria 退役后新群没有欢迎消息，先发一条，让「最后一条消息预览」有东西可断言。
    await api.post(`/api/conversations/${release.id}/messages`, { body: '本周五发版' }, adminToken);
    const res = await api.get('/api/conversations', adminToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.conversations.some((c) => c.id === release.id));

    const outsiderToken = await api.login(su.email);
    const outsiderList = (await api.get('/api/conversations', outsiderToken)).body.conversations;
    assert.ok(!outsiderList.some((c) => c.id === release.id));

    const mine = res.body.conversations.find((c) => c.id === release.id);
    assert.equal(mine.type, 'group');
    assert.equal(mine.title, '产品 · 发版协作');
    assert.ok(mine.lastMessage.preview.includes('本周五发版'));
  });

  it('一对一会话对每一方显示对方的名字', async () => {
    const chenToken = await api.login(chen.email);
    const dm = await direct(api, adminToken, chen.id);

    const forAdmin = (await api.get('/api/conversations', adminToken)).body.conversations;
    const forChen = (await api.get('/api/conversations', chenToken)).body.conversations;
    assert.equal(forAdmin.find((c) => c.id === dm.id).title, chen.name);
    assert.equal(forChen.find((c) => c.id === dm.id).title, admin.name);
  });

  it('群成员按「创建者优先、AI 最后」排序', async () => {
    // Aria 退役后群里默认没有 AI 成员；排序规则保留着，用一个 role='ai' 的账号验证它还在。
    const bot = await member('值班助手', { role: 'ai' });
    const created = await group(api, adminToken, '排序检查', [bot.id, chen.id, zhou.id]);
    const detail = (await api.get(`/api/conversations/${created.id}`, adminToken)).body.conversation;
    assert.equal(detail.members[0].id, admin.id);
    assert.equal(detail.members.at(-1).isAI, true);
    assert.equal(detail.members[0].roleInGroup, '管理员');
    assert.equal(detail.members.at(-1).roleInGroup, '常驻');
  });

  it('不是成员就读不到这个会话', async () => {
    const created = await group(api, adminToken, '闭门会议', [chen.id, zhou.id]);
    const outsider = await api.login(su.email);
    assert.equal((await api.get(`/api/conversations/${created.id}`, outsider)).status, 404);
    assert.equal((await api.get(`/api/conversations/${created.id}/messages`, outsider)).status, 404);
    assert.equal((await api.post(`/api/conversations/${created.id}/messages`, { body: '插一句' }, outsider)).status, 404);
  });
});

describe('建群', () => {
  it('建群只加创建者和选中的人，Aria 退役后不再自动带 AI，也没有欢迎消息', async () => {
    const created = await group(api, adminToken, '设计 · 组件评审', [su.id, zhou.id]);
    assert.equal(created.type, 'group');
    assert.equal(created.members.length, 3);              // 创建者 + 2 人
    assert.ok(!created.members.some((m) => m.isAI));

    const messages = (await api.get(`/api/conversations/${created.id}/messages`, adminToken)).body.messages;
    assert.equal(messages.length, 0);
  });

  // 建群的人数硬限制已经放开（建完还能随时增减成员），现在只要求至少 1 人。
  it('一个成员都不选会被拒绝，1 人和 4 人都可以', async () => {
    const none = await api.post('/api/conversations/group', { title: '空群', memberIds: [] }, adminToken);
    assert.equal(none.status, 400);

    const one = await api.post('/api/conversations/group', { title: '两人组', memberIds: [su.id] }, adminToken);
    assert.equal(one.status, 201);

    const gao = await member('高远', { dept: '测试' });
    const four = await api.post('/api/conversations/group', {
      title: '五人组', memberIds: [su.id, zhou.id, chen.id, gao.id],
    }, adminToken);
    assert.equal(four.status, 201);
  });

  it('不存在的成员会被拒绝', async () => {
    const res = await api.post('/api/conversations/group', { title: '幽灵', memberIds: [su.id, 'u_ghost'] }, adminToken);
    assert.equal(res.status, 400);
  });
});

describe('去聊天', () => {
  it('第一次创建、之后复用同一个一对一会话', async () => {
    const first = await api.post('/api/conversations/direct', { userId: zhou.id }, adminToken);
    const second = await api.post('/api/conversations/direct', { userId: zhou.id }, adminToken);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(first.body.conversation.id, second.body.conversation.id);
    assert.equal(second.body.conversation.type, 'dm');
  });

  it('和 role=ai 的账号聊天开的是 AI 会话', async () => {
    // Aria 退役后库里没有内置 AI；type='ai' 这一档保留给将来的 Agent 用户，这里验证它还通。
    const bot = await member('接待助手', { role: 'ai' });
    const token = await api.login(chen.email);
    const conversation = await direct(api, token, bot.id);
    assert.equal(conversation.type, 'ai');
    assert.equal(conversation.title, '接待助手');
  });

  it('不能和自己聊天', async () => {
    assert.equal((await api.post('/api/conversations/direct', { userId: admin.id }, adminToken)).status, 400);
  });
});
