// Every test file imports this FIRST: it points the database at a fresh temp
// directory before src/db.js opens it, so test runs never touch server/data.
// All accounts are created by the tests themselves — nothing is baked into the repo.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'loop-im-test-'));
process.env.JWT_SECRET = 'test-only-secret';
// 打开落库加密，让用例跑的是生产形态那条路径（未配密钥的降级路径另有子进程用例覆盖）。
process.env.ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.ADMIN_NAME = '测试管理员';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.DEMO_USERS = '';
process.env.DEMO_PASSWORD = '';
// 用量限流（src/usage-limit.js）在测试进程里整体抬高。用例做数据准备时会一口气灌
// 一两百条消息、传几十个附件，那是真人不会有的节奏，正好会撞上生产默认值；
// 限流本身不能因此调松，所以调的是测试环境这一侧。
// 真要验限流行为的用例请用 configureUsageLimit() 把某一档临时压低（见 usage-limit.test.js），
// 生产默认值则由 DEFAULT_LIMITS 单独钉住，不受这里影响。
process.env.RATE_MESSAGE_MAX = '100000';
process.env.RATE_AI_MAX = '100000';
process.env.RATE_UPLOAD_MAX = '100000';
process.env.RATE_WRITE_MAX = '100000';

export const ADMIN = process.env.ADMIN_EMAIL;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
export const PASSWORD = 'test-member-password';

/** Boots the API on an ephemeral port with only the admin account. */
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

/** 等一个异步条件成立（SSE 到达、后台任务落库等）。 */
export const waitFor = async (probe, { timeout = 4000, interval = 60 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
};
