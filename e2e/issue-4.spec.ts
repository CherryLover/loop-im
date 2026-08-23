import { expect, test, type Page } from '@playwright/test';
import { MEMBERS, MEMBER_PASSWORD } from './accounts';

// issue #4：手机端从联系人点「去聊天」后停留在会话列表，必须再点一次会话才能聊天。
const MOBILE = { width: 390, height: 812 };

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('邮箱').fill(who.email);
  await page.getByLabel('密码', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: '登录' }).click();
}

// 联系人页的「去聊天」按钮（移动端从底部 tab 进入）。
async function chatWithFromContacts(page: Page, name: string) {
  await page.locator('.tab', { hasText: '联系人' }).click();
  await page.locator('.contact', { hasText: name }).getByRole('button', { name: '去聊天' }).click();
}

test.describe('移动端：联系人 → 去聊天', () => {
  test.use({ viewport: MOBILE });

  test('新私聊与已有私聊都直接进入会话详情，返回键回到列表', async ({ page }) => {
    await signIn(page, { email: MEMBERS[0].email, password: MEMBER_PASSWORD });
    await expect(page.locator('.tabbar')).toBeVisible();
    await expect(page.locator('.convos')).toBeVisible();

    // 首次登录不应该自动展开某个会话，仍然停留在会话列表。
    await expect(page.locator('.composer__input')).toBeHidden();

    // 新私聊：点「去聊天」后应当直接看到标题、输入框和返回键。
    await chatWithFromContacts(page, MEMBERS[1].name);
    await expect(page.locator('.chat__title')).toBeVisible();
    await expect(page.locator('.chat__title')).toHaveText(MEMBERS[1].name);
    await expect(page.locator('.composer__input')).toBeVisible();
    await expect(page.locator('.chat__back')).toBeVisible();
    await expect(page.locator('.convos')).toBeHidden();

    // 返回键回到会话列表。
    await page.locator('.chat__back').click();
    await expect(page.locator('.convos')).toBeVisible();
    await expect(page.locator('.composer__input')).toBeHidden();

    // 已有私聊：再点一次「去聊天」同样直接进入。
    await chatWithFromContacts(page, MEMBERS[1].name);
    await expect(page.locator('.chat__title')).toHaveText(MEMBERS[1].name);
    await expect(page.locator('.composer__input')).toBeVisible();

    // 从会话列表点条目也仍然能进入详情。
    await page.locator('.chat__back').click();
    await page.locator('.convo', { hasText: MEMBERS[1].name }).click();
    await expect(page.locator('.composer__input')).toBeVisible();
    await expect(page.locator('.convos')).toBeHidden();
  });
});

test('桌面端：联系人「去聊天」行为不变，会话列表与详情同时可见', async ({ page }) => {
  await signIn(page, { email: MEMBERS[2].email, password: MEMBER_PASSWORD });
  await expect(page.locator('.sidebar')).toBeVisible();

  await page.locator('.nav-btn[title="联系人"]').click();
  await page.locator('.contact', { hasText: MEMBERS[0].name }).getByRole('button', { name: '去聊天' }).click();

  await expect(page.locator('.chat__title')).toHaveText(MEMBERS[0].name);
  await expect(page.locator('.convos')).toBeVisible();
  await expect(page.locator('.composer__input')).toBeVisible();
});
