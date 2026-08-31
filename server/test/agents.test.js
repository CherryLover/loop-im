// hapi Agent 管理：勾选建用户、取消停用、机器离线联动、改名规则、权限与未配置降级。
// hub 是本地假的（test/hapi-mock.js），Loop IM 服务端是真的。
import { startServer } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMockHub } from './hapi-mock.js';

// 探测在真机上不确定（开发机装了一堆 CLI，CI 一个都没有），测试一律显式指定。
process.env.HAPI_AGENTS = 'none';

let api, hub, admin, memberToken;

before(async () => {
  hub = await startMockHub();
  process.env.HAPI_BASE_URL = hub.baseUrl;
  process.env.HAPI_TOKEN = 'test-access-token';
  process.env.HAPI_MACHINE_ID = 'm_1';
  process.env.HAPI_WORKROOT = '/tmp/loop-agents';
  hub.state.machines = [hub.onlineMachine('m_1', 'Test-Runner')];

  api = await startServer();
  admin = await api.loginAdmin();
  const zhou = await member('周明');
  memberToken = await api.login(zhou.email);
});
after(async () => { await api.close(); await hub.close(); });

describe('Agent 管理 · 权限与状态', () => {
  it('普通成员摸不到任何 /api/agents 接口', async () => {
    assert.equal((await api.get('/api/agents', memberToken)).status, 403);
    assert.equal((await api.put('/api/agents/claude', { enabled: true }, memberToken)).status, 403);
    assert.equal((await api.post('/api/agents/test', {}, memberToken)).status, 403);
  });

  it('状态页列出全部 9 种 Agent（gemini 已被 0.27.3 hub 拒绝，剔除），带机器在线与本机可用状态', async () => {
    const res = await api.get('/api/agents', admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.machineOnline, true);
    assert.equal(res.body.machineHost, 'Test-Runner');
    assert.equal(res.body.agents.length, 9);
    assert.ok(!res.body.agents.some((a) => a.key === 'gemini'));
    const claude = res.body.agents.find((a) => a.key === 'claude');
    assert.deepEqual(
      { enabled: claude.enabled, name: claude.name, userId: claude.userId },
      { enabled: false, name: 'Claude', userId: 'ai-claude' },
    );
    // 官方名带空格的默认名按 D3 换成连字符
    assert.equal(res.body.agents.find((a) => a.key === 'grok').name, 'Grok-Build');
  });

  it('测试连通性：hub 通 + 机器在线 → ok', async () => {
    const res = await api.post('/api/agents/test', {}, admin);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.lines.some((l) => l.includes('Test-Runner')));
  });
});

describe('Agent 管理 · 启用与用户联动', () => {
  it('勾选启用 → 自动出现对应的 AI 用户，id 稳定、role=ai、无法登录', async () => {
    const res = await api.put('/api/agents/claude', { enabled: true }, admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, 'ai-claude');
    assert.equal(res.body.user.isAI, true);

    const users = (await api.get('/api/users', admin)).body.users;
    const bot = users.find((u) => u.id === 'ai-claude');
    assert.ok(bot, '联系人里应出现 Claude');
    assert.equal(bot.name, 'Claude');
    assert.equal(bot.online, true, '启用且机器在线 → 常驻在线');

    // 没有密码，登录路由不认 AI（老守卫对新用户同样生效）
    const login = await api.post('/api/auth/login', { email: 'claude@hapi.local', password: 'x' });
    assert.equal(login.status, 401);
  });

  it('取消勾选 → 用户停用并从联系人里消失；重新勾选 → 原样回来（id 不变）', async () => {
    await api.put('/api/agents/claude', { enabled: false }, admin);
    let users = (await api.get('/api/users', admin)).body.users;
    assert.ok(!users.some((u) => u.id === 'ai-claude'), '停用的 AI 用户不该出现在联系人里');

    await api.put('/api/agents/claude', { enabled: true }, admin);
    users = (await api.get('/api/users', admin)).body.users;
    assert.ok(users.some((u) => u.id === 'ai-claude'));
    const { get } = await import('../src/db.js');
    assert.equal(get(`SELECT count(*) AS n FROM users WHERE id LIKE 'ai-claude%'`).n, 1, '反复开关不产生重复用户');
  });

  it('机器离线 → 启用中的 Agent 用户自动停用；恢复在线 → 自动回来（勾选保留）', async () => {
    hub.state.machines = [];                                     // 机器整个不见了
    let res = await api.get('/api/agents', admin);
    assert.equal(res.body.machineOnline, false);
    let users = (await api.get('/api/users', admin)).body.users;
    assert.ok(!users.some((u) => u.id === 'ai-claude'), '机器离线时 Agent 用户应隐身');

    hub.state.machines = [hub.onlineMachine('m_1', 'Test-Runner')];
    res = await api.get('/api/agents', admin);
    assert.equal(res.body.machineOnline, true);
    assert.equal(res.body.agents.find((a) => a.key === 'claude').enabled, true, '管理员的勾选不该被离线抹掉');
    users = (await api.get('/api/users', admin)).body.users;
    assert.ok(users.some((u) => u.id === 'ai-claude'), '机器回来 Agent 用户跟着回来');
  });

  it('改名：连字符可以，空格不行（D3——提及按整名匹配）', async () => {
    const ok = await api.patch('/api/agents/claude', { name: 'Claude-Code' }, admin);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, 'Claude-Code');

    const bad = await api.patch('/api/agents/claude', { name: 'Claude Code' }, admin);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /空格/);
  });

  it('未知的 Agent 类型 → 404', async () => {
    assert.equal((await api.put('/api/agents/skynet', { enabled: true }, admin)).status, 404);
  });
});

describe('Agent 管理 · 自动接入（机器支持哪些就都加进去）', () => {
  it("HAPI_AGENTS 列表里的 Agent 在对账时自动建成用户", async () => {
    process.env.HAPI_AGENTS = 'codex,pi';
    try {
      const res = await api.get('/api/agents', admin);        // GET 顺带对账
      const codex = res.body.agents.find((a) => a.key === 'codex');
      const pi = res.body.agents.find((a) => a.key === 'pi');
      assert.deepEqual([codex.enabled, codex.available, pi.enabled, pi.available], [true, true, true, true]);
      const users = (await api.get('/api/users', admin)).body.users;
      assert.ok(users.some((u) => u.id === 'ai-codex') && users.some((u) => u.id === 'ai-pi'), '联系人里应自动出现两位 Agent');
    } finally {
      process.env.HAPI_AGENTS = 'none';
    }
  });

  it('管理员手动关掉的不会被自动拉回；清单外的不自动加', async () => {
    process.env.HAPI_AGENTS = 'codex,pi';
    try {
      await api.put('/api/agents/codex', { enabled: false }, admin);   // 管理员的选择
      const res = await api.get('/api/agents', admin);                 // 再对一次账
      assert.equal(res.body.agents.find((a) => a.key === 'codex').enabled, false, '手动关掉的要尊重');
      assert.equal(res.body.agents.find((a) => a.key === 'pi').enabled, true);
      assert.equal(res.body.agents.find((a) => a.key === 'agy').enabled, false, '清单外的不该被自动加');
    } finally {
      process.env.HAPI_AGENTS = 'none';
      await api.put('/api/agents/pi', { enabled: false }, admin);      // 收尾，别影响其他用例
    }
  });

  it('探测模式（auto）：按 PATH 里的真实命令探测', async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { availableAgentKeys } = await import('../src/hapi/agents.js');
    const dir = mkdtempSync(join(tmpdir(), 'agent-bins-'));
    for (const bin of ['claude', 'cursor-agent']) {
      const f = join(dir, bin);
      writeFileSync(f, '#!/bin/sh\n');
      chmodSync(f, 0o755);
    }
    const savedSpec = process.env.HAPI_AGENTS;
    const savedPath = process.env.PATH;
    try {
      delete process.env.HAPI_AGENTS;                                  // auto 档
      process.env.PATH = dir;                                          // 只认这个目录
      const keys = availableAgentKeys();
      assert.deepEqual([...keys].sort(), ['claude', 'cursor'], 'cursor 探测的是 cursor-agent 这个命令名');
    } finally {
      process.env.HAPI_AGENTS = savedSpec;
      process.env.PATH = savedPath;
    }
  });
});

describe('Agent 管理 · 未配置时的降级', () => {
  it('清掉配置 → configured=false、不能启用、测试连通性给出指引', async () => {
    const saved = process.env.HAPI_BASE_URL;
    delete process.env.HAPI_BASE_URL;
    try {
      const status = await api.get('/api/agents', admin);
      assert.equal(status.body.configured, false);
      assert.equal((await api.put('/api/agents/codex', { enabled: true }, admin)).status, 400);
      const test = await api.post('/api/agents/test', {}, admin);
      assert.equal(test.body.ok, false);
      assert.ok(test.body.lines[0].includes('HAPI_BASE_URL'));
    } finally {
      process.env.HAPI_BASE_URL = saved;
    }
  });
});
