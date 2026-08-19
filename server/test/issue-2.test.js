import './helpers.js';
// issue #2：改密码后，改密码之前签发的旧凭据必须立即失效。
import { startServer, ADMIN_PASSWORD, PASSWORD } from './helpers.js';
import { member } from './fixtures.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');

let api;
before(async () => { api = await startServer(); });
after(async () => { await api.close(); });

describe('改密码后旧凭据失效（issue #2）', () => {
  it('两个会话中任一方改密码，另一端的旧凭据访问受保护接口返回 401', async () => {
    const user = await member('林一诺', { dept: '安全' });
    const tokenA = await api.login(user.email);
    const tokenB = await api.login(user.email);
    assert.equal((await api.get('/api/auth/me', tokenB)).status, 200);

    const changed = await api.post('/api/auth/me/password', { current: PASSWORD, next: 'issue2-newpass' }, tokenA);
    assert.equal(changed.status, 200);

    for (const path of ['/api/auth/me', '/api/users', '/api/conversations']) {
      assert.equal((await api.get(path, tokenB)).status, 401, `${path} 应该拒绝旧凭据`);
    }
    assert.equal((await api.post('/api/auth/ping', {}, tokenB)).status, 401);
  });

  it('改密码的设备拿到新凭据，可以继续访问', async () => {
    const user = await member('周予安', { dept: '安全' });
    const token = await api.login(user.email);
    const changed = await api.post('/api/auth/me/password', { current: PASSWORD, next: 'issue2-newpass' }, token);
    assert.equal(changed.status, 200);
    assert.ok(changed.body.token, '改密码接口应返回新凭据');
    assert.notEqual(changed.body.token, token);
    assert.equal((await api.get('/api/auth/me', changed.body.token)).status, 200);
    assert.equal((await api.get('/api/auth/me', token)).status, 401);
  });

  it('旧密码不能登录，新密码可以登录，且新凭据可用', async () => {
    const user = await member('何知远', { dept: '安全' });
    const token = await api.login(user.email);
    await api.post('/api/auth/me/password', { current: PASSWORD, next: 'issue2-newpass' }, token);
    assert.equal((await api.post('/api/auth/login', { email: user.email, password: PASSWORD })).status, 401);
    const again = await api.post('/api/auth/login', { email: user.email, password: 'issue2-newpass' });
    assert.equal(again.status, 200);
    assert.equal((await api.get('/api/auth/me', again.body.token)).status, 200);
  });

  it('管理员改密码后，旧凭据也用不了管理员功能', async () => {
    const adminToken = await api.loginAdmin();
    const created = await api.post('/api/users', { name: '吴思', email: 'wusi@test.local', dept: '运营' }, adminToken);
    assert.equal(created.status, 201);

    const changed = await api.post('/api/auth/me/password', { current: ADMIN_PASSWORD, next: 'issue2-admin-pass' }, adminToken);
    assert.equal(changed.status, 200);
    const blocked = await api.post('/api/users', { name: '钱多', email: 'qianduo@test.local', dept: '运营' }, adminToken);
    assert.equal(blocked.status, 401);

    // 换回原密码，避免影响别的用例
    await api.post('/api/auth/me/password', { current: 'issue2-admin-pass', next: ADMIN_PASSWORD }, changed.body.token);
  });

  it('没有版本号、伪造版本号、旧版本号的凭据都会被拒绝', async () => {
    const user = await member('苏见月', { dept: '安全' });
    const { get } = await import('../src/db.js');
    const version = get('SELECT * FROM users WHERE id = ?', user.id).auth_version || 1;
    const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15d' });

    const tokens = [
      sign({ sub: user.id, role: user.role }),                  // 没有版本号
      sign({ sub: user.id, role: user.role, ver: version + 5 }), // 伪造的更高版本
      sign({ sub: user.id, role: user.role, ver: version - 1 }), // 更旧的版本
      sign({ sub: user.id, role: user.role, ver: 'x' }),         // 类型不对
    ];
    for (const token of tokens) {
      assert.equal((await api.get('/api/auth/me', token)).status, 401);
    }
    assert.equal((await api.get('/api/auth/me', await api.login(user.email))).status, 200);
  });

  it('老库（没有 auth_version 列）能直接启动，用户与消息都还在', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'loop-im-legacy-'));
    const legacySchema = readFileSync(join(serverDir, 'src', 'schema.sql'), 'utf8')
      .split('\n').filter((line) => !line.includes('auth_version')).join('\n');
    const legacy = new DatabaseSync(join(dataDir, 'loop.db'));
    legacy.exec(legacySchema);
    legacy.exec(`
      INSERT INTO users (id, name, email, dept, role, password_hash, last_seen_at, created_at)
        VALUES ('u_old', '老用户', 'old@test.local', '成员', 'member', 'hash', 0, 1);
      INSERT INTO conversations (id, type, title, created_by, created_at)
        VALUES ('c_old', 'group', '老群', 'u_old', 1);
      INSERT INTO messages (id, conversation_id, sender_id, body, mentions, created_at)
        VALUES ('m_old', 'c_old', 'u_old', '历史消息', '[]', 1);
    `);
    legacy.close();

    const script = "import('./src/db.js').then(({ get }) => console.log(JSON.stringify({"
      + " user: get('SELECT * FROM users WHERE id = ?', 'u_old'),"
      + " message: get('SELECT body FROM messages WHERE id = ?', 'm_old') })));";
    const { stdout } = await execFileAsync('node', ['--input-type=module', '--eval', script], {
      cwd: serverDir,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    const out = JSON.parse(stdout);
    assert.equal(out.user.name, '老用户');
    assert.equal(out.user.auth_version, 1);
    assert.equal(out.message.body, '历史消息');
  });
});
