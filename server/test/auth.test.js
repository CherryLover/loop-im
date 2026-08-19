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
  it('用正确的邮箱密码登录，返回 token、用户与 AI 公共信息', async () => {
    const res = await api.post('/api/auth/login', { email: ADMIN, password: ADMIN_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenDays, 15);
    assert.ok(res.body.token);
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.online, true);
    assert.equal(res.body.ai.name, 'Aria');
    assert.equal(typeof res.body.ai.providerLabel, 'string');
  });

  it('密码错误时返回 401 且不泄露账号是否存在', async () => {
    const wrongPassword = await api.post('/api/auth/login', { email: ADMIN, password: 'nope' });
    const unknownUser = await api.post('/api/auth/login', { email: 'ghost@test.local', password: PASSWORD });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.body.error, unknownUser.body.error);
  });

  it('AI 账号不能被用来登录', async () => {
    const res = await api.post('/api/auth/login', { email: 'aria@system', password: PASSWORD });
    assert.equal(res.status, 401);
  });

  it('密码在库里是哈希，不是明文', async () => {
    const { get } = await import('../src/db.js');
    const row = get('SELECT password_hash FROM users WHERE email = ?', ADMIN);
    assert.ok(row.password_hash.startsWith('$2'));
    assert.ok(!row.password_hash.includes(ADMIN_PASSWORD));
  });

  it('AI 账号没有密码，也就无法被爆破', async () => {
    const { get } = await import('../src/db.js');
    assert.equal(get('SELECT password_hash FROM users WHERE id = ?', 'ai').password_hash, null);
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
  it('普通成员看不到 AI 管理，也不能开通成员或建群', async () => {
    const token = await api.login(chen.email);
    const other = await member('周明', { dept: '前端' });
    assert.equal((await api.get('/api/ai/overview', token)).status, 403);
    assert.equal((await api.get('/api/ai/settings', token)).status, 403);
    assert.equal((await api.post('/api/users', { name: '吴思', email: 'wu.si@test.local' }, token)).status, 403);
    assert.equal((await api.post('/api/conversations/group', { title: 'x', memberIds: [other.id, chen.id] }, token)).status, 403);
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
