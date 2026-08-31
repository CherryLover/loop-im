// hapi Agent 对话全链路：@ 触发 → 判活/开会话 → 递消息 → SSE 收回复 → 贴回聊天。
// Loop IM 服务端是真的，hub 是本地假的（test/hapi-mock.js），事件序列由测试亲手推。
import { startServer, waitFor } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMockHub } from './hapi-mock.js';

process.env.HAPI_QUEUE_MAX = '1';            // 排队上限压到 1，好测「排队过多」
process.env.HAPI_TURN_QUIET_MS = '150';      // 文本后安静这么久算收工（测试里别等 5 秒）
process.env.HAPI_TURN_TIMEOUT_MS = '60000';  // 单独的超时用例里再压小
process.env.HAPI_ACTIVE_POLL_MS = '50';      // 等会话 active 的轮询间隔（测试里别真等 1 秒）

let api, hub, admin, chen, chenToken, room;

const agentText = (text) => ({
  role: 'agent',
  content: { type: 'codex', data: { type: 'message', message: text } },
});
const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const lastAgentMessage = async (id, token) => (await messagesOf(id, token)).filter((m) => m.isAI).at(-1);

/** 推一整个「回合」的事件：开工 → 文本 → 收工。 */
function pushTurn(sessionId, text) {
  hub.pushEvent({ type: 'session-updated', sessionId, data: { thinking: true } });
  hub.pushEvent({ type: 'message-received', sessionId, message: { id: `hm_${Date.now()}`, content: agentText(text) } });
  hub.pushEvent({ type: 'session-updated', sessionId, data: { thinking: false } });
}

before(async () => {
  hub = await startMockHub();
  process.env.HAPI_BASE_URL = hub.baseUrl;
  process.env.HAPI_TOKEN = 'test-access-token';
  process.env.HAPI_MACHINE_ID = 'm_1';
  process.env.HAPI_WORKROOT = '/tmp/loop-agents';
  hub.state.machines = [hub.onlineMachine('m_1')];

  api = await startServer();
  admin = await api.loginAdmin();
  chen = await member('陈子航');
  chenToken = await api.login(chen.email);

  await api.put('/api/agents/claude', { enabled: true }, admin);
  await api.patch('/api/agents/claude', { name: 'Claude-Code' }, admin);
  // 管理员建群，把成员和 Agent 一起拉进来（D8：只有管理员能拉 Agent）
  const res = await api.post('/api/conversations/group', { title: '发版讨论', memberIds: [chen.id, 'ai-claude'] }, admin);
  assert.equal(res.status, 201);
  room = res.body.conversation;
});
after(async () => { await api.close(); await hub.close(); });

beforeEach(() => {
  hub.state.machines = [hub.onlineMachine('m_1')];
  hub.state.spawnResult = { type: 'success', sessionId: 's_claude_1' };
  hub.state.sessions.set('s_claude_1', { id: 's_claude_1', active: true, thinking: false });
});

describe('群聊 @ 触发', () => {
  it('@Claude-Code → 开会话（目录/agent/yolo 都对）→ 递消息（带开场白、上下文、来源前缀）→ 回复贴回群里', async () => {
    // 先铺两条普通聊天，@ 时它们要作为上下文带过去（触发消息本身不重复进上下文）
    await api.post(`/api/conversations/${room.id}/messages`, { body: '回归测试只剩一天了' }, admin);
    await api.post(`/api/conversations/${room.id}/messages`, { body: '接口还有两项没完成' }, chenToken);
    const send = await api.post(`/api/conversations/${room.id}/messages`,
      { body: '@Claude-Code 帮我看看 CI 为什么红了' }, chenToken);
    assert.equal(send.status, 201);
    assert.deepEqual(send.body.message.mentions, ['ai-claude']);

    // hub 侧收到 spawn（第一次没有存过会话）+ 消息
    await waitFor(() => hub.state.lastMessage);
    assert.deepEqual(hub.state.lastSpawn, { machineId: 'm_1', directory: '/tmp/loop-agents/claude', agent: 'claude', yolo: true });
    const delivered = hub.state.lastMessage.text;
    assert.ok(delivered.includes('你是团队 IM「Loop IM」里的成员「Claude-Code」'), '新会话要带开场白');
    assert.ok(delivered.includes('[最近的对话上下文]'), '要带最近上下文');
    assert.ok(delivered.includes('回归测试只剩一天了') && delivered.includes('接口还有两项没完成'), '上下文要包含此前的聊天');
    assert.equal(delivered.match(/帮我看看 CI 为什么红了/g).length, 1, '触发消息只出现在前缀行，不重复进上下文');
    assert.ok(delivered.includes('群『发版讨论』的 陈子航：@Claude-Code 帮我看看 CI 为什么红了'), '要带来源前缀');

    pushTurn('s_claude_1', '看完了：红在 lint，`no-unused-vars` 两处。');
    const reply = await waitFor(() => lastAgentMessage(room.id, chenToken));
    assert.equal(reply.senderId, 'ai-claude');
    assert.equal(reply.senderName, 'Claude-Code');
    assert.ok(reply.body.includes('红在 lint'));
  });

  it('第二次 @ 复用已有会话（不再 spawn、不再带开场白）；取回合内最后一条文本', async () => {
    hub.state.lastSpawn = null;
    hub.state.lastMessage = null;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 再确认一下' }, chenToken);
    await waitFor(() => hub.state.lastMessage);
    assert.equal(hub.state.lastSpawn, null, '会话还活着就不该重新 spawn');
    assert.ok(!hub.state.lastMessage.text.includes('开场白') && !hub.state.lastMessage.text.includes('你是团队 IM'), '老会话不带开场白');

    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: true } });
    hub.pushEvent({ type: 'message-received', sessionId: 's_claude_1', message: { id: 'hm_a', content: agentText('先跑个命令…') } });
    hub.pushEvent({ type: 'message-received', sessionId: 's_claude_1', message: { id: 'hm_b', content: agentText('确认无误，可以发版。') } });
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: false } });

    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.equal(reply.body, '确认无误，可以发版。', '只贴最终那条，不贴中间过程');
  });

  it('干活前的中场白不当回复：工具跑得再久，也等 thinking 收工才贴最终那条', async () => {
    // 真实环境踩过：Agent 先说「我来看一下…」再跑几十秒工具，
    // 「安静几秒算结束」的兜底一响就把中场白贴出去了。
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 慢慢查，别急着说' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('慢慢查'));

    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: true } });
    hub.pushEvent({ type: 'message-received', sessionId: 's_claude_1', message: { id: 'hm_mid', content: agentText('我来看一下目录内容。') } });
    // 比 HAPI_TURN_QUIET_MS（150ms）长得多的「工具时间」：兜底若没被 thinking 拦住，这里就会误收工
    await new Promise((r) => setTimeout(r, 500));
    const midway = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
    assert.equal(midway.length, before, '工具还在跑，中场白不该被贴出去');

    hub.pushEvent({ type: 'message-received', sessionId: 's_claude_1', message: { id: 'hm_fin', content: agentText('查完了：目录是空的。') } });
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: false } });
    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.equal(reply.body, '查完了：目录是空的。');
  });

  it('@某个人不触发 Agent；@全员 也不触发', async () => {
    hub.state.lastMessage = null;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@陈子航 @全员 都看一下' }, admin);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hub.state.lastMessage, null);
  });

  it('会话死了先 resume；resume 失败就地重开新会话', async () => {
    hub.state.sessions.set('s_claude_1', { id: 's_claude_1', active: false, thinking: false });
    hub.state.spawnResult = { type: 'success', sessionId: 's_claude_2' };
    hub.state.lastMessage = null;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 还在吗' }, chenToken);
    await waitFor(() => hub.state.lastMessage);
    // mock 的 resume 直接成功（返回原 id），所以这里走的是 resume 路径、没有 spawn
    assert.ok(hub.state.requests.some((r) => r.path === '/api/sessions/s_claude_1/resume'));
    pushTurn('s_claude_1', '在的。');
    await waitFor(async () => (await lastAgentMessage(room.id, chenToken))?.body === '在的。');
  });
});

describe('Agent 私聊', () => {
  it('不用 @，每条都响应；回复带私聊前缀', async () => {
    const dm = (await api.post('/api/conversations/direct', { userId: 'ai-claude' }, chenToken)).body.conversation;
    assert.equal(dm.type, 'ai');
    hub.state.lastMessage = null;
    await api.post(`/api/conversations/${dm.id}/messages`, { body: '帮我总结今天的排期' }, chenToken);
    await waitFor(() => hub.state.lastMessage);
    assert.ok(hub.state.lastMessage.text.includes('与你私聊的 陈子航：帮我总结今天的排期'));

    pushTurn('s_claude_1', '排期总结：……');
    await waitFor(async () => (await lastAgentMessage(dm.id, chenToken))?.body.includes('排期总结'));
  });
});

describe('不可用与超时', () => {
  it('机器离线（用户已联动停用）→ 回固定的「暂不可用」文案', async () => {
    hub.state.machines = [];
    await api.get('/api/agents', admin);                 // 触发一次对账，让 ai-claude 停用
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 在吗' }, chenToken);
    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.equal(reply.body, 'Claude-Code 暂不可用，请联系管理员');

    hub.state.machines = [hub.onlineMachine('m_1')];
    await api.get('/api/agents', admin);                 // 恢复，别影响后面的用例
  });

  it('开会话失败（spawn 报错）→ 同样是「暂不可用」', async () => {
    hub.state.sessions.delete('s_claude_1');
    const { run } = await import('../src/db.js');
    run(`UPDATE hapi_agents SET session_id = NULL WHERE agent_key = 'claude'`);
    hub.state.spawnResult = { type: 'error', message: 'claude not installed' };
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 试试' }, chenToken);
    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.equal(reply.body, 'Claude-Code 暂不可用，请联系管理员');
  });

  it('超时（事件迟迟不来）→ 「处理超时」文案', async () => {
    process.env.HAPI_TURN_TIMEOUT_MS = '400';
    try {
      hub.state.spawnResult = { type: 'success', sessionId: 's_claude_1' };
      hub.state.sessions.set('s_claude_1', { id: 's_claude_1', active: true, thinking: false });
      const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
      await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 这条没人理' }, chenToken);
      const reply = await waitFor(async () => {
        const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
        return list.length > before ? list.at(-1) : null;
      }, { timeout: 5000 });
      assert.match(reply.body, /处理超时/);
    } finally {
      process.env.HAPI_TURN_TIMEOUT_MS = '60000';
    }
  });

  it('回合结束但一个字都没说 → 「没有返回文字回复」', async () => {
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 干个活' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('干个活'));
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: true } });
    hub.pushEvent({ type: 'session-updated', sessionId: 's_claude_1', data: { thinking: false } });
    const reply = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length > before ? list.at(-1) : null;
    });
    assert.match(reply.body, /没有返回文字回复/);
  });
});

describe('排队与限流', () => {
  it('Agent 进程启动慢（spawn 后几百毫秒才 active）→ 等到 active 再发，不吃 409', async () => {
    // 换一个还没会话的 Agent 走全新 spawn：codex
    await api.put('/api/agents/codex', { enabled: true }, admin);
    await api.post(`/api/conversations/${room.id}/members`, { userIds: ['ai-codex'] }, admin);
    hub.state.spawnResult = { type: 'success', sessionId: 's_codex_slow' };
    hub.state.sessions.set('s_codex_slow', { id: 's_codex_slow', active: false, thinking: false });
    setTimeout(() => { hub.state.sessions.get('s_codex_slow').active = true; }, 300);

    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Codex 慢启动也别丢' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('慢启动也别丢'), { timeout: 6000 });
    pushTurn('s_codex_slow', '起来了，收到。');
    await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.some((m) => m.body === '起来了，收到。') ? true : null;
    });
    // 收尾：把 codex 停掉，避免影响别的用例
    await api.put('/api/agents/codex', { enabled: false }, admin);
    hub.state.spawnResult = { type: 'success', sessionId: 's_claude_1' };
  });

  it('队列满（HAPI_QUEUE_MAX=1）时第二条立刻回「排队请求过多」，第一条照常完成', async () => {
    // 第一条占住队列：不推事件，让它一直等
    const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 第一件事' }, chenToken);
    await waitFor(() => hub.state.lastMessage?.text.includes('第一件事'));

    // 第二条进不了队列 → 立刻回话
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 第二件事' }, admin);
    const busy = await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.find((m) => m.body.includes('排队请求过多')) || null;
    });
    assert.equal(busy.body, 'Claude-Code 排队请求过多，请稍后再试');

    // 放第一条走完，别拖住后面的用例
    pushTurn('s_claude_1', '第一件事办完了。');
    await waitFor(async () => {
      const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
      return list.length >= before + 2 ? true : null;
    });
  });

  it("触发 Agent 的消息走更严的 'ai' 限流档，超了 429 且消息不入库", async () => {
    // 限流按人计数，前面的用例已经替 chen 消耗过额度——换一个全新成员来测
    const fresh = await member('额度专用');
    const freshToken = await api.login(fresh.email);
    await api.post(`/api/conversations/${room.id}/members`, { userIds: [fresh.id] }, admin);
    const limit = await import('../src/usage-limit.js');
    const restore = limit.configureUsageLimit('ai', { max: 1, windowMs: 60_000 });
    try {
      const first = await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 额度一' }, freshToken);
      assert.equal(first.status, 201);
      await waitFor(() => hub.state.lastMessage?.text.includes('额度一'));
      pushTurn('s_claude_1', '收到。');

      const second = await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude-Code 额度二' }, freshToken);
      assert.equal(second.status, 429);
      assert.ok(second.body.retryAfterMs > 0);
      const bodies = (await messagesOf(room.id, freshToken)).map((m) => m.body);
      assert.ok(!bodies.includes('@Claude-Code 额度二'), '被限流的消息不该入库');

      // 不触发 Agent 的普通消息不受 'ai' 档影响
      assert.equal((await api.post(`/api/conversations/${room.id}/messages`, { body: '普通消息照发' }, freshToken)).status, 201);
    } finally {
      restore();
    }
  });
});

describe('触发判定（agentTargetsFor 纯函数）', () => {
  it('AI 发的消息永不触发（D5）；没有 Agent 的会话返回空', async () => {
    const { agentTargetsFor } = await import('../src/hapi/turns.js');
    const roster = [
      { id: 'u_1', name: '张三', role: 'member' },
      { id: 'ai-claude', name: 'Claude-Code', role: 'ai' },
    ];
    assert.deepEqual(agentTargetsFor({
      convo: { type: 'group' }, roster, mentions: ['ai-claude'],
      sender: { id: 'ai-codex', role: 'ai' },
    }), []);
    assert.deepEqual(agentTargetsFor({
      convo: { type: 'group' }, roster: [roster[0]], mentions: ['all'],
      sender: { id: 'u_1', role: 'member' },
    }), []);
    // 一条消息 @ 到 Agent → 命中，带上 key/userId/name
    assert.deepEqual(agentTargetsFor({
      convo: { type: 'group' }, roster, mentions: ['ai-claude', 'u_1'],
      sender: { id: 'u_1', role: 'member' },
    }), [{ key: 'claude', userId: 'ai-claude', name: 'Claude-Code' }]);
  });
});
