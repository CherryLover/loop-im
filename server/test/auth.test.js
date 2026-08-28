import { startServer, ADMIN, ADMIN_PASSWORD, PASSWORD } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, chen;
before(async () => {
  api = await startServer();
  chen = await member('陈子航', { dept: '后端' });
});
after(async () => { await api.close(); });

describe('登录与身份', () => {
  it('用正确的邮箱密码登录，返回 token 与用户信息', async () => {
    const res = await api.post('/api/auth/login', { email: ADMIN, password: ADMIN_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenDays, 15);
    assert.ok(res.body.token);
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.online, true);
    // Aria 退役后（docs/hapi-Agent-接入方案.md §F），登录响应不再携带 ai 字段
    assert.equal(res.body.ai, undefined);
  });

  it('密码错误时返回 401 且不泄露账号是否存在', async () => {
    const wrongPassword = await api.post('/api/auth/login', { email: ADMIN, password: 'nope' });
    const unknownUser = await api.post('/api/auth/login', { email: 'ghost@test.local', password: PASSWORD });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.body.error, unknownUser.body.error);
  });

  it('AI 角色的账号不能被用来登录', async () => {
    // 将来 hapi 的 Agent 账号也是 ai 角色，同样没有登录入口——密码对了也进不来
    const bot = await member('小助手', { role: 'ai' });
    const res = await api.post('/api/auth/login', { email: bot.email, password: PASSWORD });
    assert.equal(res.status, 401);
  });

  it('密码在库里是哈希，不是明文', async () => {
    const { get } = await import('../src/db.js');
    const row = get('SELECT password_hash FROM users WHERE email = ?', ADMIN);
    assert.ok(row.password_hash.startsWith('$2'));
    assert.ok(!row.password_hash.includes(ADMIN_PASSWORD));
  });

  it('全新的库里没有内置 AI 账号', async () => {
    // Aria 退役后不再创建 id 为 'ai' 的那一行；老库里的存量行由 retireLegacyAi 停用（见 bootstrap.js）
    const { get } = await import('../src/db.js');
    assert.equal(get('SELECT id FROM users WHERE id = ?', 'ai'), undefined);
  });

  it('没有 token 时受保护接口返回 401', async () => {
    assert.equal((await api.get('/api/conversations')).status, 401);
    assert.equal((await api.get('/api/users')).status, 401);
  });

  it('伪造的 token 会被拒绝', async () => {
    const res = await api.get('/api/auth/me', 'not-a-real-token');
    assert.equal(res.status, 401);
  });
});

describe('角色权限', () => {
  it('普通成员不能开通成员或建群', async () => {
    const token = await api.login(chen.email);
    const other = await member('周明', { dept: '前端' });
    assert.equal((await api.post('/api/users', { name: '吴思', email: 'wu.si@test.local' }, token)).status, 403);
    assert.equal((await api.post('/api/conversations/group', { title: 'x', memberIds: [other.id, chen.id] }, token)).status, 403);
  });

  it('AI 管理接口已随 Aria 退役整体下线', async () => {
    // 连管理员也拿不到：路由是整个删掉了，不是换了权限。这里用裸 fetch——
    // express 对不存在的路由回的是 HTML 404，api.get 会在 JSON.parse 上炸掉。
    const token = await api.loginAdmin();
    for (const [method, path] of [
      ['GET', '/api/ai/overview'],
      ['GET', '/api/ai/settings'],
      ['PUT', '/api/ai/settings'],
      ['POST', '/api/ai/test'],
      ['GET', '/api/ai/profiles/default'],
    ]) {
      const res = await fetch(`${api.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      assert.equal(res.status, 404, `${method} ${path} 应当已不存在`);
    }
  });

  it('管理员可以开通新成员，新成员能用初始密码登录', async () => {
    const token = await api.loginAdmin();
    const created = await api.post('/api/users', { name: '吴思', email: 'wu.si@test.local', dept: '运营' }, token);
    assert.equal(created.status, 201);
    assert.ok(created.body.initialPassword);
    assert.equal(created.body.user.role, 'member');

    const login = await api.post('/api/auth/login', { email: 'wu.si@test.local', password: created.body.initialPassword });
    assert.equal(login.status, 200);
  });

  it('重复邮箱与非法邮箱会被拒绝', async () => {
    const token = await api.loginAdmin();
    assert.equal((await api.post('/api/users', { name: '重复', email: 'wu.si@test.local' }, token)).status, 409);
    assert.equal((await api.post('/api/users', { name: '格式', email: 'not-an-email' }, token)).status, 400);
    assert.equal((await api.post('/api/users', { name: '', email: 'a@test.local' }, token)).status, 400);
  });
});

describe('个人资料', () => {
  it('可以改昵称', async () => {
    const user = await member('苏晴', { dept: '设计' });
    const token = await api.login(user.email);
    const res = await api.patch('/api/auth/me', { name: '苏晴（设计）' }, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.name, '苏晴（设计）');
  });

  it('改密码需要当前密码，且新密码至少 8 位', async () => {
    const user = await member('高远', { dept: '测试' });
    const token = await api.login(user.email);
    assert.equal((await api.post('/api/auth/me/password', { current: 'wrong', next: 'newpass123' }, token)).status, 400);
    assert.equal((await api.post('/api/auth/me/password', { current: PASSWORD, next: 'short' }, token)).status, 400);

    const ok = await api.post('/api/auth/me/password', { current: PASSWORD, next: 'newpass123' }, token);
    assert.equal(ok.status, 200);
    assert.equal((await api.post('/api/auth/login', { email: user.email, password: 'newpass123' })).status, 200);
    assert.equal((await api.post('/api/auth/login', { email: user.email, password: PASSWORD })).status, 401);
  });
});
