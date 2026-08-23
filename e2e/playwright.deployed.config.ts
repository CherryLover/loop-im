import { defineConfig, devices } from '@playwright/test';

/**
 * 打一个**已经跑起来的**部署（Docker、测试机、预发），不自己起服务。
 *
 * 和同目录的 playwright.config.ts 是两回事：那一份每次开一个临时数据库、
 * 自己拉起 server，跑的是「代码对不对」；这一份跑的是「这套部署对不对」——
 * 真实对象存储、真实回源、真实浏览器渲染，都是单测和 jsdom 够不着的地方。
 *
 * 它会往目标环境写数据（建群、发消息、加联系人），所以**只指向测试环境**。
 *
 *   BASE=http://127.0.0.1:4000 \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   M1_EMAIL=... M1_PASSWORD=... M2_EMAIL=... M2_PASSWORD=... M3_EMAIL=... M3_PASSWORD=... \
 *   npm run test:deployed
 */
export default defineConfig({
  testDir: './deployed',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: './deployed/.artifacts/traces',
  use: {
    baseURL: process.env.BASE || 'http://127.0.0.1:4000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});
