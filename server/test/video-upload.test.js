/**
 * 视频内联播放 · 上传这一半。
 *
 * 视频是 issue #22 之后**第一次**往「允许内联」这一档里加东西，所以这个文件的重点
 * 不是「视频能传上去」，而是**加了这一档之后 #22 的防线一个字都没松**：
 *   - 客户端自报的 Content-Type 仍然完全不参与判定（HTML 谎报 video/mp4 → 400）；
 *   - 落盘扩展名仍然由嗅探决定，绝不沿用文件名（真 MP4 叫 evil.html → 落成 .mp4）；
 *   - 遗留的 .html / .svg / .js 仍然强制下载；
 *   - 图片和普通文件的响应头逐字不变。
 *
 * 覆盖不到的地方，说在明处：样本是**按规范手写的容器头**，不含可解码的音视频轨
 * （见 samples.js 的说明），所以「浏览器/iOS 到底能不能播」不在自动化用例里。
 */
import { startServer } from './helpers.js';
import { GIF, HTML, JPEG, M4A, MKV, MP4, PNG, SVG, TEXT, WEBM, WEBP, ZIP } from './samples.js';
import { inspectUpload, sniffVideo } from '../src/attachments.js';
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

const fetchUpload = (url, init = {}) =>
  fetch(`${api.baseUrl}${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`, init);

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
  // 和 uploads-proxy.test.js 一样强制走对象存储那条路，确保验的是代理路径。
  process.env.S3_BUCKET = 'loop-im-test';
  process.env.UPLOADS_LOCAL_FALLBACK = '0';
  store = createMemoryStore();
  __setStoreForTest(store);
});

after(async () => {
  delete process.env.S3_BUCKET;
  delete process.env.UPLOADS_LOCAL_FALLBACK;
  resetStore();
  await api.close();
});

describe('视频嗅探 · 只看真实字节', () => {
  it('MP4 / WebM 认得出来，给出服务端自己定的 mime 和扩展名', () => {
    assert.deepEqual(sniffVideo(MP4), { mime: 'video/mp4', ext: '.mp4' });
    assert.deepEqual(sniffVideo(WEBM), { mime: 'video/webm', ext: '.webm' });
  });

  it('ftyp 在偏移 4，不是开头 —— 拿开头四个字节去比对的写法会漏掉全部 MP4', () => {
    assert.equal(MP4.subarray(4, 8).toString('latin1'), 'ftyp');
    assert.notEqual(MP4.subarray(0, 4).toString('latin1'), 'ftyp');
  });

  it('同样是 ftyp，纯音频的 M4A 不算视频（major brand 不在白名单里）', () => {
    assert.equal(sniffVideo(M4A), null);
    assert.equal(inspectUpload(M4A, 'audio/mp4').kind, 'file');
  });

  it('同样是 EBML 魔数，Matroska 不算 WebM（浏览器放不了 mkv）', () => {
    assert.equal(sniffVideo(MKV), null);
  });

  it('图片、文本、ZIP 一个都不会被误判成视频', () => {
    for (const [label, buffer] of [['PNG', PNG], ['JPEG', JPEG], ['GIF', GIF], ['WebP', WEBP], ['文本', TEXT], ['ZIP', ZIP]]) {
      assert.equal(sniffVideo(buffer), null, label);
    }
  });

  it('只看开头几 KB 就能判定：100MB 的视频不必整份进内存', () => {
    // 路由传给 inspectUpload 的就是这么一截（readSniffHead 取前 4KB）。
    assert.equal(inspectUpload(MP4.subarray(0, 4096)).kind, 'video');
    assert.equal(inspectUpload(WEBM.subarray(0, 4096)).kind, 'video');
  });
});

describe('视频上传 · 契约', () => {
  it('MP4 上传成功，kind=video、mime=video/mp4', async () => {
    const res = await upload(MP4, { filename: '录屏.mp4', type: 'video/mp4' });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'video');
    assert.equal(res.body.mime, 'video/mp4');
    assert.match(res.body.url, /^\/uploads\/[A-Za-z0-9-]+\.mp4$/);
    assert.equal(res.body.filename, '录屏.mp4');
  });

  it('WebM 上传成功，kind=video、mime=video/webm', async () => {
    const res = await upload(WEBM, { filename: 'clip.webm', type: 'video/webm' });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'video');
    assert.equal(res.body.mime, 'video/webm');
    assert.match(res.body.url, /\.webm$/);
  });

  it('kind 只有 image / video / file 三档，没有第四种', async () => {
    const kinds = await Promise.all([
      upload(PNG, { type: 'image/png' }),
      upload(MP4, { type: 'video/mp4' }),
      upload(ZIP, { type: 'application/zip' }),
    ]);
    assert.deepEqual(kinds.map((r) => r.body.kind), ['image', 'video', 'file']);
  });
});

describe('视频上传 · issue #22 的防线一条都没松', () => {
  it('HTML 谎报 video/mp4 → 400，不会被悄悄收成附件', async () => {
    const res = await upload(HTML, { filename: 'clip.mp4', type: 'video/mp4' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /视频/);
    // 400 意味着它压根没进对象存储。
    assert.equal([...store.objects.keys()].some((k) => k.endsWith('.mp4') && store.objects.get(k).buffer.equals(HTML)), false);
  });

  it('SVG 谎报 video/mp4 也一样被拒（SVG 那一档排在最前面）', async () => {
    const res = await upload(SVG, { filename: 'a.mp4', type: 'video/mp4' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /SVG/);
  });

  it('真 MP4 但文件名叫 evil.html：落盘扩展名由嗅探决定，不沿用文件名', async () => {
    const res = await upload(MP4, { filename: 'evil.html', type: 'text/html' });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'video');
    assert.match(res.body.url, /\.mp4$/);
    assert.doesNotMatch(res.body.url, /html/i);
    // 文件名只当显示名，原样留着给人看，但它不在 URL 里。
    assert.equal(res.body.filename, 'evil.html');

    const served = await fetchUpload(res.body.url);
    assert.equal(served.headers.get('content-type'), 'video/mp4');
    assert.doesNotMatch(served.headers.get('content-type'), /html/i);
  });

  it('真 MP4 谎报 image/png：按嗅探结果当视频收下，自报的类型不改变任何判定', async () => {
    // 规则是「嗅探说了算」：嗅出来是白名单里的格式就按那个走，自报的 Content-Type
    // 只在**什么都没嗅出来**时用来决定报哪句错（见 inspectUpload）。
    // 这里的字节确实是一份合法 MP4，按视频收下既安全（钉死 video/mp4 + nosniff）也更有用。
    const res = await upload(MP4, { filename: 'a.png', type: 'image/png' });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'video');
    assert.match(res.body.url, /\.mp4$/);
  });

  it('MKV / M4A 自称视频 → 400：白名单之外的容器不许进视频这一档', async () => {
    for (const [label, buffer] of [['MKV', MKV], ['M4A', M4A]]) {
      const res = await upload(buffer, { filename: 'a.mp4', type: 'video/mp4' });
      assert.equal(res.status, 400, label);
      assert.match(res.body.error, /视频/, label);
    }
  });

  it('MKV / M4A 不自称视频时照收，但落成 .bin，走强制下载那条路', async () => {
    for (const [label, buffer] of [['MKV', MKV], ['M4A', M4A]]) {
      const res = await upload(buffer, { filename: `a.${label}`, type: 'application/octet-stream' });
      assert.equal(res.status, 201, label);
      assert.equal(res.body.kind, 'file', label);
      assert.match(res.body.url, /\.bin$/, label);
      const served = await fetchUpload(res.body.url);
      assert.equal(served.headers.get('content-disposition'), 'attachment', label);
    }
  });

  it('头像口不收视频：只有图片能当头像', async () => {
    const form = new FormData();
    form.append('file', new Blob([MP4], { type: 'video/mp4' }), 'a.mp4');
    const res = await api.call('POST', '/api/auth/me/avatar', { token, form });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /头像|视频/);
  });
});

describe('视频回源 · 响应头', () => {
  let videoUrl;

  before(async () => {
    videoUrl = (await upload(MP4, { filename: 'a.mp4', type: 'video/mp4' })).body.url;
  });

  it('Content-Type 是 video/mp4，带 Accept-Ranges 和 nosniff，**没有** Content-Disposition', async () => {
    const served = await fetchUpload(videoUrl);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'video/mp4');
    assert.equal(served.headers.get('accept-ranges'), 'bytes');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(served.headers.get('content-disposition'), null, '视频不该被强制下载，否则播不了');
    // 内联那一档不加 CSP：它只对「被当文档打开」有意义，而这里的类型钉死成 video/*。
    assert.equal(served.headers.get('content-security-policy'), null);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), MP4);
  });

  it('WebM 同样一档', async () => {
    const { body } = await upload(WEBM, { filename: 'a.webm', type: 'video/webm' });
    const served = await fetchUpload(body.url);
    assert.equal(served.headers.get('content-type'), 'video/webm');
    assert.equal(served.headers.get('accept-ranges'), 'bytes');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(served.headers.get('content-disposition'), null);
  });

  it('缓存仍然是 private：视频和别的附件一样要鉴权', async () => {
    const served = await fetchUpload(videoUrl);
    assert.match(served.headers.get('cache-control'), /private/);
    assert.doesNotMatch(served.headers.get('cache-control'), /public/);
  });
});

describe('视频回源 · 遗留对象与回归保护', () => {
  it('遗留的 .html / .svg / .js 仍然被强制下载，没有被视频这一档带松', async () => {
    for (const [name, buffer] of [['legacy-video.html', HTML], ['legacy-video.svg', SVG], ['legacy-video.js', TEXT]]) {
      await store.put(name, buffer, 'text/html');
      const served = await fetchUpload(`/uploads/${name}`);
      assert.equal(served.headers.get('content-type'), 'application/octet-stream', name);
      assert.equal(served.headers.get('content-disposition'), 'attachment', name);
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff', name);
      assert.equal(served.headers.get('content-security-policy'), "default-src 'none'; sandbox", name);
      assert.equal(served.headers.get('accept-ranges'), null, `${name} 不是视频，不该声明 Accept-Ranges`);
    }
  });

  it('遗留的 .mp4 里装的是 HTML：钉死成 video/mp4 + nosniff，只会是个坏视频，跑不起来', async () => {
    // 修复之前落盘的文件沿用用户的原始扩展名，这类对象至今可能还在桶里。
    await store.put('legacy-fake.mp4', HTML, 'text/html');
    const served = await fetchUpload('/uploads/legacy-fake.mp4');
    assert.equal(served.headers.get('content-type'), 'video/mp4');
    assert.doesNotMatch(served.headers.get('content-type'), /html/i);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  });

  it('图片和普通文件的响应头和加视频之前**逐字相同**', async () => {
    const image = await fetchUpload((await upload(PNG, { filename: 'a.png', type: 'image/png' })).body.url);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(image.headers.get('content-disposition'), null);
    assert.equal(image.headers.get('content-security-policy'), null);
    // ★ 图片这一档**不能**跟着多出 Accept-Ranges。
    assert.equal(image.headers.get('accept-ranges'), null);

    const file = await fetchUpload((await upload(ZIP, { filename: 'a.zip', type: 'application/zip' })).body.url);
    assert.equal(file.headers.get('content-type'), 'application/octet-stream');
    assert.equal(file.headers.get('content-disposition'), 'attachment');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(file.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(file.headers.get('accept-ranges'), null);
  });

  it('非视频即使硬塞一个 Range 头进来，也照旧 200 + 完整内容', async () => {
    const { body } = await upload(PNG, { filename: 'a.png', type: 'image/png' });
    const served = await fetchUpload(body.url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-range'), null);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  });
});

/**
 * 附件鉴权对视频一视同仁 —— 换成流式回源之后，「先鉴权、再取字节」这个顺序
 * 一个字都不能变。带 Range 的请求尤其要盯：那是一条**新**的代码路径，
 * 要是它绕过了鉴权，等于所有视频都能被拖着 Range 一段段偷走。
 */
describe('视频回源 · 鉴权和别的附件一视同仁', () => {
  let chen, chenToken, linToken, videoUrl;

  before(async () => {
    const { group, member } = await import('./fixtures.js');
    chen = await member('陈子航', { dept: '后端' });
    const lin = await member('林悦', { dept: '设计' });
    chenToken = await api.login(chen.email);
    linToken = await api.login(lin.email);
    const room = await group(api, token, '视频鉴权 · 甲群', [chen.id]);

    const form = new FormData();
    form.append('file', new Blob([MP4], { type: 'video/mp4' }), 'a.mp4');
    const res = await api.call('POST', '/api/uploads', { token: chenToken, form });
    assert.equal(res.status, 201);
    videoUrl = res.body.url;
    await api.post(`/api/conversations/${room.id}/messages`, { body: `视频 ${videoUrl}` }, chenToken);
  });

  const take = (as, init = {}) =>
    fetch(`${api.baseUrl}${videoUrl}${as ? `?token=${encodeURIComponent(as)}` : ''}`, init);

  it('未登录 401，带不带 Range 都一样，不会先漏出一段字节', async () => {
    assert.equal((await take(null)).status, 401);
    const ranged = await take(null, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 401);
    assert.equal(ranged.headers.get('content-range'), null);
  });

  it('不是这个会话的成员 404，带不带 Range 都一样', async () => {
    assert.equal((await take(linToken)).status, 404);
    const ranged = await take(linToken, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 404);
    assert.equal(ranged.headers.get('content-range'), null);
  });

  it('会话成员照常能取，206 也能取（对照组，证明上面两条不是全都拒了）', async () => {
    assert.equal((await take(chenToken)).status, 200);
    assert.equal((await take(chenToken, { headers: { Range: 'bytes=0-9' } })).status, 206);
  });

  it('账号被停用之后连自己发过的视频也取不到', async () => {
    await api.post(`/api/users/${chen.id}/disable`, {}, token);
    // 停用会把 auth_version +1 并删掉全部会话，旧凭据当场作废 —— 401 而不是 404。
    assert.equal((await take(chenToken)).status, 401);
    assert.equal((await take(chenToken, { headers: { Range: 'bytes=0-9' } })).status, 401);
    await api.post(`/api/users/${chen.id}/enable`, {}, token);
  });
});
