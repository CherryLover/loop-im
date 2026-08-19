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
    const res = await api.get('/api/conversations', adminToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.conversations.some((c) => c.id === release.id));

    const outsiderToken = await api.login(su.email);
    const outsiderList = (await api.get('/api/conversations', outsiderToken)).body.conversations;
    assert.ok(!outsiderList.some((c) => c.id === release.id));

    const mine = res.body.conversations.find((c) => c.id === release.id);
    assert.equal(mine.type, 'group');
    assert.equal(mine.title, '产品 · 发版协作');
    assert.ok(mine.lastMessage.preview.length > 0);      // Aria 的建群第一条消息
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
    const created = await group(api, adminToken, '排序检查', [chen.id, zhou.id]);
    const detail = (await api.get(`/api/conversations/${created.id}`, adminToken)).body.conversation;
    assert.equal(detail.members[0].id, admin.id);
    assert.equal(detail.members.at(-1).isAI, true);
    assert.equal(detail.members[0].roleInGroup, '管理员');
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
  it('管理员选 2–3 人建群，AI 默认加入并发第一条消息', async () => {
    const created = await group(api, adminToken, '设计 · 组件评审', [su.id, zhou.id]);
    assert.equal(created.type, 'group');
    assert.equal(created.members.length, 4);              // 创建者 + 2 人 + AI
    assert.ok(created.members.some((m) => m.isAI));

    const messages = (await api.get(`/api/conversations/${created.id}/messages`, adminToken)).body.messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].isAI, true);
  });

  it('人数不在 2–3 之间会被拒绝', async () => {
    const one = await api.post('/api/conversations/group', { title: '太少', memberIds: [su.id] }, adminToken);
    const gao = await member('高远', { dept: '测试' });
    const four = await api.post('/api/conversations/group', {
      title: '太多', memberIds: [su.id, zhou.id, chen.id, gao.id],
    }, adminToken);
    assert.equal(one.status, 400);
    assert.equal(four.status, 400);
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

  it('和 Aria 聊天开的是 AI 会话', async () => {
    const token = await api.login(chen.email);
    const conversation = await direct(api, token, 'ai');
    assert.equal(conversation.type, 'ai');
    assert.equal(conversation.title, 'Aria');
  });

  it('不能和自己聊天', async () => {
    assert.equal((await api.post('/api/conversations/direct', { userId: admin.id }, adminToken)).status, 400);
  });
});
