// Agent 回合的「执行过程」（D15，src/hapi/steps.js）：中间文字和工具动作按步落库、
// 挂到回复消息上、按需查询；进行中实时推 ai-progress。hub 是假的（hapi-mock），
// 事件序列由测试亲手推，Loop IM 服务端是真的。
import { startServer, waitFor } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMockHub } from './hapi-mock.js';

process.env.HAPI_QUEUE_MAX = '5';
process.env.HAPI_TURN_QUIET_MS = '150';
process.env.HAPI_TURN_TIMEOUT_MS = '60000';
process.env.HAPI_ACTIVE_POLL_MS = '50';
process.env.HAPI_AGENTS = 'none';

let api, hub, admin, chen, chenToken, room;

const agentText = (text) => ({
  role: 'agent',
  content: { type: 'codex', data: { type: 'message', message: text } },
});
const toolCall = (callId, input, name = 'run_terminal_command') => ({
  role: 'agent',
  content: { type: 'codex', data: { type: 'tool-call', callId, name, input, status: 'pending' } },
});
const push = (sessionId, content) =>
  hub.pushEvent({ type: 'message-received', sessionId, message: { id: `hm_${Math.random().toString(36).slice(2)}`, content } });
const messagesOf = async (id, token) => (await api.get(`/api/conversations/${id}/messages`, token)).body.messages;
const lastAgentMessage = async (id, token) => (await messagesOf(id, token)).filter((m) => m.isAI).at(-1);

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
  const res = await api.post('/api/conversations/group', { title: '过程验证', memberIds: [chen.id, 'ai-claude'] }, admin);
  room = res.body.conversation;
  hub.state.spawnResult = { type: 'success', sessionId: 's_steps' };
  hub.state.sessions.set('s_steps', { id: 's_steps', active: true, thinking: false });
});
after(async () => { await api.close(); await hub.close(); });

describe('过程落库并挂到回复上', () => {
  it('中间文字 + 工具动作按序成步；同一次调用的多条状态更新只记一次；最终回复原文不算步', async () => {
    await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude 画张图' }, chenToken);
    await waitFor(() => hub.state.lastMessage);

    hub.pushEvent({ type: 'session-updated', sessionId: 's_steps', data: { thinking: true } });
    push('s_steps', agentText('我先看看要画什么。'));
    push('s_steps', toolCall('call-1', { command: '/bin/zsh -lc "ls 素材目录"' }));
    push('s_steps', toolCall('call-1', { command: '/bin/zsh -lc "ls 素材目录"' }));      // 同一调用的状态更新
    push('s_steps', toolCall('call-2', { command: 'python3 gen.py', description: '生成图片' }));
    push('s_steps', agentText('画好了，请查收。'));                                       // 最终回复
    hub.pushEvent({ type: 'session-updated', sessionId: 's_steps', data: { thinking: false } });

    const reply = await waitFor(async () => {
      const last = await lastAgentMessage(room.id, chenToken);
      return last?.body === '画好了，请查收。' ? last : null;
    });
    assert.equal(reply.progressCount, 3, '一段中间文字 + 两次工具调用；重复状态更新和回复原文都不算');

    const steps = (await api.get(`/api/conversations/${room.id}/messages/${reply.id}/steps`, chenToken)).body.steps;
    assert.deepEqual(steps.map((s) => [s.kind, s.content]), [
      ['text', '我先看看要画什么。'],
      ['tool', '执行命令：ls 素材目录'],
      ['tool', '生成图片'],
    ], '顺序保持；shell 包装剥掉；工具自带的描述优先当标签');
    assert.ok(steps.every((s, i) => s.seq === steps[0].seq + i && s.createdAt > 0));
  });

  it('人类消息 progressCount 恒为 0；非成员查过程 404（口径与回应接口一致）', async () => {
    const mine = (await messagesOf(room.id, chenToken)).find((m) => m.senderId === chen.id);
    assert.equal(mine.progressCount, 0);

    const outsider = await member('外人');
    const outsiderToken = await api.login(outsider.email);
    const reply = await lastAgentMessage(room.id, chenToken);
    const res = await api.get(`/api/conversations/${room.id}/messages/${reply.id}/steps`, outsiderToken);
    assert.equal(res.status, 404);
  });

  it('超时的固定文案也挂过程——出事时更要能看它卡在哪一步', async () => {
    process.env.HAPI_TURN_TIMEOUT_MS = '400';
    try {
      const before = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI).length;
      await api.post(`/api/conversations/${room.id}/messages`, { body: '@Claude 这次会超时' }, chenToken);
      await waitFor(() => hub.state.lastMessage?.text.includes('这次会超时'));
      hub.pushEvent({ type: 'session-updated', sessionId: 's_steps', data: { thinking: true } });
      push('s_steps', toolCall('call-slow', { description: '一个跑不完的活' }));
      // 不推 thinking:false —— 让它超时
      const reply = await waitFor(async () => {
        const list = (await messagesOf(room.id, chenToken)).filter((m) => m.isAI);
        return list.length > before ? list.at(-1) : null;
      }, { timeout: 5000 });
      assert.match(reply.body, /处理超时/);
      assert.equal(reply.progressCount, 1);
      const steps = (await api.get(`/api/conversations/${room.id}/messages/${reply.id}/steps`, chenToken)).body.steps;
      assert.deepEqual(steps.map((s) => s.content), ['一个跑不完的活']);
    } finally {
      process.env.HAPI_TURN_TIMEOUT_MS = '60000';
    }
  });
});

describe('记录器本身（beginTurn 直调，带假 emit）', () => {
  it('每步落库同时推一条 ai-progress；连续重复文字只记一次；封顶后只补一条省略说明', async () => {
    const { beginTurn } = await import('../src/hapi/steps.js');
    const { all } = await import('../src/db.js');
    const events = [];
    process.env.HAPI_STEPS_MAX = '3';
    try {
      const rec = beginTurn({
        conversationId: 'c_unit', agent: { userId: 'ai-claude', name: 'Claude' },
        triggerMessageId: 'm_unit', audience: ['u_x'],
        emit: (audience, type, payload) => events.push({ type, payload }),
      });
      rec.addText('想一下');
      rec.addText('想一下');                                 // grok 系会把同一段话推很多遍
      rec.addTool({ callId: 'c1', name: 'read_file', input: { path: '/tmp/a.png' } });
      rec.addText('第三步');
      rec.addText('第四步（超了）');
      rec.addTool({ callId: 'c2', name: 'x', input: {} });   // 封顶后不再记

      const rows = all(`SELECT seq, kind, content FROM hapi_turn_steps WHERE turn_id = ? ORDER BY seq`, rec.turnId);
      assert.deepEqual(rows.map((r) => [r.seq, r.kind, r.content]), [
        [1, 'text', '想一下'],
        [2, 'tool', 'read_file：/tmp/a.png'],
        [3, 'text', '第三步'],
        [4, 'text', '（过程步骤太多，之后的不再记录）'],
      ]);
      assert.equal(events.length, 4, '落库几步就推几条 ai-progress');
      assert.deepEqual(events[0].payload.agent, { id: 'ai-claude', name: 'Claude' });
      assert.equal(events[1].payload.step.kind, 'tool');
    } finally {
      delete process.env.HAPI_STEPS_MAX;
    }
  });

  it('hapi 的内部杂务（改会话标题）不记步——本地实测记出来只有噪音', async () => {
    const { beginTurn } = await import('../src/hapi/steps.js');
    const { all } = await import('../src/db.js');
    const rec = beginTurn({
      conversationId: 'c_unit2', agent: { userId: 'ai-claude', name: 'Claude' },
      triggerMessageId: 'm_unit2', audience: [], emit: () => {},
    });
    rec.addTool({ callId: 't1', name: 'mcp__hapi__change_title', input: {} });
    rec.addTool({ callId: 't2', name: 'read_file', input: { path: '/tmp/x' } });
    const rows = all('SELECT content FROM hapi_turn_steps WHERE turn_id = ? ORDER BY seq', rec.turnId);
    assert.deepEqual(rows.map((r) => r.content), ['read_file：/tmp/x']);
  });

  it('claude 系 assistant 消息里的 tool_use 块也能抽成工具步', async () => {
    const { extractToolCalls } = await import('../src/hapi/client.js');
    const calls = extractToolCalls({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '我来跑一下' },
              { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } },
            ],
          },
        },
      },
    });
    assert.deepEqual(calls, [{ callId: 'tu_1', name: 'Bash', input: { command: 'ls -la' } }]);
  });
});
