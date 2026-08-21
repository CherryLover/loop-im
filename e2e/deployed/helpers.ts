import { expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 账号一律从环境变量读 —— 仓库里不写任何凭据。跑之前先 export，见 README。
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`缺少环境变量 ${k}（见 e2e/deployed/README.md）`);
  return v;
};
export const ADMIN = { name: process.env.ADMIN_NAME || '管理员', email: need('ADMIN_EMAIL'), password: need('ADMIN_PASSWORD') };
export const JIA = { name: process.env.M1_NAME || '测试甲', email: need('M1_EMAIL'), password: need('M1_PASSWORD') };
export const YI = { name: process.env.M2_NAME || '测试乙', email: need('M2_EMAIL'), password: need('M2_PASSWORD') };
export const BING = { name: process.env.M3_NAME || '测试丙', email: need('M3_EMAIL'), password: need('M3_PASSWORD') };

const here = dirname(fileURLToPath(import.meta.url));
// 截图与样本文件都放在 .artifacts 下（.gitignore 已忽略），跑完可以直接看
export const SHOTS = join(here, '.artifacts/shots');
export const FILES = join(here, '.artifacts/files');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(FILES, { recursive: true });

/** 每次运行换一份数据，免得撞上上一轮留下的群名 / 昵称。 */
export const stamp = () => `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

export async function signIn(page: Page, who: { email: string; password: string }, remember = true) {
  await page.goto('/');
  await page.getByLabel('邮箱').fill(who.email);
  await page.getByLabel('密码').fill(who.password);
  if (!remember) {
    const box = page.getByRole('checkbox');
    if (await box.count()) await box.first().uncheck();
  }
  await page.getByRole('button', { name: '登录' }).click();
  // 桌面是左侧 .sidebar（按钮 .nav-btn），手机是底部 .tabbar（按钮 .tab），
  // 两套导航同时在 DOM 里靠 CSS 各自隐藏。用两种布局都有、且都可见的搜索框
  // 作为「已经进到应用里」的信号，才不会把移动端误判成登录失败。
  await expect(page.getByLabel('搜索会话和消息')).toBeVisible({ timeout: 20_000 });
}

export async function createGroup(page: Page, title: string, names: string[]) {
  await page.locator('.nav-btn[title="联系人"]').click();
  await page.locator('.contacts__bar').getByRole('button', { name: '建群' }).click();
  await page.getByPlaceholder('群名称').fill(title);
  for (const name of names) await page.locator('.pick', { hasText: name }).click();
  await page.getByRole('button', { name: /创建并进入/ }).click();
  await expect(page.locator('.chat__title')).toHaveText(title, { timeout: 15_000 });
}

/** 发一条消息并等它真的上屏。 */
export async function send(page: Page, text: string) {
  const composer = page.locator('.composer__input');
  await composer.click();
  await composer.fill(text);
  await page.keyboard.press('Enter');
}

/** 造一张真实 PNG（服务端按 magic number 判定，伪造扩展名没用）。 */
export function makePng(name = 'shot.png') {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3NQREAAAgDINc/9Kzh'
    + 'H0RAM3dvUkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpK6i8HPuKrQBIYYNoAAAAASUVORK5CYII=';
  const p = join(FILES, name);
  writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

export function makePdf(name = 'spec.pdf') {
  const p = join(FILES, name);
  writeFileSync(p, '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return p;
}

export function makeSvg(name = 'evil.svg') {
  const p = join(FILES, name);
  writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  return p;
}

/** 页面上不该出现未捕获错误 —— 顺带盯着控制台。 */
export function watchErrors(page: Page, sink: string[]) {
  page.on('pageerror', (e) => sink.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') sink.push(`console.error: ${m.text()}`); });
}

export async function newSignedInPage(context: BrowserContext, who: { email: string; password: string }) {
  const page = await context.newPage();
  await signIn(page, who);
  return page;
}
