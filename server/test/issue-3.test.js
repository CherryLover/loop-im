import { startServer, ADMIN, ADMIN_PASSWORD } from './helpers.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

let api;
before(async () => { api = await startServer(); });
after(async () => { await api.close(); });

/** token 的有效期（天），由 exp - iat 推出。 */
const tokenLifeDays = (token) => {
  const { iat, exp } = jwt.decode(token);
  return (exp - iat) / 86400;
};

describe('保持登录开关（issue #3）', () => {
  it('不勾选保持登录时，token 只发会话有效期，不发 15 天', async () => {
    const res = await api.post('/api/auth/login', { email: ADMIN, password: ADMIN_PASSWORD, remember: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenDays, 1);
    assert.equal(tokenLifeDays(res.body.token), 1);
  });

  it('勾选保持登录时仍是 15 天', async () => {
    const res = await api.post('/api/auth/login', { email: ADMIN, password: ADMIN_PASSWORD, remember: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenDays, 15);
    assert.equal(tokenLifeDays(res.body.token), 15);
  });

  it('老客户端不带 remember 时按 15 天处理', async () => {
    const res = await api.post('/api/auth/login', { email: ADMIN, password: ADMIN_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenDays, 15);
    assert.equal(tokenLifeDays(res.body.token), 15);
  });

  it('会话 token 一样能通过鉴权', async () => {
    const login = await api.post('/api/auth/login', { email: ADMIN, password: ADMIN_PASSWORD, remember: false });
    const me = await api.get('/api/auth/me', login.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, ADMIN);
  });
});
