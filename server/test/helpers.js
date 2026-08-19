// Every test file imports this FIRST: it points the database at a fresh temp
// directory before src/db.js opens it, so test runs never touch server/data.
// All accounts are created by the tests themselves — nothing is baked into the repo.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'loop-im-test-'));
process.env.JWT_SECRET = 'test-only-secret';
process.env.ADMIN_NAME = '测试管理员';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.DEMO_USERS = '';
process.env.DEMO_PASSWORD = '';

export const ADMIN = process.env.ADMIN_EMAIL;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
export const PASSWORD = 'test-member-password';

/** Boots the API on an ephemeral port with only the AI account and the admin. */
export async function startServer() {
  const { createApp } = await import('../src/app.js');
  const { bootstrap } = await import('../src/bootstrap.js');
  bootstrap();

  const server = createApp({ serveClient: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { token, body, form } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: form || (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const login = async (email, password = PASSWORD) => {
    const res = await call('POST', '/api/auth/login', { body: { email, password } });
    if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
    return res.body.token;
  };

  return {
    baseUrl,
    call,
    login,
    loginAdmin: () => login(ADMIN, ADMIN_PASSWORD),
    get: (path, token) => call('GET', path, { token }),
    post: (path, body, token) => call('POST', path, { body, token }),
    put: (path, body, token) => call('PUT', path, { body, token }),
    patch: (path, body, token) => call('PATCH', path, { body, token }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The AI reply is produced after the POST responds; give it a moment to land. */
export const waitFor = async (probe, { timeout = 4000, interval = 60 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
};
