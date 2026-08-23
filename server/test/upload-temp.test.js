/**
 * 上传中转文件的清理。
 *
 * multer 不再用 memoryStorage（视频上限 100MB，整份进堆 × 并发 = OOM），改成先落到
 * UPLOAD_TMP_DIR 再流式推给对象存储。代价是多了一份磁盘上的临时文件，而它**必须**
 * 被删掉 —— 漏一条路径，磁盘就会一天天被用户传上来的原始内容填满，
 * 而且这种事不会报错、只会在某天半夜把磁盘写爆。
 *
 * 三条路径逐条盯：
 *   1. 成功；
 *   2. 失败（嗅探不通过 400 / 体积超限 413 / 写对象存储抛异常 500）；
 *   3. 请求中断（客户端传到一半断开）。
 *
 * 判据统一是「UPLOAD_TMP_DIR 里一个文件都不剩」——不看具体实现是谁删的，
 * 只看那个不变量成不成立。
 */
import { startServer } from './helpers.js';
import { HTML, MP4, PNG, SVG } from './samples.js';
import { pngOfSize } from './samples.js';
import { UPLOAD_TMP_DIR } from '../src/db.js';
import { MAX_UPLOAD_BYTES } from '../src/upload-middleware.js';
import { createMemoryStore } from '../src/object-store.js';
import { __setStoreForTest, resetStore } from '../src/storage.js';
import { readdirSync } from 'node:fs';
import { request } from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let api, token;

const leftovers = () => readdirSync(UPLOAD_TMP_DIR);

/** 中转目录清空之前不往下走。删是异步的（multer 走的是 fs.unlink 回调），要给它一点时间。 */
const waitForClean = async ({ timeout = 4000, interval = 25 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const rest = leftovers();
    if (!rest.length) return;
    if (Date.now() > deadline) assert.fail(`中转目录还剩 ${rest.length} 个文件：${rest.join(', ')}`);
    await new Promise((r) => setTimeout(r, interval));
  }
};

const post = (path, buffer, { filename = 'x.bin', type = 'application/octet-stream' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  return api.call('POST', path, { token, form });
};

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
});

after(async () => {
  resetStore();
  await api.close();
});

// 每条用例跑完都要求中转目录是干净的：漏在别处的临时文件不该记到下一条头上。
afterEach(async () => { await waitForClean(); });

describe('中转文件清理 · 路径一：成功', () => {
  it('图片传成功之后中转目录是空的', async () => {
    assert.equal((await post('/api/uploads', PNG, { filename: 'a.png', type: 'image/png' })).status, 201);
    await waitForClean();
  });

  it('视频传成功之后中转目录是空的', async () => {
    assert.equal((await post('/api/uploads', MP4, { filename: 'a.mp4', type: 'video/mp4' })).status, 201);
    await waitForClean();
  });

  it('普通文件传成功之后中转目录是空的', async () => {
    assert.equal((await post('/api/uploads', HTML, { filename: 'a.txt', type: 'text/plain' })).status, 201);
    await waitForClean();
  });

  it('头像传成功之后中转目录是空的', async () => {
    assert.equal((await post('/api/auth/me/avatar', PNG, { filename: 'a.png', type: 'image/png' })).status, 200);
    await waitForClean();
  });

  it('连着传几十个也不会攒下东西（漏一次就会在这里显形）', async () => {
    for (let i = 0; i < 30; i += 1) {
      assert.equal((await post('/api/uploads', PNG, { filename: 'a.png', type: 'image/png' })).status, 201);
    }
    await waitForClean();
  });
});

describe('中转文件清理 · 路径二：失败', () => {
  it('嗅探不通过（SVG，400）之后不留东西', async () => {
    const res = await post('/api/uploads', SVG, { filename: 'a.svg', type: 'image/svg+xml' });
    assert.equal(res.status, 400);
    await waitForClean();
  });

  it('谎报 video/mp4（400）之后不留东西', async () => {
    const res = await post('/api/uploads', HTML, { filename: 'a.mp4', type: 'video/mp4' });
    assert.equal(res.status, 400);
    await waitForClean();
  });

  it('体积超限（图片 8MB 那一档，413）之后不留东西', async () => {
    const res = await post('/api/uploads', pngOfSize(MAX_UPLOAD_BYTES + 1), { filename: 'a.png', type: 'image/png' });
    assert.equal(res.status, 413);
    await waitForClean();
  });

  it('头像被拒（不是图片，400）之后不留东西', async () => {
    const res = await post('/api/auth/me/avatar', MP4, { filename: 'a.mp4', type: 'video/mp4' });
    assert.equal(res.status, 400);
    await waitForClean();
  });

  it('写对象存储时抛异常（500）之后也不留东西 —— 最容易漏的就是这条', async () => {
    // 只有 finally 才盖得住这一条：写失败时路由是被异常掀出去的，
    // 任何写在 return 前面的清理都不会被执行到。
    const broken = createMemoryStore();
    broken.putFile = async () => { throw new Error('对象存储写入失败（500）'); };
    __setStoreForTest(broken);
    try {
      const res = await post('/api/uploads', PNG, { filename: 'a.png', type: 'image/png' });
      assert.equal(res.status, 500);
      await waitForClean();
    } finally {
      resetStore();
    }
  });
});

/**
 * 路径三：客户端传到一半断开。
 *
 * 这一条路由**根本不会被执行**（Express 收不到完整请求体），所以清理不可能写在路由里。
 * 兜住它的是 multer：它在 req 的 'aborted' / 'close' 上调 storage._removeFile。
 * 这个用例的意义就是把那份依赖钉死 —— 哪天换掉 multer、或者自己实现 storage，
 * 这里会立刻红给你看。
 */
describe('中转文件清理 · 路径三：请求中断', () => {
  /** 手写 multipart 请求：先发头和一部分正文，等临时文件出现，然后掐断连接。 */
  const abortMidUpload = () => new Promise((resolve, reject) => {
    const boundary = '----loopimtest';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.mp4"\r\n`
      + 'Content-Type: video/mp4\r\n\r\n',
      'utf8',
    );
    // 声明一个很大的 Content-Length，然后只发一小部分 —— 服务端会一直等剩下的。
    const declared = head.length + 8 * 1024 * 1024;
    const url = new URL(`${api.baseUrl}/api/uploads`);
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: '/api/uploads',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(declared),
      },
    });
    req.on('error', () => {});                       // 我们自己掐的，报错是预期内的
    req.write(head);
    req.write(Buffer.concat([MP4, Buffer.alloc(512 * 1024, 0x00)]));

    // 等临时文件真的落到磁盘上再断，否则测的就不是「断线时有没有残留」了。
    const deadline = Date.now() + 4000;
    const poll = setInterval(() => {
      if (readdirSync(UPLOAD_TMP_DIR).length > 0) {
        clearInterval(poll);
        req.destroy();
        resolve(true);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        req.destroy();
        reject(new Error('等不到临时文件落盘，用例本身失效了'));
      }
    }, 20);
  });

  it('传到一半断开：临时文件确实出现过，然后被清掉了', async () => {
    assert.equal(await abortMidUpload(), true, '前提：断开之前磁盘上确实有一份临时文件');
    await waitForClean();
  });

  it('连断三次也不会攒下东西', async () => {
    for (let i = 0; i < 3; i += 1) {
      await abortMidUpload();
      await waitForClean();
    }
  });
});

/**
 * 兜底：进程被 kill -9 在上传半路时，那份临时文件没有任何人会来收。
 * 上面三条路径都盖不住这一种，所以启动时再扫一遍（index.js 里调）。
 */
describe('中转文件清理 · 兜底：启动时扫掉陈旧残骸', () => {
  it('够老的残骸被删掉，刚写的那份留着（可能是别的实例正在写）', async () => {
    const { utimesSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { sweepStaleTemp } = await import('../src/upload-temp.js');

    const stale = join(UPLOAD_TMP_DIR, 'stale-leftover');
    const fresh = join(UPLOAD_TMP_DIR, 'fresh-leftover');
    writeFileSync(stale, MP4);
    writeFileSync(fresh, MP4);
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(stale, longAgo, longAgo);

    const result = await sweepStaleTemp();
    assert.equal(result.removed, 1);
    assert.deepEqual(leftovers(), ['fresh-leftover']);

    // 收尾：把刚写的那份也清掉，afterEach 才过得去。
    await sweepStaleTemp({ olderThanMs: -1 });
    assert.deepEqual(leftovers(), []);
  });

  it('目录不存在时安静返回，不抛 —— 全新部署第一次启动就是这个样子', async () => {
    const { sweepStaleTemp } = await import('../src/upload-temp.js');
    assert.deepEqual(await sweepStaleTemp({ dir: '/nonexistent/loop-im-tmp' }), { scanned: 0, removed: 0 });
  });
});
