import { expect, test } from '@playwright/test';
import { ADMIN, BING, JIA, YI, makePdf, makePng, send, shot, signIn, stamp, watchErrors } from './helpers';

// 每条用例各自登录、互不依赖，所以不用 serial —— 一条失败不该把其余的一起跳过。

const TAG = stamp();
const errors: string[] = [];

/* ────────────────────────────────────────────────────────────────
 * 个人资料弹窗 —— docs/测试用例.md 里点名的「零测试」区域
 * ──────────────────────────────────────────────────────────── */

test('TC-PROFILE-01/02 资料弹窗：改昵称，别人也要看到新名字', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  watchErrors(a, errors); watchErrors(b, errors);

  await signIn(a, BING);
  await signIn(b, ADMIN);

  const newName = `测试丙-${TAG}`;
  await a.locator('.sidebar__me').click();
  await expect(a.locator('.modal__title')).toHaveText('个人资料');
  await shot(a, '20-资料弹窗');

  await a.locator('label.field').filter({ hasText: '昵称' }).locator('input').fill(newName);
  await a.getByRole('button', { name: '保存' }).click();
  // 保存不关弹窗，只在原地给一句「已保存」
  await expect(a.locator('.modal__ok')).toHaveText('已保存', { timeout: 15_000 });
  await a.getByRole('button', { name: '取消' }).click();

  // 另一个人的联系人页应该看到新名字
  await b.locator('.nav-btn[title="联系人"]').click();
  await expect(b.getByText(newName)).toBeVisible({ timeout: 15_000 });
  await shot(b, '21-别人看到新昵称');

  // 改回去，免得影响后面的用例
  await a.locator('.sidebar__me').click();
  await a.locator('label.field').filter({ hasText: '昵称' }).locator('input').fill(BING.name);
  await a.getByRole('button', { name: '保存' }).click();
  await expect(a.locator('.modal__ok')).toHaveText('已保存', { timeout: 15_000 });
  await ctxA.close(); await ctxB.close();
});

test('TC-PROFILE-03/04 头像：能传图片，非图片被拒', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, JIA);
  await page.locator('.sidebar__me').click();

  await page.locator('.modal input[type="file"]').setInputFiles(makePng('avatar.png'));
  await expect(page.locator('.modal__ok')).toHaveText('头像已更新', { timeout: 20_000 });
  const src = await page.locator('.modal img').first().getAttribute('src');
  console.log(`    头像 src：${src}`);
  expect(src).toContain('/uploads/');
  await shot(page, '22-头像已更新');

  // 头像只走图片这一档：PDF 必须被拒
  await page.locator('.modal input[type="file"]').setInputFiles(makePdf('not-image.pdf'));
  await expect(page.locator('.modal__error')).toBeVisible({ timeout: 20_000 });
  console.log(`    非图片头像被拒：「${(await page.locator('.modal__error').innerText()).trim()}」`);
});

test('TC-PROFILE-06/07 主题：切到深色，刷新后仍然是深色', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, JIA);

  const themeNow = () => page.evaluate(() =>
    document.documentElement.getAttribute('data-theme')
    || (document.body.className.match(/dark|light/)?.[0] ?? ''));
  const before = await themeNow();

  await page.locator('.sidebar__me').click();
  await page.locator('.appearance').getByRole('button').click();
  await expect.poll(themeNow, { timeout: 10_000 }).not.toBe(before);
  const after = await themeNow();
  console.log(`    主题：${before} → ${after}`);
  await shot(page, '23-深色主题');

  await page.getByRole('button', { name: '取消' }).click();
  await page.reload();
  await expect(page.getByLabel('搜索会话和消息')).toBeVisible({ timeout: 20_000 });
  expect(await themeNow()).toBe(after);            // 记住了
  await shot(page, '24-刷新后仍是深色');

  // 切回浅色，后面的截图保持一致
  await page.locator('.sidebar__me').click();
  await page.locator('.appearance').getByRole('button').click();
  await page.getByRole('button', { name: '取消' }).click();
});

/* ────────────────────────────────────────────────────────────────
 * 两个浏览器上下文：未读与真实已读回执
 * ──────────────────────────────────────────────────────────── */

test('TC-READ-01/07 未读徽标与已读回执：两个真实浏览器互相看', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();          // 发送方
  const b = await ctxB.newPage();          // 接收方
  watchErrors(a, errors); watchErrors(b, errors);

  await signIn(a, ADMIN);
  await signIn(b, YI);
  // B 先待在联系人页：会话一旦在眼前就会被立刻标已读（这正是 TC-READ-04 的行为），
  // 那样就永远等不到未读徽标了。人不在会话里，才是「未读」该出现的场景。
  await b.locator('.nav-btn[title="联系人"]').click();

  // A 私聊 YI
  await a.locator('.nav-btn[title="联系人"]').click();
  await a.locator('.contact', { hasText: YI.name }).getByRole('button', { name: '去聊天' }).click();
  await expect(a.locator('.chat__title')).toContainText(YI.name, { timeout: 15_000 });

  // 先记下 B 现在的总未读，待会儿断言它涨了（这套环境里本来就有历史未读）
  const navBadge0 = b.locator('.nav-btn[title="会话"] .badge').first();
  const unreadBefore = (await navBadge0.count())
    ? Number((await navBadge0.innerText()).replace(/\D/g, '') || 0)
    : 0;

  const text = `已读回执验证 ${TAG}`;
  await send(a, text);

  // 自己这边先是「已发送」
  const mine = a.locator('[data-mid]', { hasText: text }).last();
  await expect(mine).toContainText('已发送', { timeout: 15_000 });
  await shot(a, '25-已发送');

  // B 停在联系人页，那里根本不渲染会话列表，所以看侧栏「会话」上的总未读徽标 ——
  // 它在任何标签页都可见，正是「人不在会话里也知道有事」的那个东西。
  const navBadge = b.locator('.nav-btn[title="会话"] .badge').first();
  const readBadge = async () => (await navBadge.count())
    ? Number((await navBadge.innerText()).replace(/\D/g, '') || 0)
    : 0;
  await expect.poll(readBadge, { timeout: 25_000 }).toBeGreaterThan(unreadBefore);
  console.log(`    接收方总未读：${unreadBefore} → ${await readBadge()}`);
  await shot(b, '26-未读徽标');

  // B 回到会话页并打开这个会话 → A 的气泡应当变成「已读」
  await b.locator('.nav-btn[title="会话"]').click();
  await b.locator('.convo', { hasText: ADMIN.name }).first().click();
  await expect(mine).toContainText('已读', { timeout: 20_000 });
  await expect(mine).not.toContainText('已发送');
  await shot(a, '27-变成已读');

  await ctxA.close(); await ctxB.close();
});

/* ────────────────────────────────────────────────────────────────
 * 置顶 / 免打扰
 * ──────────────────────────────────────────────────────────── */

test('TC-PREF-01/04 置顶与免打扰：置顶跳到最前，免打扰有明确记号', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);

  // 会话行外面包了一层 .convo-item：.convo 是会话按钮本身，置顶/免打扰是它的兄弟节点
  const rows = page.locator('.convo-item');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const lastTitle = (await rows.last().locator('.convo__title').first().innerText()).trim();

  // 把最后一个会话置顶
  await rows.last().locator(`[aria-label^="置顶"]`).click();
  await expect.poll(async () =>
    (await rows.first().locator('.convo__title').first().innerText()).trim(),
  { timeout: 15_000 }).toBe(lastTitle);
  await expect(page.locator('[aria-label="已置顶"]').first()).toBeVisible();
  await shot(page, '28-置顶');

  // 免打扰。「免打扰不清未读」（TC-PREF-05）需要一个本来就有未读的会话，
  // 由 server/test/conversation-prefs.test.js 与 ChatPage.prefs.test.tsx 覆盖。
  await rows.first().locator('[aria-label^="免打扰"]').click();
  await expect(page.locator('[aria-label="已免打扰"]').first()).toBeVisible({ timeout: 15_000 });
  await shot(page, '29-免打扰');

  // 还原
  await rows.first().locator('[aria-label^="取消免打扰"]').click();
  await rows.first().locator('[aria-label^="取消置顶"]').click();
});

/* ────────────────────────────────────────────────────────────────
 * AI 管理后台已随 Aria 退役整体下线（TC-ADMIN-02~09 删除）；
 * hapi Agent 的管理页上线后由新用例接替。
 * ──────────────────────────────────────────────────────────── */

test('TC-CONTACT-04 普通成员看不到管理入口', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, YI);
  await page.locator('.nav-btn[title="联系人"]').click();
  await expect(page.locator('.contacts__bar').getByRole('button', { name: '添加联系人' })).toHaveCount(0);
  await expect(page.locator('.contacts__bar').getByRole('button', { name: '建群' })).toHaveCount(0);
  // 这里只验「前端没有入口」。「成员直接打管理接口要 403」（TC-CONTACT-05）
  // 是后端的事，由 server/test/auth.test.js 覆盖 —— 前端藏起来 ≠ 安全。
  await shot(page, '35-成员无管理入口');
});

/* ────────────────────────────────────────────────────────────────
 * 管理员的成员管理：添加 / 重置密码 / 停用 / 恢复
 * ──────────────────────────────────────────────────────────── */

test('TC-CONTACT-06/08/09/13 添加联系人、重置密码、停用与恢复', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  await page.locator('.nav-btn[title="联系人"]').click();

  // 添加联系人 → 返回初始密码
  const email = `browser-${TAG}@example.com`;
  await page.locator('.contacts__bar').getByRole('button', { name: '添加联系人' }).click();
  await page.locator('.modal input').nth(0).fill(`浏览器新人${TAG}`);
  await page.locator('.modal input').nth(1).fill(email);
  await page.locator('.modal input').nth(2).fill('测试');
  await page.getByRole('button', { name: /添加|创建|确定/ }).last().click();
  await expect(page.locator('.modal__ok, .modal')).toContainText(/初始密码|密码/, { timeout: 15_000 });
  await shot(page, '36-添加联系人');
  await page.getByRole('button', { name: /关闭|完成|取消/ }).last().click();
  await expect(page.locator('.contact', { hasText: `浏览器新人${TAG}` })).toBeVisible({ timeout: 15_000 });

  const row = page.locator('.contact', { hasText: `浏览器新人${TAG}` });

  // 重置密码
  await row.locator(`[title^="重置"]`).click();
  await page.getByRole('button', { name: /重置|确定/ }).last().click();
  await expect(page.locator('.modal')).toContainText(/新密码|密码/, { timeout: 15_000 });
  await shot(page, '37-重置密码');
  await page.getByRole('button', { name: /关闭|完成|取消/ }).last().click();

  // 停用
  await row.locator(`[title^="停用"]`).click();
  await page.getByRole('button', { name: /停用|确定/ }).last().click();
  await expect(row).toContainText(/已停用|停用/, { timeout: 15_000 });
  await shot(page, '38-已停用');

  // 停用的人不进建群名单
  await page.locator('.contacts__bar').getByRole('button', { name: '建群' }).click();
  await expect(page.locator('.pick', { hasText: `浏览器新人${TAG}` })).toHaveCount(0);
  console.log('    停用的人确实不在建群可选名单里 ✅');
  await page.getByRole('button', { name: /取消|关闭/ }).last().click();

  // 恢复
  await row.locator(`[title^="恢复"]`).click();
  await page.getByRole('button', { name: /恢复|确定/ }).last().click();
  await expect(row).not.toContainText('已停用', { timeout: 15_000 });
  await shot(page, '39-已恢复');
});

/* ────────────────────────────────────────────────────────────────
 * 响应式
 * ──────────────────────────────────────────────────────────── */

test('TC-UI-02 移动端：底部标签栏，会话列表与详情互相切换', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  watchErrors(page, errors);

  await signIn(page, ADMIN);
  // 手机布局：底部标签栏出现，桌面侧栏隐藏
  await expect(page.locator('.tabbar')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.sidebar')).toBeHidden();
  await shot(page, '40-移动端会话列表');

  await page.locator('.convo').first().click();
  await expect(page.locator('.chat__title')).toBeVisible({ timeout: 15_000 });
  await shot(page, '41-移动端会话详情');

  // 返回键回到列表
  const back = page.locator('.chat__back, [aria-label="返回"]').first();
  if (await back.count()) {
    await back.click();
    await expect(page.locator('.convo').first()).toBeVisible({ timeout: 10_000 });
    await shot(page, '42-移动端返回列表');
  }
  await ctx.close();
});

test('浏览器里没有未捕获错误', async () => {
  // 只有 pageerror（未捕获的 JS 异常）才算真问题。
  // console.error 里那些是预期噪音：负向用例故意打出的 401/400，
  // 以及每个用例结束关闭页面时 SSE 长连接被切断的 ERR_CONNECTION_RESET。
  const uncaught = errors.filter((e) => e.startsWith('pageerror:'));
  const noisy = errors.filter((e) => !e.startsWith('pageerror:'));
  console.log(`    未捕获异常：${uncaught.length ? JSON.stringify(uncaught, null, 2) : '无'}`);
  console.log(`    （预期内的网络层 console.error：${noisy.length} 条，多为关页面时 SSE 断开）`);
  expect(uncaught).toEqual([]);
});
