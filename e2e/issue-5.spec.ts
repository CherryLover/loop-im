import { expect, test, type Page } from '@playwright/test';
import { ADMIN, MEMBERS } from './accounts';

const MOBILE = { width: 390, height: 812 };

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('邮箱').fill(who.email);
  await page.getByLabel('密码', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: '登录' }).click();
}

// 联系人页里的建群弹窗：填名字、勾成员、点「创建并进入」。
async function createGroup(page: Page, title: string, names: string[]) {
  await page.locator('.contacts__bar').getByRole('button', { name: '建群' }).click();
  await page.getByPlaceholder('群名称').fill(title);
  for (const name of names) await page.locator('.pick', { hasText: name }).click();
  await page.getByRole('button', { name: /创建并进入/ }).click();
}

test('手机端：建群成功后直接进入新群', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await signIn(page, ADMIN);
  await expect(page.locator('.tabbar')).toBeVisible();

  await page.locator('.tab', { hasText: '联系人' }).click();
  await createGroup(page, '手机建群 · 立即进入', [MEMBERS[0].name, MEMBERS[1].name]);

  // 验收：标题、系统欢迎消息、输入框、返回按钮都在，会话列表让位给聊天详情。
  await expect(page.locator('.chat__title')).toHaveText('手机建群 · 立即进入');
  await expect(page.locator('.bubble--ai').last()).toContainText('群聊已创建');
  await expect(page.locator('.composer__input')).toBeVisible();
  await expect(page.locator('.chat__back')).toBeVisible();
  await expect(page.locator('.convos')).toBeHidden();

  // 验收：返回列表后新群仍在，且仍是选中态。
  await page.locator('.chat__back').click();
  await expect(page.locator('.convos')).toBeVisible();
  await expect(page.locator('.convo--on')).toContainText('手机建群 · 立即进入');
});

test('桌面端：建群成功后仍然直接进入新群', async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.locator('.sidebar')).toBeVisible();

  await page.locator('.nav-btn[title="联系人"]').click();
  await createGroup(page, '桌面建群 · 立即进入', [MEMBERS[0].name, MEMBERS[2].name]);

  await expect(page.locator('.chat__title')).toHaveText('桌面建群 · 立即进入');
  await expect(page.locator('.convos')).toBeVisible();
  await expect(page.locator('.members__row')).toHaveCount(4);   // 建群人 + 2 名成员 + Aria
});
