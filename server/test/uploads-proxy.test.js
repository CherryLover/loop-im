/**
 * /uploads 从 express.static 换成了 Express 代理（对象可能在只对内网开放的 MinIO 里）。
 *
 * 这个文件只做一件事：**逐条**锁住 issue #22 那组安全头在换实现之后一个字都没变。
 * 换存储最容易犯的错就是让浏览器直连对象存储 —— 那样这些头会全部消失，
 * 一份 HTML 附件会被 MinIO 按自己的 Content-Type 返回，存储型 XSS 当场复活。
 *
 * 为了确保验的是「代理这条路径」而不是「碰巧本地磁盘还在」，这里**强制走对象存储分支**：
 * S3_BUCKET 设上、store 注入成内存实现、本地回落关掉。所以下面每一个字节都是
 * 从「对象存储」里取出来、由 Express 加上头之后发出来的。
 */
import { startServer, PASSWORD } from './helpers.js';
import { GIF, HTML, JPEG, PNG, SVG, TEXT, WEBP, ZIP } from './samples.js';
import { createMemoryStore } from '../src/object-store.js';
import { __setStoreForTest, resetStore } from '../src/storage.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token, store;

const upload = (buffer, { filename = 'x.bin', type = 'application/octet-stream' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  return api.call('POST', '/api/uploads', { token, form });
};

const fetchUpload = (url, as = token) =>
  fetch(`${api.baseUrl}${url}${as ? `?token=${encodeURIComponent(as)}` : ''}`);

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
  // 走对象存储那条路：桶名一设，getDriver() 立刻变成 's3'（延迟求值）。
  process.env.S3_BUCKET = 'loop-im-test';
  process.env.UPLOADS_LOCAL_FALLBACK = '0';       // 关掉本地回落，杜绝「其实读的是磁盘」
  store = createMemoryStore();
  __setStoreForTest(store);
});

after(async () => {
  delete process.env.S3_BUCKET;
  delete process.env.UPLOADS_LOCAL_FALLBACK;
  resetStore();
  await api.close();
});

describe('/uploads 代理 · 对象确实来自对象存储', () => {
  it('上传之后对象在 store 里，本地磁盘那条路已经关掉', async () => {
    const res = await upload(PNG, { filename: 'a.png', type: 'image/png' });
    assert.equal(res.status, 201);
    assert.equal(res.body.storage, 's3');
    const key = res.body.url.replace('/uploads/', '');
    assert.ok(store.objects.has(key), '对象应当落在对象存储里');

    const served = await fetchUpload(res.body.url);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  });
});

describe('/uploads 代理 · HTML 内容的对象仍然一个字不差地强制下载', () => {
  it('八股三件套：application/octet-stream + attachment + nosniff，外加 CSP', async () => {
    const { body } = await upload(HTML, { filename: 'steal.html', type: 'text/html' });
    const served = await fetchUpload(body.url);

    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    assert.equal(served.headers.get('content-disposition'), 'attachment');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(served.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    // Content-Type 里连 html 字样都不许出现。
    assert.doesNotMatch(served.headers.get('content-type'), /html/i);
    // 内容原样保存：附件功能得真的可用，危险的只是「被当网页渲染」。
    assert.equal(Buffer.from(await served.arrayBuffer()).toString('utf8'), HTML.toString('utf8'));
  });

  it('其它非图片附件同样一律 octet-stream + attachment', async () => {
    for (const [label, buffer, filename, type] of [
      ['ZIP', ZIP, '交付物.zip', 'application/zip'],
      ['纯文本', TEXT, 'note.txt', 'text/plain'],
    ]) {
      const { body } = await upload(buffer, { filename, type });
      const served = await fetchUpload(body.url);
      assert.equal(served.headers.get('content-type'), 'application/octet-stream', label);
      assert.equal(served.headers.get('content-disposition'), 'attachment', label);
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff', label);
    }
  });

  it('SVG 在上传口就被拒，根本进不了对象存储', async () => {
    const res = await upload(SVG, { filename: 'logo.svg', type: 'image/svg+xml' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /SVG/);
  });
});

describe('/uploads 代理 · 合法图片仍然内联', () => {
  for (const [label, buffer, mime] of [
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF', GIF, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
  ]) {
    it(`${label} 按 ${mime} 返回、没有 Content-Disposition、仍然带 nosniff`, async () => {
      const { body } = await upload(buffer, { filename: 'evil.html', type: 'text/html' });
      const served = await fetchUpload(body.url);
      assert.equal(served.headers.get('content-type'), mime);
      assert.equal(served.headers.get('content-disposition'), null, '图片不该被强制下载');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), buffer);
    });
  }
});

describe('/uploads 代理 · 历史遗留的 .html / .svg / .js 仍然被强制下载', () => {
  // 修复之前落盘的文件沿用的是用户的原始扩展名，这些 key 至今还在库里/桶里。
  // 判定只看扩展名白名单（attachments.js 的 INLINE_EXTENSIONS），换了存储也一样。
  for (const [name, buffer] of [
    ['legacy-proxy.html', HTML],
    ['legacy-proxy.svg', SVG],
    ['legacy-proxy.js', TEXT],
    ['legacy-proxy-noext', TEXT],
  ]) {
    it(`${name} 按 attachment 返回，不会被当网页跑`, async () => {
      // 直接塞进对象存储，模拟升级前就已经存在的老对象（它没有 attachments 行，
      // 走的是「历史附件」那一档降级：登录即可读，但仍然只能下载）。
      await store.put(name, buffer, 'text/html');
      const served = await fetchUpload(`/uploads/${name}`);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'application/octet-stream');
      assert.equal(served.headers.get('content-disposition'), 'attachment');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(served.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    });
  }

  it('历史上的 .jpeg 图片仍然按图片内联，没有被这次换存储带坏', async () => {
    await store.put('legacy-proxy.jpeg', JPEG, 'application/octet-stream');
    const served = await fetchUpload('/uploads/legacy-proxy.jpeg');
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
    assert.equal(served.headers.get('content-disposition'), null);
  });
});

describe('/uploads 代理 · 其它', () => {
  it('带鉴权之后缓存降级成 private，不能被共享缓存留下来', async () => {
    const { body } = await upload(PNG, { filename: 'a.png', type: 'image/png' });
    const served = await fetchUpload(body.url);
    assert.match(served.headers.get('cache-control'), /private/);
    assert.doesNotMatch(served.headers.get('cache-control'), /public/);
  });

  it('形状离谱的 key 不会被拿去拼路径，一律当作不存在', async () => {
    for (const key of ['..%2F..%2Fetc%2Fpasswd', '.hidden', 'a%20b']) {
      const served = await fetchUpload(`/uploads/${key}`);
      assert.equal(served.status, 404);
    }
  });

  it('桶里没有这个对象时给 404，而且和「不许看」是同一句话', async () => {
    const missing = await fetchUpload('/uploads/never-existed.png');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, '附件不存在');
  });
});
