import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, MEMBERS, MEMBER_PASSWORD } from './accounts';

const here = dirname(fileURLToPath(import.meta.url));

// 端口：默认让系统分配一个空闲端口，固定端口会被上一轮没退干净的进程或并行的另一份
// e2e 占住，导致下一次直接起不来。同样只在主进程算一次写回 process.env，
// worker 继承同一个值，baseURL 才不会和实际起的服务对不上。想固定就设 E2E_PORT。
if (!process.env.E2E_PORT) {
  const probe = "const s = require('node:net').createServer();"
    + "s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port)); s.close(); });";
  process.env.E2E_PORT = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim();
}
const PORT = Number(process.env.E2E_PORT);

// 数据隔离：每次运行都在 e2e/.tmp-data 下开一个全新的目录（绝对路径），跑完由
// globalTeardown 删掉，上一轮建的账号、会话不会残留到下一轮影响断言。
// 这段只在主进程执行一次（worker 会重新加载本文件，但继承到的 E2E_DATA_DIR 已有值），
// 清理范围也只限 e2e 自己的临时目录，不会碰 server/data 里的开发数据。
const TMP_ROOT = join(here, '.tmp-data');
let dataDir = process.env.E2E_DATA_DIR;
if (!dataDir) {
  rmSync(TMP_ROOT, { recursive: true, force: true }); // 上次异常退出遗留的目录一并清掉
  mkdirSync(TMP_ROOT, { recursive: true });
  dataDir = mkdtempSync(join(TMP_ROOT, 'run-'));
  process.env.E2E_DATA_DIR = dataDir;
  process.env.E2E_DATA_DIR_OWNED = dataDir; // 外部指定的目录不归我们删
}
const DATA_DIR = dataDir;

export default defineConfig({
  testDir: '.',
  // deployed/ 那一套是打到「已经部署好的实例」上的，有自己的 config 和
  // `npm run test:deployed`，而且 import 时就要求 ADMIN_EMAIL / ADMIN_PASSWORD。
  // testDir: '.' 会递归扫到它，于是普通 CI 一跑就在收集阶段炸掉 —— 必须排除。
  testIgnore: '**/deployed/**',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  // Boots the real server against a throwaway database. The accounts below exist
  // only for this run — the application ships without any built-in users.
  webServer: {
    command: 'node ../server/src/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DATA_DIR,
      JWT_SECRET: 'e2e-only-secret',
      ADMIN_NAME: ADMIN.name,
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
      DEMO_USERS: MEMBERS.map((m) => `${m.name}:${m.email}:${m.dept}`).join(','),
      DEMO_PASSWORD: MEMBER_PASSWORD,
    },
  },
});
