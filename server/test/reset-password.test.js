// 管理员重置成员密码：忘了密码之后唯一的自救入口（本系统发不了邮件，没有邮箱找回）。
import { startServer, ADMIN, ADMIN_PASSWORD, PASSWORD } from './helpers.js';
import { member } from './fixtures.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, admin, chen;

const reset = (userId, token) => api.post(`/api/users/${userId}/reset-password`, {}, token);

before(async () => {
  api = await startServer();
  admin = await api.loginAdmin();
  chen = await member('陈子航', { dept: '后端' });
});
after(async () => { await api.close(); });

describe('管理员重置成员密码', () => {
  it('返回一次性新密码，够长且不是明文回显的旧密码', async () => {
    const res = await reset(chen.id, admin);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.password, 'string');
    assert.ok(res.body.password.length >= 12, `密码太短：${res.body.password}`);
    assert.notEqual(res.body.password, PASSWORD);
    assert.equal(res.body.user.id, chen.id);
  });

  it('两次重置给出不同的密码', async () => {
    const a = await reset(chen.id, admin);
    const b = await reset(chen.id, admin);
    assert.notEqual(a.body.password, b.body.password);
  });

  it('新密码能登录，旧密码不能', async () => {
    const target = await member('苏晴');
    const { password } = (await reset(target.id, admin)).body;

    const withOld = await api.post('/api/auth/login', { email: target.email, password: PASSWORD });
    assert.equal(withOld.status, 401);

    const withNew = await api.post('/api/auth/login', { email: target.email, password });
    assert.equal(withNew.status, 200);
    assert.ok(withNew.body.token);
  });

  it('重置后该成员在所有设备上的旧凭据立刻失效', async () => {
    const target = await member('林越');
    const phone = await api.login(target.email);
    const laptop = await api.login(target.email);
    assert.equal((await api.get('/api/auth/me', phone)).status, 200);
    assert.equal((await api.get('/api/auth/me', laptop)).status, 200);

    const { password } = (await reset(target.id, admin)).body;

    for (const stale of [phone, laptop]) {
      const res = await api.get('/api/auth/me', stale);
      assert.equal(res.status, 401);
    }
    // 重置本身没把别的接口一起锁死：拿新密码登录回来照样能用。
    const fresh = await api.login(target.email, password);
    assert.equal((await api.get('/api/auth/me', fresh)).status, 200);
  });

  it('重置只影响目标账号，别人的登录不受牵连', async () => {
    const [a, b] = [await member('周然'), await member('何雨')];
    const tokenB = await api.login(b.email);
    await reset(a.id, admin);
    assert.equal((await api.get('/api/auth/me', tokenB)).status, 200);
  });

  it('普通成员调用返回 403，且目标账号的密码没被动过', async () => {
    const target = await member('郑一');
    const caller = await member('吴思');
    const memberToken = await api.login(caller.email);
    const res = await reset(target.id, memberToken);
    assert.equal(res.status, 403);
    assert.equal(res.body.password, undefined);
    assert.equal((await api.post('/api/auth/login', { email: target.email, password: PASSWORD })).status, 200);
  });

  it('未登录调用返回 401', async () => {
    const res = await api.post(`/api/users/${chen.id}/reset-password`, {});
    assert.equal(res.status, 401);
  });

  it('管理员不能重置自己的密码（自己改密码要验旧密码）', async () => {
    const me = (await api.get('/api/auth/me', admin)).body.user;
    const res = await reset(me.id, admin);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /自己/);
    // 自己的登录状态和密码都没被改动。
    assert.equal((await api.get('/api/auth/me', admin)).status, 200);
    assert.equal((await api.post('/api/auth/login', { email: ADMIN, password: ADMIN_PASSWORD })).status, 200);
  });

  it('不能重置 AI 账号（它本来就没有密码、无法登录）', async () => {
    // Aria 退役后全新库里没有 'ai' 这行；这道闸门按 role='ai' 判，对将来的 hapi Agent 用户同样生效。
    const { member } = await import('./fixtures.js');
    const bot = await member('Reset-Bot', { role: 'ai' });
    const res = await reset(bot.id, admin);
    assert.equal(res.status, 400);
  });

  it('账号不存在时返回 404', async () => {
    const res = await reset('u_nobody', admin);
    assert.equal(res.status, 404);
  });

  it('新密码在库里只有哈希，不留明文', async () => {
    const target = await member('钱多');
    const { password } = (await reset(target.id, admin)).body;
    const { get } = await import('../src/db.js');
    const row = get('SELECT password_hash FROM users WHERE id = ?', target.id);
    assert.ok(row.password_hash.startsWith('$2'));
    assert.ok(!row.password_hash.includes(password));
  });
});
