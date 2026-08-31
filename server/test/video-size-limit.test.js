/**
 * 视频那一档的 100MB 边界，以及「分档」这件事本身。
 *
 * issue #15 立过一条规矩：busboy 的 limits.fileSize 是「不得达到」语义，所以
 * upload-middleware.js 里那个 `+1` 不能删，否则正好等于上限的文件会被拒。
 * 现在上限按类型分成两档，那条规矩原样适用于新的一档 —— 这里把两档的边界都钉死。
 *
 * 这个文件会真的推 100MB 过 HTTP，是全仓最慢的一个（十几秒量级）。慢得值：
 * 「正好 100MB 的视频传得上去」这句话只有真推一遍才算数，
 * 而 issue #15 正是「以为对齐了、其实差一个字节」这种事。
 */
import { startServer } from './helpers.js';
import { mp4OfSize, pngOfSize } from './samples.js';
import {
  MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, MAX_VIDEO_MB, maxBytesFor, sizeTierFor,
} from '../src/upload-middleware.js';
import { UPLOAD_TMP_DIR } from '../src/db.js';
import { readdirSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token;

const post = (buffer, type) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), 'a.bin');
  return api.call('POST', '/api/uploads', { token, form });
};

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
});
after(async () => { await api.close(); });

describe('体积分档 · 常量和查表', () => {
  it('两档的字节数就是 8388608 和 104857600', () => {
    assert.equal(MAX_UPLOAD_BYTES, 8 * 1024 * 1024);
    assert.equal(MAX_VIDEO_BYTES, 100 * 1024 * 1024);
    assert.equal(MAX_VIDEO_MB, 100);
  });

  it('只有 video 走 100MB 那一档，image / file 仍然是 8MB', () => {
    assert.equal(maxBytesFor('video'), MAX_VIDEO_BYTES);
    assert.equal(maxBytesFor('image'), MAX_UPLOAD_BYTES);
    assert.equal(maxBytesFor('file'), MAX_UPLOAD_BYTES);
  });

  it('嗅探不出类型时按自报的意图挑档 —— 它只决定报哪句错，不参与安全判定', () => {
    assert.equal(sizeTierFor('video', 'text/html'), 'video');       // 嗅探说了算
    assert.equal(sizeTierFor('image', 'video/mp4'), 'image');       // 嗅探说了算
    assert.equal(sizeTierFor('rejected', 'video/mp4'), 'video');    // 嗅不出来才看自报
    assert.equal(sizeTierFor('rejected', 'image/png'), 'file');
    assert.equal(sizeTierFor('rejected', ''), 'file');
  });
});

describe('8MB 那一档没有被视频的放宽带松', () => {
  it('9MB 的图片仍然 413，提示里说的是 8MB 而不是 100MB', async () => {
    const res = await post(pngOfSize(MAX_UPLOAD_BYTES + 1), 'image/png');
    assert.equal(res.status, 413);
    assert.match(res.body.error, /8\s*MB/);
    assert.doesNotMatch(res.body.error, /100/);
  });

  it('正好 8MB 的图片照样传得上去（issue #15 的那条边界）', async () => {
    assert.equal((await post(pngOfSize(MAX_UPLOAD_BYTES), 'image/png')).status, 201);
  });

  it('9MB 的普通文件（不是视频）同样 413', async () => {
    const junk = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41);
    const res = await post(junk, 'application/octet-stream');
    assert.equal(res.status, 413);
    assert.match(res.body.error, /8\s*MB/);
  });

  it('9MB 的**视频**则传得上去 —— 分档确实生效了', async () => {
    const res = await post(mp4OfSize(MAX_UPLOAD_BYTES + 1), 'video/mp4');
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'video');
  });
});

describe('100MB 边界（真的推这么多字节过去）', () => {
  it('正好 100MB 的视频上传成功 —— multer limits 里那个 +1 不是笔误', async () => {
    const res = await post(mp4OfSize(MAX_VIDEO_BYTES), 'video/mp4');
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'video');
  });

  it('差一个字节（100MB-1）也成功', async () => {
    assert.equal((await post(mp4OfSize(MAX_VIDEO_BYTES - 1), 'video/mp4')).status, 201);
  });

  it('超出一个字节就是 413 + 中文提示，而且不留临时文件', async () => {
    const res = await post(mp4OfSize(MAX_VIDEO_BYTES + 1), 'video/mp4');
    assert.equal(res.status, 413);
    assert.match(res.body.error, /100\s*MB/);
    assert.doesNotMatch(res.body.error, /File too large/i);
    // 这一档是 busboy 在半路掐断的，路由根本没跑到，清理靠的是 multer 自己
    // （见 test/upload-temp.test.js 路径三）。这里再确认一次。
    for (let i = 0; i < 100 && readdirSync(UPLOAD_TMP_DIR).length; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(readdirSync(UPLOAD_TMP_DIR), []);
  });

  it('100MB 走完整条链路之后进程内存没有跟着涨 100MB（说明确实是流式的）', async () => {
    global.gc?.();
    const before = process.memoryUsage().rss;
    assert.equal((await post(mp4OfSize(MAX_VIDEO_BYTES), 'video/mp4')).status, 201);
    global.gc?.();
    const grew = (process.memoryUsage().rss - before) / (1024 * 1024);
    // 阈值放得很松（这个进程里既有客户端又有服务端，客户端那一侧是要把 100MB
    // 攒成 Blob 的）。真退回 memoryStorage 的话，服务端会再多留**一整份 100MB**，
    // 总涨幅会到 300MB 上下，这条照样红。
    // 为什么是 256 而不是 150：RSS 是全进程指标，测试套件并行跑满机器时
    // （CI 双 Node 版本 + 本地全量）正常涨幅实测就有 ~200MB 的抖动，150 会误报；
    // 而「多留一整份」的回归至少再加 100MB，256 仍然分得开。
    assert.ok(grew < 256, `RSS 涨了 ${grew.toFixed(0)}MB，看起来又把整份读进内存了`);
  });
});
