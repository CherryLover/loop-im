// Issue #11 回归：手机端登录提示（Toast）不能遮挡右上角按钮，也不能截获点击。
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN, MEMBERS } from './accounts';

const MOBILE = { width: 390, height: 812 };
const LONG_ERROR = '服务暂时不可用：会话服务在 3 次重试后仍未响应，请稍后再试，或联系管理员检查后端日志与网络连通性。';

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.getByLabel('邮箱').fill(who.email);
  await page.getByLabel('密码').fill(who.password);
  await page.getByRole('button', { name: '登录' }).click();
}

/** 两个矩形是否有交叠。用于验证提示没有盖住按钮。 */
function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

interface Rect { x: number; y: number; width: number; height: number }

async function boxOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  expect(box, '元素应当可见并有尺寸').not.toBeNull();
  return box as Rect;
}

/** 命中测试：按钮中心点上真正接收点击的元素，必须还是这个按钮。 */
async function hitAtCenter(page: Page, locator: Locator) {
  const box = await boxOf(locator);
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    const btn = el?.closest('button');
    return { tag: el?.tagName ?? 'none', cls: el?.className ?? '', btn: btn?.textContent ?? '' };
  }, [box.x + box.width / 2, box.y + box.height / 2]);
}

test('移动端：登录提示不遮挡「建群」，也不吃掉它的点击', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await signIn(page, ADMIN);

  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  const createGroup = page.locator('.convos__head').getByRole('button', { name: '建群' });
  await expect(createGroup).toBeVisible();

  // 1) 视觉上不重叠
  expect(overlaps(await boxOf(toast), await boxOf(createGroup)), '提示不应覆盖「建群」按钮').toBe(false);

  // 2) 点击不被截获：按钮中心的命中元素仍是按钮本身
  expect((await hitAtCenter(page, createGroup)).btn, '点击应落在按钮上，而不是提示上').toContain('建群');

  // 3) 提示还在的时候一次点开建群弹窗（超时很短，避免"等提示消失再点中"的假通过）
  await expect(toast).toBeVisible();
  await createGroup.click({ timeout: 1000 });
  await expect(page.getByPlaceholder('群名称')).toBeVisible();
});

test('移动端：联系人页的「添加联系人 / 建群」不被提示遮挡', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await signIn(page, ADMIN);
  await expect(page.locator('.toast')).toBeHidden({ timeout: 10_000 });

  await page.locator('.tabbar').getByRole('button', { name: '联系人' }).click();
  const bar = page.locator('.contacts__bar');
  await expect(bar).toBeVisible();

  // 造一个错误提示：发起私聊失败会弹出 toast，且长文案更容易越界。
  await page.route('**/api/conversations/direct', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: LONG_ERROR }) }),
  );
  await page.locator('.contact', { hasText: MEMBERS[0].name }).getByRole('button', { name: '去聊天' }).click();

  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  const toastBox = await boxOf(toast);
  expect(toastBox.x, '长提示不能越出左边界').toBeGreaterThanOrEqual(0);
  expect(toastBox.x + toastBox.width, '长提示不能越出右边界').toBeLessThanOrEqual(MOBILE.width);
  for (const name of ['添加联系人', '建群']) {
    const btn = bar.getByRole('button', { name });
    expect(overlaps(toastBox, await boxOf(btn)), `提示不应覆盖「${name}」`).toBe(false);
    expect((await hitAtCenter(page, btn)).btn, `点击应落在「${name}」上`).toContain(name);
  }
});

test('移动端：长提示不越界，也不压住输入框与底部导航', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await signIn(page, ADMIN);

  // 建一个群，才能拿到输入框
  await page.locator('.convos__head').getByRole('button', { name: '建群' }).click({ timeout: 1000 });
  await page.getByPlaceholder('群名称').fill('Issue 11 回归群');
  for (const m of [MEMBERS[0], MEMBERS[1]]) await page.locator('.pick', { hasText: m.name }).click();
  await page.getByRole('button', { name: /创建并进入/ }).click();
  await page.locator('.convo', { hasText: 'Issue 11 回归群' }).click();   // 移动端要点进会话才有输入框
  await expect(page.locator('.composer__input')).toBeVisible();

  // 发送失败 → 长错误提示
  await page.route('**/api/conversations/*/messages', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: LONG_ERROR }) })
      : route.continue(),
  );
  await page.locator('.composer__input').fill('回归测试');
  await page.keyboard.press('Enter');

  const toast = page.locator('.toast');
  await expect(toast).toContainText('服务暂时不可用');
  const toastBox = await boxOf(toast);

  expect(toastBox.x, '不能越出左边界').toBeGreaterThanOrEqual(0);
  expect(toastBox.x + toastBox.width, '不能越出右边界').toBeLessThanOrEqual(MOBILE.width);
  expect(toastBox.y, '不能越出上边界').toBeGreaterThanOrEqual(0);
  expect(toastBox.y + toastBox.height, '不能越出下边界').toBeLessThanOrEqual(MOBILE.height);

  expect(overlaps(toastBox, await boxOf(page.locator('.composer'))), '提示不应压住输入栏').toBe(false);
  expect(overlaps(toastBox, await boxOf(page.locator('.tabbar'))), '提示不应压住底部导航').toBe(false);
  expect((await hitAtCenter(page, page.locator('.composer__send'))).btn, '点击应落在「发送」上').toContain('发送');
});

test('桌面端：提示仍固定在右上角', async ({ page }) => {
  await page.goto('/');
  await signIn(page, ADMIN);

  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  const box = await boxOf(toast);
  const viewport = page.viewportSize()!;
  expect(box.y).toBeLessThan(60);
  expect(viewport.width - (box.x + box.width)).toBeLessThan(30);
});
