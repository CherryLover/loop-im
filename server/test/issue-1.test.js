import { startServer, waitFor } from './helpers.js';
import { direct, group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// issue #1：关闭「群聊静默读取上下文」后，AI 不应再学习普通群消息，
// 也不应在重新开启后追溯读取关闭期间的内容。
let api, adminToken, chenToken, zhouToken, chen, zhou, release;

// 关闭期间发出的、只在这条消息里出现过的内容，用来验证是否被偷偷学走。
const SECRET = '独立风险214620需评审';

const setSilentRead = (silentRead) =>
  api.put('/api/ai/settings', { silentRead, replyAtAll: false, allowDm: true }, adminToken);

const profileOf = (userId) => api.get(`/api/ai/profiles/${userId}`, adminToken);
const messagesOf = (id, token) => api.get(`/api/conversations/${id}/messages`, token);
// 学习是响应返回后异步触发的：断言「没有发生」之前先给它一点时间。
const settle = () => new Promise((r) => setTimeout(r, 300));

before(async () => {
  api = await startServer();
  adminToken = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  chenToken = await api.login(chen.email);
  zhouToken = await api.login(zhou.email);
  release = await group(api, adminToken, '产品 · 发版协作', [chen.id, zhou.id]);
});
after(async () => { await api.close(); });

describe('群聊静默读取开关', () => {
  it('开启时：普通群消息照常进入画像', async () => {
    await setSilentRead(true);
    await api.post(`/api/conversations/${release.id}/messages`, { body: '静默开启版本发版风险已确认' }, chenToken);

    const keys = await waitFor(async () => {
      const res = await profileOf(chen.id);
      return res.status === 200 && res.body.profile.keys.length ? res.body.profile.keys : null;
    });
    assert.ok(keys.includes('静默开启版本发版风险已确认'));
  });

  it('关闭时：普通群消息不触发回复、不更新画像、不改时间戳', async () => {
    await setSilentRead(false);
    const before = (await profileOf(chen.id)).body.profile;
    const repliesBefore = (await messagesOf(release.id, adminToken)).body.messages.filter((m) => m.isAI).length;

    await api.post(`/api/conversations/${release.id}/messages`, { body: SECRET }, chenToken);
    await settle();

    const after = (await profileOf(chen.id)).body.profile;
    assert.equal(after.lastActiveAt, before.lastActiveAt, '画像时间戳不应变化');
    assert.deepEqual(after.keys, before.keys, '关闭期间的内容不应进入关键信息点');
    assert.ok(!JSON.stringify(after).includes('214620'), '关闭期间的内容不应出现在画像任何字段');

    const repliesAfter = (await messagesOf(release.id, adminToken)).body.messages.filter((m) => m.isAI).length;
    assert.equal(repliesAfter, repliesBefore, '关闭期间不应产生 AI 回复');
  });

  it('重新开启后：关闭期间的内容不会被追溯学习', async () => {
    await setSilentRead(true);
    const before = (await profileOf(chen.id)).body.profile;

    await api.post(`/api/conversations/${release.id}/messages`, { body: '联调排期改到下周二' }, chenToken);
    const profile = await waitFor(async () => {
      const res = await profileOf(chen.id);
      return res.body.profile.lastActiveAt > before.lastActiveAt ? res.body.profile : null;
    });

    assert.ok(profile.keys.includes('联调排期改到下周二'), '重新开启后的消息应被正常学习');
    assert.ok(!profile.keys.includes(SECRET), '关闭期间的内容不应被追溯学习');
    assert.ok(!JSON.stringify(profile).includes('214620'), '关闭期间的内容不应被追溯学习');
  });

  it('关闭期间的内容不会被后续 @Aria 的回复引用', async () => {
    const before = (await messagesOf(release.id, adminToken)).body.messages.filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${release.id}/messages`, { body: '@Aria 复述一下当前上下文' }, chenToken);

    const reply = await waitFor(async () => {
      const replies = (await messagesOf(release.id, adminToken)).body.messages.filter((m) => m.isAI);
      return replies.length > before ? replies.at(-1) : null;
    });
    assert.ok(!reply.body.includes('214620'), '关闭期间的内容不应出现在回复上下文里');
  });
});

describe('没有 AI 的会话', () => {
  it('成员之间的一对一私聊不会创建 AI 画像', async () => {
    await setSilentRead(true);
    const dm = await direct(api, chenToken, zhou.id);
    assert.equal((await profileOf(zhou.id)).status, 404);

    await api.post(`/api/conversations/${dm.id}/messages`, { body: '私聊里的接口联调排期' }, zhouToken);
    await settle();

    assert.equal((await profileOf(zhou.id)).status, 404, '没有 Aria 在场的私聊不应产生画像');
  });
});
