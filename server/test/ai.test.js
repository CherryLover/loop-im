import { startServer, waitFor } from './helpers.js';
import { group, member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token, ai, chen, zhou, release;

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
  ai = await import('../src/ai.js');
  chen = await member('陈子航', { dept: '后端' });
  zhou = await member('周明', { dept: '前端' });
  release = await group(api, token, '产品 · 发版协作', [chen.id, zhou.id]);
});
after(async () => { await api.close(); });

const roster = [
  { id: 'ai', name: 'Aria' },
  { id: 'u_chen', name: '陈子航' },
  { id: 'u_zhou', name: '周明' },
];

describe('@ 解析', () => {
  it('认得 @Aria、@全员 和具体成员', () => {
    assert.deepEqual(ai.parseMentions('@Aria 看一下', roster), ['ai']);
    assert.deepEqual(ai.parseMentions('@全员 站会推迟', roster), ['all']);
    assert.deepEqual(ai.parseMentions('@所有人 注意', roster), ['all']);
    assert.deepEqual(ai.parseMentions('@陈子航 接口好了吗', roster), ['u_chen']);
  });

  it('一条消息里可以有多个 @', () => {
    const found = ai.parseMentions('@陈子航 @周明 同步一下', roster);
    assert.deepEqual([...found].sort(), ['u_chen', 'u_zhou']);
  });

  it('没有 @ 时返回空', () => {
    assert.deepEqual(ai.parseMentions('周五能发版吗？', roster), []);
    assert.deepEqual(ai.parseMentions('邮件发到 aria@system 就行', roster), []);
  });
});

describe('回复策略', () => {
  const rules = { allow_dm: 1, reply_at_all: 0 };

  it('群聊：被 @ 必回，没被 @ 静默', () => {
    assert.equal(ai.shouldReply({ type: 'group' }, ['ai'], rules), true);
    assert.equal(ai.shouldReply({ type: 'group' }, ['u_chen'], rules), false);
    assert.equal(ai.shouldReply({ type: 'group' }, [], rules), false);
  });

  it('@全员 跟随开关', () => {
    assert.equal(ai.shouldReply({ type: 'group' }, ['all'], rules), false);
    assert.equal(ai.shouldReply({ type: 'group' }, ['all'], { ...rules, reply_at_all: 1 }), true);
  });

  it('AI 私聊总是回复，除非管理员关闭', () => {
    assert.equal(ai.shouldReply({ type: 'ai' }, [], rules), true);
    assert.equal(ai.shouldReply({ type: 'ai' }, [], { ...rules, allow_dm: 0 }), false);
  });

  it('没有 AI 的一对一不会触发回复', () => {
    assert.equal(ai.shouldReply({ type: 'dm' }, [], rules), false);
  });
});

describe('未配置凭据时的降级', () => {
  it('没有 API Key 就用本地模拟回复，并如实说明', async () => {
    assert.equal(ai.isConfigured(), false);
    const reply = await ai.generateReply({ id: release.id, type: 'group' }, chen.id);
    assert.equal(reply.mode, 'stub');
    assert.ok(reply.body.length > 0);

    const test = await api.post('/api/ai/test', {}, token);
    assert.equal(test.body.ok, false);
    assert.match(test.body.message, /未配置凭据/);
  });
});

describe('AI 配置', () => {
  it('可以切换供应商，状态行随之更新', async () => {
    const res = await api.put('/api/ai/settings', { provider: 'grok' }, token);
    assert.equal(res.body.provider, 'grok');
    assert.match(res.body.statusLine, /Grok/);
    await api.put('/api/ai/settings', { provider: 'gpt' }, token);
  });

  it('未知的供应商会被忽略而不是写坏配置', async () => {
    const res = await api.put('/api/ai/settings', { provider: 'definitely-not-a-provider' }, token);
    assert.equal(res.body.provider, 'gpt');
  });

  it('接口不会把 API Key 回传给前端', async () => {
    await api.put('/api/ai/settings', { apiKey: 'test-key-should-never-be-returned' }, token);
    const res = await api.get('/api/ai/settings', token);
    assert.equal(res.body.hasApiKey, true);
    assert.ok(!JSON.stringify(res.body).includes('test-key-should-never-be-returned'));
    await api.put('/api/ai/settings', { apiKey: '' }, token);
  });
});

describe('AI 管理数据', () => {
  it('统计只有「今日被 @ 次数」和「关键信息点」', async () => {
    const res = await api.get('/api/ai/overview', token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stats.map((s) => s.label), ['今日被 @ 次数', '关键信息点']);
  });

  it('被 @ 一次，今日计数就 +1', async () => {
    const before = Number((await api.get('/api/ai/overview', token)).body.stats[0].value);
    await api.post(`/api/conversations/${release.id}/messages`, { body: '@Aria 帮我看下风险' }, token);
    const after = await waitFor(async () => {
      const value = Number((await api.get('/api/ai/overview', token)).body.stats[0].value);
      return value > before ? value : null;
    });
    assert.equal(after, before + 1);
  });

  it('聊过的人才会出现在跟踪列表里', async () => {
    const chenToken = await api.login(chen.email);
    await api.post(`/api/conversations/${release.id}/messages`, {
      body: '我把阻塞点整理了一下：回归测试只留 1 天，接口 2 项未完成',
    }, chenToken);

    const row = await waitFor(async () => {
      const { rows } = (await api.get('/api/ai/overview', token)).body;
      return rows.find((r) => r.userId === chen.id);
    });
    assert.equal(row.name, '陈子航');
    assert.equal(row.scene, '群聊');
    assert.ok(row.keys.includes('回归测试只留 1 天'));
  });

  it('二级页给出推导内容、关键信息点和原始对话', async () => {
    const res = await api.get(`/api/ai/profiles/${chen.id}`, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.profile.name, '陈子航');
    assert.ok(res.body.profile.keys.length > 0);
    assert.ok(res.body.raw.length > 0);
    assert.ok(res.body.profile.keys.every((k) => k.length <= 16), '关键信息点应是短语而不是整句');
    assert.ok(res.body.profile.keys.every((k) => !k.includes('@')), '关键信息点不应包含 @ 提及');
  });

  it('没有画像的人返回 404', async () => {
    assert.equal((await api.get(`/api/ai/profiles/${zhou.id}`, token)).status, 404);
    assert.equal((await api.get('/api/ai/profiles/u_ghost', token)).status, 404);
  });
});
