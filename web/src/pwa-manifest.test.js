// PWA 外壳的静态闸门：manifest、图标、index.html 里的三个标签。
//
// 这些东西全都**只有真机能看出坏没坏**——manifest 少一个字段、图标文件名写错、
// viewport 少一段，浏览器一律静默降级：不报错、不白屏、typecheck 和 build 全绿，
// 只是 iPhone 上「添加到主屏幕」出来的东西不对，或者通知整条链路收不到。
// 所以把这些事实钉在这里。
//
// 写成 .js 而不是 .ts 是有意的，理由同 styles-integrity.test.js：tsconfig 的 include
// 只覆盖 src 且没开 allowJs，所以 tsc 不检查这个文件，也就不必为了一个 node:fs 的
// import 去给 web 装 @types/node。vitest 的 include 照常收 .js。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// 不用 import.meta.url：vitest 转换后的模块里它不是 file: scheme，fileURLToPath 会抛。
// vitest 的 root 是 web/，所以按 cwd 找；带一个上层候选，免得有人从仓库根跑。
const find = (rel) => ['', 'web/']
  .map((prefix) => resolve(process.cwd(), prefix + rel))
  .find(existsSync);

const PUBLIC_DIR = 'public/';
const MANIFEST_PATH = find(`${PUBLIC_DIR}manifest.webmanifest`);
const INDEX_PATH = find('index.html');

/** manifest 里的 "/icons/icon-192.png" → 磁盘上的 web/public/icons/icon-192.png */
const publicFile = (src) => find(PUBLIC_DIR + src.replace(/^\//, ''));

/**
 * 从 PNG 头里读宽高。
 *
 * PNG 的前 8 字节是固定签名，紧接着的第一个块必须是 IHDR（规范强制它排第一）：
 *   [8..12) 长度  [12..16) "IHDR"  [16..20) 宽（大端 u32）  [20..24) 高
 * 只要 24 字节就够了，不用为此拉一个图片库进来。
 */
function pngSize(path) {
  const buf = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buf.subarray(0, 8).equals(signature), `${path} 不是 PNG（签名对不上）`).toBe(true);
  expect(buf.subarray(12, 16).toString('ascii'), `${path} 的第一个块不是 IHDR`).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('PWA manifest', () => {
  it('是合法 JSON', () => {
    expect(MANIFEST_PATH, '找不到 web/public/manifest.webmanifest').toBeTruthy();
    expect(() => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))).not.toThrow();
  });

  // ↓↓↓ 整个文件里最要紧的一条 ↓↓↓
  it('display 必须是 standalone 或 fullscreen —— 这是 iOS 通知的开关，不是外观选项', () => {
    // MDN 浏览器兼容数据对 iOS Safari 的 Notification 接口原文：
    //
    //   "The `Notification` interface is undefined, unless the page is a web app saved
    //    to the home screen. The app's manifest must have a non-default `display` value."
    //
    // 默认值是 "browser"。所以 display 一旦是 browser（或者干脆没有 manifest），
    // iOS 上连 `Notification` 这个**标识符**都不存在：notify.ts 的
    // `typeof Notification !== 'undefined'` 直接落到 'unsupported'，权限申请发不出去，
    // 推送订阅更无从谈起。整条链路静默死掉，没有任何报错。
    //
    // WebKit 的说法一致：manifest "with its `display` member set to `standalone` or
    // `fullscreen`"。
    //   https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
    //
    // 换句话说：**改这个字段不是换个观感，是关掉 iPhone / iPad 上的全部通知。**
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(['standalone', 'fullscreen']).toContain(manifest.display);
  });

  it('id / start_url / scope 都在', () => {
    // id 不给的话浏览器拿 start_url 当 id，将来改 start_url 会被当成另一个 App
    // （用户主屏上多出一个图标，旧的那个变成僵尸）。scope 要和 SW 的 scope 对齐。
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('不锁 orientation —— iPad 是目标设备，横屏用得很多', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(manifest.orientation).toBeUndefined();
  });

  it('声明了 192、512 和一张 maskable', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((icon) => (icon.purpose || '').split(/\s+/).includes('maskable'))).toBe(true);
  });

  it('icons 里声明的每个文件都真的存在，且尺寸和声明的一致', () => {
    // 文件名写错、尺寸和 sizes 对不上，浏览器都是**静默忽略那一张**，
    // 装到主屏就变成网页截图或者一个模糊的图标。
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const path = publicFile(icon.src);
      expect(path, `manifest 声明了 ${icon.src}，但 web/public 下没有这个文件`).toBeTruthy();
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(path), `${icon.src} 的实际尺寸和 sizes="${icon.sizes}" 对不上`)
        .toEqual({ width: w, height: h });
    }
  });

  it('maskable 那张和普通 512 不是同一张图 —— 安全区不同，不能拿一张顶两张', () => {
    // maskable 的安全区是中心 80% 的圆，主体必须缩进去、四周留可被裁掉的出血区；
    // purpose:any 那张则要铺满。同一张图必然有一边是错的：要么普通图标缩水留白边，
    // 要么 maskable 被 Android 的圆形/水滴遮罩把气泡尾巴切掉。
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const pick = (wantMaskable) => manifest.icons.find((icon) => icon.sizes === '512x512'
      && (icon.purpose || '').split(/\s+/).includes('maskable') === wantMaskable);
    const plain = pick(false);
    const maskable = pick(true);
    expect(plain, '没有 512 的 purpose:any 图标').toBeTruthy();
    expect(maskable, '没有 512 的 maskable 图标').toBeTruthy();
    expect(maskable.src).not.toBe(plain.src);
    expect(readFileSync(publicFile(maskable.src)).equals(readFileSync(publicFile(plain.src))))
      .toBe(false);
  });

  it('apple-touch-icon.png 存在且是 180×180', () => {
    // iOS 主屏专用。WebKit：两个都提供时 apple-touch-icon 优先于 manifest 的 icons。
    const path = publicFile('/apple-touch-icon.png');
    expect(path, '找不到 web/public/apple-touch-icon.png').toBeTruthy();
    expect(pngSize(path)).toEqual({ width: 180, height: 180 });
  });
});

describe('index.html 的 PWA 标签', () => {
  const html = () => readFileSync(INDEX_PATH, 'utf8');

  it('有 manifest 的 link', () => {
    expect(INDEX_PATH, '找不到 web/index.html').toBeTruthy();
    expect(html()).toMatch(/<link[^>]*rel="manifest"[^>]*href="\/manifest\.webmanifest"/);
  });

  it('有 180×180 的 apple-touch-icon link', () => {
    expect(html()).toMatch(/<link[^>]*rel="apple-touch-icon"[^>]*sizes="180x180"[^>]*href="\/apple-touch-icon\.png"/);
  });

  it('有 theme-color，且和 manifest 的 theme_color 一致', () => {
    const match = html().match(/<meta[^>]*name="theme-color"[^>]*content="([^"]+)"/);
    expect(match, 'index.html 里没有 theme-color').toBeTruthy();
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(match[1].toUpperCase()).toBe(manifest.theme_color.toUpperCase());
  });

  it('viewport 含 viewport-fit=cover —— 少了它，安全区适配整套失效', () => {
    // 这是 1A 与 1B 之间唯一的接口契约：不加 viewport-fit=cover，iOS 上
    // env(safe-area-inset-*) 恒为 0，styles.css 里那套 calc(... + env(...)) 全部退化成
    // 原来的固定值，底部导航会被 Home 指示条盖住。桌面上看不出任何异常。
    const match = html().match(/<meta[^>]*name="viewport"[^>]*content="([^"]+)"/);
    expect(match, 'index.html 里没有 viewport').toBeTruthy();
    expect(match[1]).toContain('viewport-fit=cover');
  });

  it('有 apple-mobile-web-app-capable —— 16.4 之前靠它进独立模式', () => {
    expect(html()).toMatch(/<meta[^>]*name="apple-mobile-web-app-capable"[^>]*content="yes"/);
  });
});
