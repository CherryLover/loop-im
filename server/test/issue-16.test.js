import './helpers.js';
// issue #16：升级前签发的凭据（没有 ver 字段）被拒时，不该说成「密码已修改」——
// 那些人只是经历了一次版本升级。拒绝逻辑不放松（仍然 401），只把两种语义的文案分开。
import { startServer, PASSWORD } from './helpers.js';
import { member } from './fixtures.js';
import jwt from 'jsonwebtoken';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api;
before(async () => { api = await startServer(); });
after(async () => { await api.close(); });

/** 直接用服务端的密钥签一张 token，用来模拟老凭据和被篡改的凭据。 */
const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15d' });

const currentVersion = async (userId) => {
  const { get } = await import('../src/db.js');
  return get('SELECT * FROM users WHERE id = ?', userId).auth_version;
};

describe('凭据失效的文案归因（issue #16）', () => {
  it('升级前签发的老凭据（没有 ver）返回 401「登录已过期」，而不是「密码已修改」', async () => {
    const user = await member('陆时安', { dept: '安全' });
    const legacy = sign({ sub: user.id, role: user.role });   // 升级前那版签发的样子：没有 ver，也没有 sid

    for (const path of ['/api/auth/me', '/api/users', '/api/conversations']) {
      const res = await api.get(path, legacy);
      assert.equal(res.status, 401, `${path} 仍然必须拒绝老凭据`);
      assert.equal(res.body.error, '登录已过期，请重新登录', `${path} 的文案不该归因成改密码`);
    }
    const ping = await api.post('/api/auth/ping', {}, legacy);
    assert.equal(ping.status, 401);
    assert.equal(ping.body.error, '登录已过期，请重新登录');
  });

  it('真正改过密码后的旧凭据返回 401「密码已修改」', async () => {
    const user = await member('唐向晚', { dept: '安全' });
    const stale = await api.login(user.email);
    const changed = await api.post('/api/auth/me/password', { current: PASSWORD, next: 'issue16-newpass' }, stale);
    assert.equal(changed.status, 200);

    const res = await api.get('/api/auth/me', stale);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, '密码已修改，请重新登录');
    // 换发的新凭据不受影响
    assert.equal((await api.get('/api/auth/me', changed.body.token)).status, 200);
  });

  it('ver 是 null / 字符串 / 布尔等非整数的篡改凭据一律 401，归到「登录已过期」', async () => {
    const user = await member('温以宁', { dept: '安全' });
    // 服务端签发时 ver 一定是 users.auth_version 这个整数，拿不到整数就无从证明用户改过密码，
    // 所以和「升级前的老凭据」同档处理：中性的「登录已过期」。
    const forged = [
      sign({ sub: user.id, role: user.role, ver: null }),
      sign({ sub: user.id, role: user.role, ver: 'x' }),
      sign({ sub: user.id, role: user.role, ver: true }),
      sign({ sub: user.id, role: user.role, ver: 1.5 }),
      sign({ sub: user.id, role: user.role, ver: {} }),
    ];
    for (const token of forged) {
      const res = await api.get('/api/auth/me', token);
      assert.equal(res.status, 401, '被篡改的凭据仍然必须被拒绝');
      assert.equal(res.body.error, '登录已过期，请重新登录');
    }
  });

  it('伪造成更高 / 更低版本号的凭据仍被挡下返回 401', async () => {
    const user = await member('江斯', { dept: '安全' });
    const version = await currentVersion(user.id);
    for (const ver of [version + 5, version - 1, 0, -1]) {
      const res = await api.get('/api/auth/me', sign({ sub: user.id, role: user.role, ver }));
      assert.equal(res.status, 401, `ver=${ver} 必须被拒绝`);
    }
  });

  it('文案分开之后，正常登录的凭据照常可用（拒绝逻辑没有放松也没有误伤）', async () => {
    const user = await member('岑野', { dept: '安全' });
    const token = await api.login(user.email);
    assert.equal((await api.get('/api/auth/me', token)).status, 200);
    assert.equal((await api.get('/api/conversations', token)).status, 200);
  });
});
