import { defineConfig, devices } from '@playwright/test';
import { ADMIN, MEMBERS, MEMBER_PASSWORD } from './accounts';

const PORT = Number(process.env.E2E_PORT || 4100);

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
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
      DATA_DIR: process.env.E2E_DATA_DIR || './.tmp-data',
      JWT_SECRET: 'e2e-only-secret',
      ADMIN_NAME: ADMIN.name,
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
      DEMO_USERS: MEMBERS.map((m) => `${m.name}:${m.email}:${m.dept}`).join(','),
      DEMO_PASSWORD: MEMBER_PASSWORD,
    },
  },
});
