import { expect, test } from '@playwright/test';
import { ADMIN, JIA, YI, createGroup, makePdf, makePng, makeSvg, send, shot, signIn, stamp, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

const TAG = stamp();
const GROUP = `浏览器验证 ${TAG}`;
const errors: string[] = [];

test('TC-AUTH-02 密码错误：给出提示，且不透露邮箱是否存在', async ({ page }) => {
  watchErrors(page, errors);
  await page.goto('/');
  await page.getByLabel('邮箱').fill(ADMIN.email);
  await page.getByLabel('密码').fill('definitely-wrong');
  await page.getByRole('button', { name: '登录' }).click();
  const err = page.locator('.login__error, .modal__error, [role="alert"]').first();
  await expect(err).toBeVisible({ timeout: 10_000 });
  const text = await err.innerText();
  console.log(`    登录失败提示：「${text.trim()}」`);
  expect(text).not.toMatch(/不存在|未注册|no such user/i);
  await shot(page, '01-登录失败提示');
});

test('TC-AUTH-01 登录成功：进入应用并显示已上线', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  await expect(page.getByText('已上线 · 与服务器保持连接')).toBeVisible({ timeout: 15_000 });
  await shot(page, '02-登录成功');
});

test('TC-GROUP-01/09 建群：直接进新群，Aria 默认在群里，留下系统提示', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  await createGroup(page, GROUP, [JIA.name, YI.name]);
  // 建群人 + 2 名成员 + Aria
  await expect(page.locator('.members__row')).toHaveCount(4);
  await expect(page.locator('.bubble--ai').last()).toContainText('群聊已创建');
  await shot(page, '03-建群成功');
});

test('TC-CHAT-02/03 Markdown 渲染与 XSS：该渲染的渲染，该转义的转义', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  await page.locator('.convo', { hasText: GROUP }).first().click();

  await send(page, '**加粗** 和 `行内代码`，还有列表：\n- 第一项\n- 第二项');
  const bubble = page.locator('.bubble--me').last();
  await expect(bubble.locator('strong')).toHaveText('加粗');
  await expect(bubble.locator('code')).toHaveText('行内代码');
  await expect(bubble.locator('li')).toHaveCount(2);

  // javascript: 链接必须不可点
  await send(page, '危险链接 [点我](javascript:alert(1))');
  const evil = page.locator('.bubble--me').last();
  const hrefs = await evil.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') || ''));
  console.log(`    渲染出的 href：${JSON.stringify(hrefs)}`);
  expect(hrefs.some((h) => h.toLowerCase().startsWith('javascript:'))).toBe(false);
  await shot(page, '04-markdown渲染');
});

test('TC-ATTACH-01/02 附件：图片内联显示，PDF 是文件卡片而不是内联', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, JIA);
  await page.locator('.convo', { hasText: GROUP }).first().click();

  // 图片：真的走 <input type=file>，和人点回形针选文件是同一条路
  await page.locator('input[type="file"]').first().setInputFiles(makePng());
  // 等附件真的上传完（输入框上方出现「已上传」那一行）再发
  await expect(page.locator('.attach__name')).toHaveText('shot.png');
  await expect(page.locator('.attach__state')).toHaveText('已上传，将作为图片附件发送', { timeout: 20_000 });
  await page.locator('.composer__send').click();
  const img = page.locator('.bubble--me').last().locator('img');
  await expect(img).toBeVisible({ timeout: 15_000 });
  // 图片必须真的加载出来（naturalWidth>0），否则只是个坏图标
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);
  console.log(`    图片 src：${await img.getAttribute('src')}`);
  await shot(page, '05-图片内联');

  // PDF：应该是可下载的文件卡片，不内联
  await page.locator('input[type="file"]').first().setInputFiles(makePdf());
  await expect(page.locator('.attach__name')).toHaveText('spec.pdf');
  await expect(page.locator('.attach__state')).toHaveText('已上传，将作为文件附件发送', { timeout: 20_000 });
  await page.locator('.composer__send').click();
  const fileBubble = page.locator('.bubble--me').last();
  await expect(fileBubble).toContainText('spec.pdf', { timeout: 15_000 });
  await expect(fileBubble.locator('img')).toHaveCount(0);
  await shot(page, '06-文件卡片');
});

test('TC-ATTACH-05 SVG 被拒：界面上要给出明确提示', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, JIA);
  await page.locator('.convo', { hasText: GROUP }).first().click();
  await page.locator('input[type="file"]').first().setInputFiles(makeSvg());
  // 被拒时错误就显示在附件行的状态位上
  const state = page.locator('.attach__state');
  await expect(state).toBeVisible({ timeout: 15_000 });
  await expect(state).not.toHaveText(/上传中/, { timeout: 15_000 });
  const msg = (await state.innerText()).trim();
  console.log(`    SVG 拒绝提示：「${msg}」`);
  expect(msg).toMatch(/SVG|不支持|安全/);
  // 而且不能给发出去
  await expect(page.locator('.composer__send')).toBeDisabled();
  await shot(page, '07-SVG被拒');
});

test('TC-CHAT-09 @ 提及气泡：↑↓ 选择，Enter 确认', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  await page.locator('.convo', { hasText: GROUP }).first().click();
  const composer = page.locator('.composer__input');
  await composer.click();
  await composer.pressSequentially('@');
  await expect(page.getByText('提及 · ↑↓ 选择，Enter 确认')).toBeVisible({ timeout: 10_000 });
  await shot(page, '08-提及气泡');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue('@Aria ');
  await page.keyboard.press('Escape');
});

test('TC-AI-01 群里 @Aria：出现输入中，然后拿到回复', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  await page.locator('.convo', { hasText: GROUP }).first().click();
  const before = await page.locator('.bubble--ai').count();

  const composer = page.locator('.composer__input');
  await composer.click();
  await composer.pressSequentially('@');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await composer.pressSequentially('这个群现在进度怎么样？');
  await page.keyboard.press('Enter');

  await expect(page.locator('.bubble--ai')).toHaveCount(before + 1, { timeout: 25_000 });
  await expect(page.locator('.bubble--ai').last()).toContainText('已收到提及');
  await shot(page, '09-AI回复');
});

test('TC-REACT-01/02 表情回应：点 👍 出现计数，再点取消', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  await page.locator('.convo', { hasText: GROUP }).first().click();

  const target = page.locator('.msg--me').last();
  await target.hover();
  await target.getByRole('button', { name: '添加表情回应' }).click();
  await page.getByRole('menuitem', { name: '用 👍 回应' }).click();   // 表情项是 menuitem，不是 button

  const chip = target.getByRole('button', { name: /^👍 1 人/ });
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await shot(page, '10-表情回应');

  await chip.click();                                   // 再点一次取消
  await expect(target.getByRole('button', { name: /^👍/ })).toHaveCount(0, { timeout: 10_000 });
});

test('TC-REPLY-01/03/04 引用回复：带摘要发出，点引用块跳回原消息', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  await page.locator('.convo', { hasText: GROUP }).first().click();

  const quoted = `被引用的锚点消息 ${TAG}`;
  await send(page, quoted);
  const anchor = page.locator('[data-mid]', { hasText: quoted }).last();

  await anchor.hover();
  await anchor.getByRole('button', { name: /引用回复/ }).click();
  await expect(page.getByRole('button', { name: '取消引用' })).toBeVisible();
  await shot(page, '11-引用态');

  await send(page, '这是对上面那条的回复');
  const replyBubble = page.locator('[data-mid]').last();
  await expect(replyBubble).toContainText(quoted.slice(0, 10), { timeout: 10_000 });

  await replyBubble.getByTitle('跳到被引用的消息').click();
  await expect(anchor).toBeInViewport({ timeout: 10_000 });
  await shot(page, '12-引用跳回');
});

test('TC-SEARCH-01/02 搜索框：同时搜到会话和消息', async ({ page }) => {
  watchErrors(page, errors);
  await signIn(page, ADMIN);
  const box = page.getByLabel('搜索会话和消息');
  await box.fill(`被引用的锚点消息 ${TAG}`);
  await expect(page.getByText(/消息 · \d+/)).toBeVisible({ timeout: 15_000 });
  await shot(page, '13-搜索结果');

  await box.fill(GROUP);
  await expect(page.locator('.convo', { hasText: GROUP }).first()).toBeVisible();
});

test('页面自始至终没有未捕获错误', async () => {
  // 前面每个用例都挂了 pageerror / console.error 监听，汇总在这里断言
  // 只有 pageerror（未捕获的 JS 异常）才算真问题。
  // console.error 里那些是预期噪音：负向用例故意打出的 401/400，
  // 以及每个用例结束关闭页面时 SSE 长连接被切断的 ERR_CONNECTION_RESET。
  const uncaught = errors.filter((e) => e.startsWith('pageerror:'));
  const noisy = errors.filter((e) => !e.startsWith('pageerror:'));
  console.log(`    未捕获异常：${uncaught.length ? JSON.stringify(uncaught, null, 2) : '无'}`);
  console.log(`    （预期内的网络层 console.error：${noisy.length} 条，多为关页面时 SSE 断开）`);
  expect(uncaught).toEqual([]);
});
