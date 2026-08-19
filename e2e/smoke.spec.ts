import { expect, test, type Page } from '@playwright/test';
import { ADMIN, MEMBERS, MEMBER_PASSWORD } from './accounts';

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('邮箱').fill(who.email);
  await page.getByLabel('密码').fill(who.password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
}

async function createGroup(page: Page, title: string, names: string[]) {
  await page.locator('.nav-btn[title="联系人"]').click();
  await page.locator('.contacts__bar').getByRole('button', { name: '建群' }).click();
  await page.getByPlaceholder('群名称').fill(title);
  for (const name of names) await page.locator('.pick', { hasText: name }).click();
  await page.getByRole('button', { name: /创建并进入/ }).click();
  await expect(page.locator('.chat__title')).toHaveText(title);
}

test('管理员：建群 → @Aria 拿到回复 → AI 管理看到这个人', async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.getByText('已上线 · 与服务器保持连接')).toBeVisible();

  await createGroup(page, '产品 · 发版协作', [MEMBERS[0].name, MEMBERS[1].name]);
  await expect(page.locator('.members__row')).toHaveCount(4);          // 建群人 + 2 名成员 + Aria
  await expect(page.locator('.bubble--ai').last()).toContainText('群聊已创建');

  const composer = page.locator('.composer__input');
  await composer.click();
  await composer.type('@');
  await expect(page.getByText('提及 · ↑↓ 选择，Enter 确认')).toBeVisible();
  await page.keyboard.press('ArrowDown');                              // @全员 → Aria
  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue('@Aria ');

  await composer.type('回归测试只留 1 天，接口 2 项未完成，周五能发版吗？');
  await page.keyboard.press('Enter');
  await expect(page.locator('.bubble--me').last()).toContainText('周五能发版吗？');
  await expect(page.locator('.bubble--ai').last()).toContainText('已收到提及', { timeout: 15_000 });

  await page.locator('.nav-btn[title="AI 管理"]').click();
  await expect(page.getByText('今日被 @ 次数')).toBeVisible();
  await page.locator('.table__row', { hasText: ADMIN.name }).click();
  await expect(page.getByText('AI 推导 · 沟通偏好与习惯')).toBeVisible();
  await expect(page.locator('.chip', { hasText: '回归测试只留 1 天' }).first()).toBeVisible();

  await page.getByRole('button', { name: /查看详细/ }).click();
  await expect(page.getByText('原始对话记录')).toBeVisible();

  await page.getByRole('button', { name: '返回列表' }).click();
  await page.getByRole('button', { name: 'AI 配置' }).click();
  await page.locator('.provider', { hasText: 'xAI Grok' }).click();
  await page.getByRole('button', { name: '测试连通性' }).click();
  await expect(page.locator('.test-result')).toBeVisible();
});

test('管理员：添加联系人后对方出现在列表里', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.locator('.nav-btn[title="联系人"]').click();
  const before = await page.locator('.contact').count();

  await page.locator('.contacts__bar').getByRole('button', { name: '添加联系人' }).click();
  await page.getByPlaceholder('如：吴思').fill('吴思');
  await page.getByPlaceholder('name@loop.dev').fill('e2e-wu@example.test');
  await page.getByPlaceholder('如：运营').fill('运营');
  await page.locator('.modal').getByRole('button', { name: '添加', exact: true }).click();

  await expect(page.getByText(/已开通 吴思，初始密码/)).toBeVisible();
  await page.getByRole('button', { name: '完成' }).click();
  await expect(page.locator('.contact')).toHaveCount(before + 1);
  await expect(page.locator('.contact', { hasText: '吴思' })).toContainText('e2e-wu@example.test');
});

test('普通成员：没有管理入口，可以直接和 Aria 私聊', async ({ page }) => {
  await signIn(page, { email: MEMBERS[0].email, password: MEMBER_PASSWORD });

  await expect(page.locator('.nav-btn')).toHaveCount(2);
  await expect(page.locator('.nav-btn[title="AI 管理"]')).toHaveCount(0);
  await expect(page.locator('.convos__head').getByRole('button')).toHaveCount(0);

  await page.locator('.nav-btn[title="联系人"]').click();
  await expect(page.locator('.contacts__bar button')).toHaveCount(0);
  await expect(page.locator('.contact', { hasText: 'Aria' })).toContainText('常驻在线');

  await page.locator('.contact', { hasText: 'Aria' }).getByRole('button', { name: '去聊天' }).click();
  await page.locator('.composer__input').fill('帮我总结今天的排期结论');
  await page.keyboard.press('Enter');
  await expect(page.locator('.bubble--ai').last()).toContainText('收到', { timeout: 15_000 });
});

test('深色主题与移动端布局', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.locator('.sidebar__me').click();
  await page.locator('.appearance button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 812 });
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.locator('.convo').first().click();
  await expect(page.locator('.chat__back')).toBeVisible();
  await expect(page.locator('.members')).toBeHidden();
});
