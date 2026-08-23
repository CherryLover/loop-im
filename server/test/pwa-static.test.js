// 任务包 1E：静态托管的 MIME、缓存与 SPA catch-all（server/src/app.js 末尾那段）。
//
// PWA 的三个入口文件（index.html / sw.js / manifest.webmanifest）都从这段代码出去，
// 而这段代码出的错全都是「200 但内容不对」这一类 —— 浏览器报的错和真正的原因隔着两层，
// 线上排查极贵。所以四条防线各有一条用例钉着：
//
//   1. sw.js 必须 no-cache        —— 缓存住了就再也换不掉 SW，所有后续更新一起卡死；
//   2. .webmanifest 的 Content-Type —— 靠 express → send → mime-types 这条**传递依赖**，
//      现成是对的，但没人守着的话升级 express 会静默坏掉。iOS 认错类型的症状是
//      「装到主屏之后还是没有通知」，跟 MIME 一点关系都看不出来；
//   3. 文件不存在时 catch-all 不许拿 index.html 顶包 —— 200 的假 JS 比 404 难查十倍；
//   4. 普通前端路由仍然回 index.html —— 上一条别把 SPA 路由一起挡死。
//
// **关于「临时 dist 目录」**：sw.js / manifest.webmanifest 是任务包 1D / 1A 的产物，
// 本用例一个都不依赖，也不依赖 `npm run build` 有没有跑过 —— 它自己在 tmp 下造一个
// dist，写进内容由自己定的同名文件，再用 `createApp({ clientDist })` 指过去。
// 跑的是**同一段** express.static + catch-all 代码，只是喂给它的目录换了个位置。
// 这样「本地过、CI 挂」或者反过来都不会发生：两边跑的输入完全一样。
//
// 另外两组是**对照组**：/uploads 和 /api 的响应头必须和没有静态托管时逐字相同。
// /uploads 那组头是 issue #22 的防线（强制下载 + nosniff + private 缓存），
// 唯一权威是 src/attachments.js 的 setUploadHeaders。对照组由两半组成，各管一件事：
//
//   · **同一个请求打两个 app**（一个开着静态托管、一个关着）逐个头对比 ——
//     管的是「静态托管这一段有没有漏到那两条路径上去」。
//     ⚠️ 它的边界要说清楚：createApp 里**两个 app 都会执行**的改动（比如在顶部加一条
//     全局中间件）两边一样变，这个对比看不出来。它只覆盖 serveClient 分支内的改动。
//   · **绝对值断言** —— 把 setUploadHeaders 那组头逐个钉死。上面那半只能证明「两边一样」，
//     万一两边一起坏了照样绿；这半条管的就是那种情况。
//
// 再加一条 catch-all 的排除清单：`/api` 和 `/uploads` 从排除列表里掉出去，
// 那两条路径下**路由没匹配上**的请求就会被 index.html 兜成 200，各有一条用例盯着。
import { startServer } from './helpers.js';
import { PDF, PNG } from './samples.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const SW_SOURCE = "// 1E 的测试替身，不是 1D 的真 sw.js。\nself.addEventListener('install', () => {});\n";
const MANIFEST_SOURCE = JSON.stringify({ name: 'Loop IM', display: 'standalone' });
const INDEX_SOURCE = '<!doctype html><html><head><title>Loop IM</title></head><body><div id="root"></div></body></html>';

/** 造一个临时 dist。`full: false` 时故意不放 sw.js / manifest —— 模拟「忘了跑构建」。 */
function makeDist({ full = true } = {}) {
  const dist = mkdtempSync(join(tmpdir(), 'loop-im-dist-'));
  writeFileSync(join(dist, 'index.html'), INDEX_SOURCE);
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'index-abc12345.js'), 'export const x = 1;\n');
  if (full) {
    writeFileSync(join(dist, 'sw.js'), SW_SOURCE);
    writeFileSync(join(dist, 'manifest.webmanifest'), MANIFEST_SOURCE);
  }
  return dist;
}

/** 起一个开着静态托管的 app，指向给定的 dist。 */
async function startStaticServer(clientDist) {
  const { createApp } = await import('../src/app.js');
  const server = createApp({ serveClient: true, clientDist }).listen(0);
  await new Promise((r) => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

let api;          // 常规 app（serveClient: false），登录 / 上传都走它
let served;       // 静态托管 + 完整 dist
let bare;         // 静态托管 + 缺 sw.js 和 manifest 的 dist
let token;

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
  served = await startStaticServer(makeDist());
  bare = await startStaticServer(makeDist({ full: false }));
});

after(async () => {
  await api.close();
  await served.close();
  await bare.close();
});

describe('PWA 静态托管 · sw.js 的缓存头', () => {
  it('/sw.js 带 Cache-Control: no-cache —— 不许被缓存住', async () => {
    const res = await fetch(`${served.base}/sw.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  it('不是 no-store：no-store 会让每次启动都整份重下，换不来任何新鲜度', async () => {
    const res = await fetch(`${served.base}/sw.js`);
    assert.doesNotMatch(res.headers.get('cache-control'), /no-store/);
  });

  it('/sw.js 的 Content-Type 是 JavaScript，内容是那个文件本身', async () => {
    const res = await fetch(`${served.base}/sw.js`);
    assert.match(res.headers.get('content-type'), /^(text|application)\/javascript\b/);
    assert.equal(await res.text(), SW_SOURCE);
  });

  it('其余静态资源的缓存行为**没有**被带着一起改（Vite 产物带 hash，现状够用）', async () => {
    const res = await fetch(`${served.base}/assets/index-abc12345.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=0', 'express.static 的默认值，不该被 setHeaders 波及');
  });
});

describe('PWA 静态托管 · manifest 的 MIME', () => {
  // 这条依赖 express → send → mime-types → mime-db 这串传递依赖里
  // `.webmanifest → application/manifest+json` 的映射。现成就是对的，代码一行没改，
  // 这条用例存在的唯一理由是「哪天升级 express 让它静默坏掉时有人喊一声」。
  it('/manifest.webmanifest 的 Content-Type 是 application/manifest+json', async () => {
    const res = await fetch(`${served.base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    const type = res.headers.get('content-type');
    assert.equal(type.split(';')[0].trim(), 'application/manifest+json', `实际拿到 ${type}`);
    assert.equal(await res.text(), MANIFEST_SOURCE);
  });
});

describe('PWA 静态托管 · catch-all 不许拿 index.html 顶包', () => {
  // 注意断言的是**状态码和正文**，不是 Content-Type：express 默认的 404 页面本来就是
  // text/html，那不是问题。问题是「200 + 一份货真价实的 index.html」。
  it('构建产物里没有 sw.js 时 → 404，不是 200 的 index.html', async () => {
    const res = await fetch(`${bare.base}/sw.js`);
    assert.equal(res.status, 404, '兜成 200 的话浏览器只会报一句看不懂的 unsupported MIME type');
    assert.notEqual(await res.text(), INDEX_SOURCE);
  });

  it('构建产物里没有 manifest.webmanifest 时 → 404，不是 200 的 index.html', async () => {
    const res = await fetch(`${bare.base}/manifest.webmanifest`);
    assert.equal(res.status, 404);
    assert.notEqual(await res.text(), INDEX_SOURCE);
  });

  it('不存在的 .js 资源 → 404，正文不是 index.html', async () => {
    const res = await fetch(`${served.base}/assets/does-not-exist-99999999.js`);
    assert.equal(res.status, 404);
    assert.notEqual(await res.text(), INDEX_SOURCE);
  });

  it('（对照组）dist 里真有的那个 hash 产物照常 200', async () => {
    const res = await fetch(`${served.base}/assets/index-abc12345.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
  });

  it('（对照组）普通前端路由仍然返回 index.html —— 上一条没把 SPA 路由挡死', async () => {
    for (const path of ['/chat/c_abc123', '/settings', '/']) {
      const res = await fetch(`${served.base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /text\/html/, path);
      assert.equal(await res.text(), INDEX_SOURCE, path);
    }
  });

  it('（对照组）sw.js 存在时照常 200 —— 排除规则只影响「文件不存在」这一种情况', async () => {
    assert.equal((await fetch(`${served.base}/sw.js`)).status, 200);
    assert.equal((await fetch(`${served.base}/manifest.webmanifest`)).status, 200);
  });
});

// 一次响应里由这段静态托管代码之外的东西决定、每次都不一样的头，比对时排掉。
const VOLATILE = new Set(['date', 'x-request-id', 'connection', 'keep-alive', 'etag', 'last-modified']);

const stableHeaders = (res) => {
  const out = {};
  for (const [k, v] of res.headers) if (!VOLATILE.has(k)) out[k] = v;
  return out;
};

/** 同一个请求打两个 app（开/关静态托管），返回两份可比对的响应头。 */
async function bothWays(path, init) {
  const [withStatic, withoutStatic] = await Promise.all([
    fetch(`${served.base}${path}`, init),
    fetch(`${api.baseUrl}${path}`, init),
  ]);
  return { withStatic, withoutStatic };
}

describe('PWA 静态托管 · /uploads 的响应头逐字未变（issue #22 的防线）', () => {
  let imageUrl, fileUrl;

  before(async () => {
    const form = (buf, filename, type) => {
      const f = new FormData();
      f.append('file', new Blob([buf], { type }), filename);
      return f;
    };
    const img = await api.call('POST', '/api/uploads', { token, form: form(PNG, 'a.png', 'image/png') });
    assert.equal(img.status, 201);
    imageUrl = img.body.url;
    const doc = await api.call('POST', '/api/uploads', { token, form: form(PDF, 'a.pdf', 'application/pdf') });
    assert.equal(doc.status, 201);
    fileUrl = doc.body.url;
  });

  const withToken = (url) => `${url}?token=${encodeURIComponent(token)}`;

  it('图片附件：开着静态托管和关着，响应头逐字相同', async () => {
    const { withStatic, withoutStatic } = await bothWays(withToken(imageUrl));
    assert.equal(withStatic.status, 200);
    assert.deepEqual(stableHeaders(withStatic), stableHeaders(withoutStatic));
  });

  it('普通文件附件：同样逐字相同（强制下载那一档）', async () => {
    const { withStatic, withoutStatic } = await bothWays(withToken(fileUrl));
    assert.equal(withStatic.status, 200);
    assert.deepEqual(stableHeaders(withStatic), stableHeaders(withoutStatic));
  });

  it('那组头本身仍然是 setUploadHeaders 说了算的那一组', async () => {
    // 逐字对比只能证明「两边一样」，万一两边一起坏了就看不出来。这条钉死绝对值。
    const res = await fetch(`${served.base}${withToken(fileUrl)}`);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-disposition'), 'attachment');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');

    const img = await fetch(`${served.base}${withToken(imageUrl)}`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(img.headers.get('content-disposition'), null, '图片是内联的，不该被加上下载头');
  });

  it('未登录仍然 401，没有被静态层或 catch-all 兜走', async () => {
    const { withStatic, withoutStatic } = await bothWays(imageUrl);
    assert.equal(withStatic.status, 401);
    assert.equal(withoutStatic.status, 401);
    assert.deepEqual(stableHeaders(withStatic), stableHeaders(withoutStatic));
  });

  it('/uploads 下路由没匹配上的路径也不会变成 index.html', async () => {
    // `/uploads/:key` 匹配不上两段的路径，于是它会一路落到 catch-all 手里。
    // catch-all 的排除列表里一旦少了 /uploads，这里就是 200 + 一份 index.html ——
    // 一个本该 404 的附件地址返回了网页，而且是同源的。
    //
    // **必须带凭据**：`/uploads` 那个 router 顶上是 router.use(authenticate)，
    // 不带 token 的话它自己就 401 了，根本走不到 catch-all，这条用例会变成一条
    // 永远绿的废用例（验证过：去掉排除项后，不带 token 仍是 401，带了才暴露成 200）。
    // 而且路径末段 `b` 不带扩展名，所以也绕不过去 —— 挡住它的只可能是排除列表本身。
    const res = await fetch(`${served.base}/uploads/a/b?token=${encodeURIComponent(token)}`);
    assert.notEqual(res.status, 200);
    assert.notEqual(await res.text(), INDEX_SOURCE);
  });
});

describe('PWA 静态托管 · /api 的行为逐字未变', () => {
  it('/api/health 的响应头和正文两边相同', async () => {
    const { withStatic, withoutStatic } = await bothWays('/api/health');
    assert.equal(withStatic.status, 200);
    assert.deepEqual(stableHeaders(withStatic), stableHeaders(withoutStatic));
    assert.equal(await withStatic.text(), await withoutStatic.text());
  });

  it('需要鉴权的接口仍然 401，不会被 catch-all 换成 index.html', async () => {
    const { withStatic, withoutStatic } = await bothWays('/api/conversations');
    assert.equal(withStatic.status, 401);
    assert.deepEqual(stableHeaders(withStatic), stableHeaders(withoutStatic));
  });

  // 这一条盯的是 catch-all 排除列表里的 /api：掉出去的话，任何拼错的接口地址都会
  // 拿到 200 + index.html，前端 JSON.parse 一份 HTML，报的错和真实原因隔着十万八千里。
  it('不存在的 /api 路径两边都是 404，正文都不是 index.html', async () => {
    const { withStatic, withoutStatic } = await bothWays('/api/no-such-route');
    assert.equal(withStatic.status, 404);
    assert.equal(withoutStatic.status, 404);
    assert.notEqual(await withStatic.text(), INDEX_SOURCE);
  });
});
