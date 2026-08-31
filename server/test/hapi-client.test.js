// hapi hub 客户端：认证换发与 401 重试、各端点的形状、SSE 读取、回复文本抽取。
// 全部打在本地假 hub 上（test/hapi-mock.js），形状与 v0.27.3 一致。
import './helpers.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMockHub } from './hapi-mock.js';

let hub, client;

before(async () => {
  hub = await startMockHub();
  process.env.HAPI_BASE_URL = hub.baseUrl;
  process.env.HAPI_TOKEN = 'test-access-token';
  process.env.HAPI_MACHINE_ID = 'm_1';
  process.env.HAPI_WORKROOT = '/tmp/agents';
  client = await import('../src/hapi/client.js');
});
after(async () => { await hub.close(); });
beforeEach(() => { client.resetJwtForTest(); hub.state.requests.length = 0; });

describe('hapi 客户端 · 认证', () => {
  it('第一次请求先换 JWT，后续复用，不重复认证', async () => {
    hub.state.machines = [hub.onlineMachine('m_1')];
    await client.machines();
    await client.machines();
    const auths = hub.state.requests.filter((r) => r.path === '/api/auth');
    assert.equal(auths.length, 1, 'JWT 应当被缓存复用');
  });

  it('JWT 过期（401）时自动换新重试一次，调用方无感', async () => {
    hub.state.machines = [hub.onlineMachine('m_1')];
    await client.machines();
    hub.invalidateJwts();                       // 模拟 4 小时过期
    const list = await client.machines();
    assert.equal(list.length, 1, '过期后应换新 JWT 重试成功');
  });

  it('所有请求都带自定义 UA（Cloudflare 会拦默认 UA）', async () => {
    hub.state.machines = [];
    await client.machines();
    assert.ok(hub.state.requests.every((r) => r.ua.startsWith('loop-im/')), '每个请求都要有 loop-im 的 UA');
  });

  it('未配置时 isHapiConfigured 为 false', () => {
    const saved = process.env.HAPI_BASE_URL;
    delete process.env.HAPI_BASE_URL;
    assert.equal(client.isHapiConfigured(), false);
    process.env.HAPI_BASE_URL = saved;
    assert.equal(client.isHapiConfigured(), true);
  });
});

describe('hapi 客户端 · 端点', () => {
  it('configuredMachine 只认 HAPI_MACHINE_ID 那台；isMachineOnline 看 active + runner 状态', async () => {
    hub.state.machines = [hub.onlineMachine('m_other'), hub.onlineMachine('m_1')];
    const m = await client.configuredMachine();
    assert.equal(m.id, 'm_1');
    assert.equal(client.isMachineOnline(m), true);
    assert.equal(client.isMachineOnline({ ...m, runnerState: { status: 'stopped' } }), false);
    assert.equal(client.isMachineOnline(null), false);
  });

  it('spawnSession 传目录与 agent、默认 yolo；失败（type=error）抛错', async () => {
    hub.state.spawnResult = { type: 'success', sessionId: 's_9' };
    const id = await client.spawnSession({ directory: '/tmp/agents/claude', agent: 'claude' });
    assert.equal(id, 's_9');
    assert.deepEqual(hub.state.lastSpawn, { machineId: 'm_1', directory: '/tmp/agents/claude', agent: 'claude', yolo: true });

    hub.state.spawnResult = { type: 'error', message: 'agent not installed' };
    await assert.rejects(() => client.spawnSession({ directory: '/x', agent: 'pi' }), /agent not installed/);
  });

  it('session 详情：在返回、404 回 null', async () => {
    hub.state.sessions.set('s_1', { id: 's_1', active: true, thinking: false });
    assert.equal((await client.session('s_1')).active, true);
    assert.equal(await client.session('s_gone'), null);
  });

  it('发消息与翻消息', async () => {
    await client.sendSessionMessage('s_1', '群『发版』的 张三：@Claude 帮我看看');
    assert.deepEqual(hub.state.lastMessage, { sessionId: 's_1', text: '群『发版』的 张三：@Claude 帮我看看' });

    hub.state.messages.set('s_1', [{ id: 'hm1', seq: 1, content: {}, createdAt: 1 }]);
    const page = await client.sessionMessages('s_1');
    assert.equal(page.messages.length, 1);
  });
});

describe('hapi 客户端 · 回复文本抽取（extractAgentText）', () => {
  it("codex 形状：content.type='codex' 且 data.type='message'", () => {
    const content = { role: 'agent', content: { type: 'codex', data: { type: 'message', message: '已看完，CI 红在 lint。' } } };
    assert.equal(client.extractAgentText(content), '已看完，CI 红在 lint。');
  });

  it("claude 形状：content.type='output'、assistant 消息里的 text 块拼接", () => {
    const content = {
      role: 'agent',
      content: {
        type: 'output',
        data: { type: 'assistant', message: { content: [
          { type: 'text', text: '第一段' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'text', text: '第二段' },
        ] } },
      },
    };
    assert.equal(client.extractAgentText(content), '第一段\n第二段');
  });

  it('信封的三种包法都拆得开（裸 record / message / data.message）', () => {
    const record = { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'hi' } } };
    assert.equal(client.extractAgentText(record), 'hi');
    assert.equal(client.extractAgentText({ message: record }), 'hi');
    assert.equal(client.extractAgentText({ data: { message: record } }), 'hi');
  });

  it('不是 Agent 的话、工具调用、推理块一律返回 null', () => {
    assert.equal(client.extractAgentText({ role: 'user', content: { type: 'codex', data: { type: 'message', message: 'x' } } }), null);
    assert.equal(client.extractAgentText({ role: 'agent', content: { type: 'output', data: { type: 'tool_use' } } }), null);
    assert.equal(client.extractAgentText({ role: 'agent', content: { type: 'event', data: {} } }), null);
    assert.equal(client.extractAgentText(null), null);
    assert.equal(client.extractAgentText('plain'), null);
  });
});

describe('hapi 客户端 · SSE', () => {
  it('能收到 message-received 事件；close 后停止重连', async () => {
    const events = [];
    const sub = client.openEvents({ sessionId: 's_1', onEvent: (e) => events.push(e) });
    // 等订阅真正挂上（mock 收到 /api/events 请求）
    const deadline = Date.now() + 3000;
    while (hub.state.sseClients.size === 0) {
      if (Date.now() > deadline) throw new Error('SSE 客户端没连上来');
      await new Promise((r) => setTimeout(r, 20));
    }
    hub.pushEvent({ type: 'message-received', sessionId: 's_1', message: { id: 'hm1', content: {} } });
    await new Promise((r) => setTimeout(r, 100));
    // mock 连上时先发一条 connection-changed（真 hub 也这样），这里只关心业务事件
    assert.equal(events.filter((e) => e.type === 'message-received').length, 1);

    sub.close();
    for (const c of hub.state.sseClients) c.end();
    await new Promise((r) => setTimeout(r, 50));
  });
});
