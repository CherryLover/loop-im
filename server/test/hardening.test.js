// 仓库是公开的：这些守卫保证「照着 README 部署」不会带着已知密钥或已知账号上线。
import './helpers.js';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const freshDataDir = () => mkdtempSync(join(tmpdir(), 'loop-im-boot-'));

/** 用一个干净的子进程启动服务，拿到启动日志或启动失败的原因。 */
async function boot(env) {
  const script = "import('./src/index.js').then(() => setTimeout(() => process.exit(0), 300));";
  const blank = { JWT_SECRET: '', ADMIN_NAME: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', DEMO_USERS: '', DEMO_PASSWORD: '' };
  try {
    const { stdout } = await run('node', ['--input-type=module', '--eval', script], {
      cwd: serverDir,
      env: { ...process.env, ...blank, DATA_DIR: freshDataDir(), PORT: '0', ...env },
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr || err.message) };
  }
}

describe('公开部署的安全默认值', () => {
  it('生产环境没有 JWT_SECRET 时拒绝启动', async () => {
    const res = await boot({ NODE_ENV: 'production' });
    assert.equal(res.ok, false);
    assert.match(res.stderr, /必须设置 JWT_SECRET/);
  });

  it('没有配置管理员时不会凭空造一个账号', async () => {
    const res = await boot({ NODE_ENV: 'production', JWT_SECRET: 'a-real-secret' });
    assert.equal(res.ok, true);
    assert.match(res.stdout, /未配置 ADMIN_EMAIL \/ ADMIN_PASSWORD/);
  });

  it('配置了就创建管理员，且日志里不出现密码', async () => {
    const res = await boot({
      NODE_ENV: 'production', JWT_SECRET: 'a-real-secret',
      ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'a-real-admin-password',
    });
    assert.equal(res.ok, true);
    assert.match(res.stdout, /已创建管理员 boss@example\.com/);
    assert.ok(!res.stdout.includes('a-real-admin-password'));
  });

  it('本地联系人只在 DEMO_USERS 与 DEMO_PASSWORD 都给了的时候创建', async () => {
    const withoutPassword = await boot({ JWT_SECRET: 's', DEMO_USERS: '张三:zhang@example.com:产品' });
    assert.ok(!withoutPassword.stdout.includes('本地联系人'));

    const complete = await boot({
      JWT_SECRET: 's', DEMO_USERS: '张三:zhang@example.com:产品,李四:li@example.com:研发',
      DEMO_PASSWORD: 'local-only-password',
    });
    assert.match(complete.stdout, /已创建 2 位本地联系人/);
    assert.ok(!complete.stdout.includes('local-only-password'));
  });
});
