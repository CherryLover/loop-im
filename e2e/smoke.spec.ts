import { expect, test, type Page } from '@playwright/test';
import { ADMIN, MEMBERS, MEMBER_PASSWORD } from './accounts';

// 会写库的用例每次执行都换一份数据：同一次运行里失败重试时不会撞上上一次留下的
// 邮箱或群名，断言也就还能按“新建成功”来写。
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('邮箱').fill(who.email);
  await page.getByLabel('密码', { exact: true }).fill(who.password);
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

test('管理员：建群 → @提及成员 → 消息实时可见', async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.getByText('已上线 · 与服务器保持连接')).toBeVisible();

  await createGroup(page, `产品 · 发版协作 ${stamp()}`, [MEMBERS[0].name, MEMBERS[1].name]);
  // Aria 退役：新群只有建群人 + 选中的成员，没有 AI，也没有欢迎消息。
  await expect(page.locator('.members__row')).toHaveCount(3);
  await expect(page.locator('.bubble--ai')).toHaveCount(0);

  const composer = page.locator('.composer__input');
  await composer.click();
  await composer.type('@');
  await expect(page.getByText('提及 · ↑↓ 选择，Enter 确认')).toBeVisible();
  await page.keyboard.press('ArrowDown');                              // @全员 → 第一位成员
  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue(`@${MEMBERS[0].name} `);

  await composer.type('回归测试只留 1 天，接口 2 项未完成，周五能发版吗？');
  await page.keyboard.press('Enter');
  await expect(page.locator('.bubble--me').last()).toContainText('周五能发版吗？');
});

test('管理员：添加联系人后对方出现在列表里', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.locator('.nav-btn[title="联系人"]').click();
  // locator.count() 是一次性的，**不会**像 expect 那样自动重试。刚点完导航时联系人
  // 列表可能还没渲染出来（它等的是挂载时那次 refreshUsers()），这时基数会被读成 0，
  // 后面 toHaveCount(before + 1) 就变成了「期望 1、实际 6」——症状看着像数量算错，
  // 其实是基数取早了。先等列表真的出现，再取基数。
  await expect(page.locator('.contact').first()).toBeVisible();
  const before = await page.locator('.contact').count();
  const mark = stamp();
  const name = `吴思${mark}`;
  const email = `e2e-wu-${mark}@example.test`;

  await page.locator('.contacts__bar').getByRole('button', { name: '添加联系人' }).click();
  await page.getByPlaceholder('如：吴思').fill(name);
  await page.getByPlaceholder('name@loop.dev').fill(email);
  await page.getByPlaceholder('如：运营').fill('运营');
  await page.locator('.modal').getByRole('button', { name: '添加', exact: true }).click();

  await expect(page.getByText(`已开通 ${name}，初始密码`)).toBeVisible();
  await page.getByRole('button', { name: '完成' }).click();
  await expect(page.locator('.contact')).toHaveCount(before + 1);
  await expect(page.locator('.contact', { hasText: name })).toContainText(email);
});

test('普通成员：没有任何管理入口，可以和同事私聊', async ({ page }) => {
  await signIn(page, { email: MEMBERS[0].email, password: MEMBER_PASSWORD });

  await expect(page.locator('.nav-btn')).toHaveCount(2);
  await expect(page.locator('.convos__head').getByRole('button')).toHaveCount(0);

  await page.locator('.nav-btn[title="联系人"]').click();
  await expect(page.locator('.contacts__bar button')).toHaveCount(0);
  // Aria 退役：联系人列表里不再出现 AI 成员。
  await expect(page.locator('.contact', { hasText: 'Aria' })).toHaveCount(0);

  await page.locator('.contact', { hasText: MEMBERS[1].name }).getByRole('button', { name: '去聊天' }).click();
  await page.locator('.composer__input').fill('帮我看下今天的排期结论');
  await page.keyboard.press('Enter');
  await expect(page.locator('.bubble--me').last()).toContainText('排期结论');
});

test('深色主题与移动端布局', async ({ page }) => {
  await signIn(page, ADMIN);

  // 先自己开一条和成员的私聊：这条用例只看布局，不该依赖前面的建群用例留下的会话。
  await page.locator('.nav-btn[title="联系人"]').click();
  await page.locator('.contact', { hasText: MEMBERS[0].name }).getByRole('button', { name: '去聊天' }).click();
  await expect(page.locator('.convo').first()).toBeVisible();

  await page.locator('.sidebar__me').click();
  await page.locator('.appearance button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 812 });
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();

  // 刚从联系人进来的私聊在手机端是展开状态（#4）：先验证详情与返回键，
  // 再退回列表、重新点进去，确认两个方向都对。
  await expect(page.locator('.chat__back')).toBeVisible();
  await expect(page.locator('.members')).toBeHidden();
  await page.locator('.chat__back').click();
  await expect(page.locator('.convo').first()).toBeVisible();
  await page.locator('.convo').first().click();
  await expect(page.locator('.chat__back')).toBeVisible();
});

test('主题跟随系统：没手动选过就实时跟随，手动选过才固定', async ({ page }) => {
  // 旧 bug：首次加载把「按系统算出的颜色」写进 localStorage，从第二次访问起系统再怎么
  // 切换都纹丝不动。所以这条用例的关键不是首屏颜色对不对，而是「切换 + 刷新」之后还跟不跟。
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // 页面开着时系统切浅色 → 实时跟上
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // 刷新（= 第二次访问）后依然跟随系统，而不是被首次的结果钉死
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // 手动切换过之后就固定：系统再变也不跟随，刷新后记忆还在
  await signIn(page, ADMIN);
  await page.locator('.sidebar__me').click();
  await page.locator('.appearance button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Escape');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
