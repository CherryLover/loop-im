/**
 * Range 请求。`<video>` 的硬需求：Safari / iOS 拿不到 206 直接不播，拖进度条也全靠它。
 *
 * 三层各测各的：
 *   1. parseRange —— 纯函数，边界一条条钉死；
 *   2. object-store 的三个实现 —— local / memory 自己切，s3 把 Range 透传给上游；
 *   3. /uploads 回源 —— 真起 Express，验状态码和头。
 *
 * ⚠️ **没被真实 MinIO 覆盖的部分**：第 2 层里 s3 那一档连的是我们自己写的假桶
 * （一个 Node http server），它按我们理解的语义回 206/416/Content-Range。
 * 「MinIO 面对 `bytes=-0`、超大 end、多段 Range 时到底怎么回」这件事，
 * 以及它认不认我们签在 Range 头上的签名，本目录一个用例都覆盖不到 ——
 * 只能按 deploy/README.md 的上线自检清单人工过。
 */
import { startServer } from './helpers.js';
import { MP4, PNG } from './samples.js';
import { parseRange } from '../src/range.js';
import { createLocalStore, createMemoryStore, createS3Store } from '../src/object-store.js';
import { __setStoreForTest, resetStore } from '../src/storage.js';
import { UPLOAD_DIR } from '../src/db.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** 一段一眼能看出偏移对不对的内容：第 n 个字节是 '0'..'9' 里的第 n%10 个。 */
const RULER = Buffer.from('0123456789'.repeat(10));     // 100 字节

describe('parseRange · 边界', () => {
  it('闭区间', () => {
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  });

  it('开区间 bytes=N- 一直到结尾', () => {
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  });

  it('后缀 bytes=-N 取最后 N 个字节', () => {
    assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 });
  });

  it('后缀比文件还大时给整份，不是 416', () => {
    assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  });

  it('end 超出末尾时截断，不是 416 —— 播放器常常故意多要一截', () => {
    assert.deepEqual(parseRange('bytes=0-99999', 100), { start: 0, end: 99 });
  });

  it('第一个字节和最后一个字节都取得到', () => {
    assert.deepEqual(parseRange('bytes=0-0', 100), { start: 0, end: 0 });
    assert.deepEqual(parseRange('bytes=99-99', 100), { start: 99, end: 99 });
  });

  it('start 已经在文件外 → 416', () => {
    assert.deepEqual(parseRange('bytes=100-200', 100), { unsatisfiable: true });
    assert.deepEqual(parseRange('bytes=100-', 100), { unsatisfiable: true });
  });

  it('start > end → 416', () => {
    assert.deepEqual(parseRange('bytes=50-10', 100), { unsatisfiable: true });
  });

  it('bytes=-0（要最后 0 个字节）→ 416', () => {
    assert.deepEqual(parseRange('bytes=-0', 100), { unsatisfiable: true });
  });

  it('空文件上的任何范围都是 416', () => {
    assert.deepEqual(parseRange('bytes=0-0', 0), { unsatisfiable: true });
  });

  it('语法就不对（bytes= 后面是垃圾）→ 416', () => {
    for (const bad of ['bytes=abc', 'bytes=', 'bytes=--5', 'bytes=-', 'bytes=1-2-3']) {
      assert.deepEqual(parseRange(bad, 100), { unsatisfiable: true }, bad);
    }
  });

  it('没带 Range、或者单位不是 bytes → null（当作没带，返回 200 完整内容）', () => {
    for (const ignored of [undefined, '', '   ', 'items=0-9', '0-9']) {
      assert.equal(parseRange(ignored, 100), null, JSON.stringify(ignored));
    }
  });

  it('多段范围不实现，当作没带 —— 整份返回是合法回应，播放器会自己再要', () => {
    assert.equal(parseRange('bytes=0-9,20-29', 100), null);
  });

  it('大小写和空白不影响解析', () => {
    assert.deepEqual(parseRange('BYTES = 10-19', 100), { start: 10, end: 19 });
  });
});

describe('object-store · open() 三个实现语义一致', () => {
  const read = async (opened) => {
    const chunks = [];
    for await (const c of opened.stream) chunks.push(c);
    return Buffer.concat(chunks);
  };

  const implementations = [
    ['memory', async () => {
      const store = createMemoryStore();
      await store.put('ruler.mp4', RULER, 'video/mp4');
      return store;
    }],
    ['local', async () => {
      writeFileSync(join(UPLOAD_DIR, 'ruler-local.mp4'), RULER);
      return createLocalStore(UPLOAD_DIR);
    }],
  ];

  for (const [label, make] of implementations) {
    const key = label === 'memory' ? 'ruler.mp4' : 'ruler-local.mp4';

    it(`${label}：不带 Range 给整份（status 200）`, async () => {
      const opened = await (await make()).open(key);
      assert.equal(opened.status, 200);
      assert.equal(opened.size, 100);
      assert.equal(opened.totalSize, 100);
      assert.deepEqual(await read(opened), RULER);
    });

    it(`${label}：带 Range 给那一段（status 206），字节的偏移分毫不差`, async () => {
      const opened = await (await make()).open(key, { range: 'bytes=10-19' });
      assert.equal(opened.status, 206);
      assert.equal(opened.start, 10);
      assert.equal(opened.end, 19);
      assert.equal(opened.size, 10);
      assert.equal(opened.totalSize, 100);
      assert.equal((await read(opened)).toString(), '0123456789');
    });

    it(`${label}：后缀 Range 取的是最后那一段`, async () => {
      const opened = await (await make()).open(key, { range: 'bytes=-5' });
      assert.equal(opened.status, 206);
      assert.equal(opened.start, 95);
      assert.equal((await read(opened)).toString(), '56789');
    });

    it(`${label}：越界的 Range 给 416，并且带得出总长`, async () => {
      const opened = await (await make()).open(key, { range: 'bytes=500-600' });
      assert.equal(opened.status, 416);
      assert.equal(opened.stream, null);
      assert.equal(opened.totalSize, 100);
    });

    it(`${label}：不存在的 key 返回 null（交给上层回落），不抛`, async () => {
      assert.equal(await (await make()).open('range-missing.mp4'), null);
      assert.equal(await (await make()).open('range-missing.mp4', { range: 'bytes=0-9' }), null);
    });

    it(`${label}：形状不合法的 key 读不出东西`, async () => {
      assert.equal(await (await make()).open('../../etc/passwd'), null);
    });
  }

  it('local：空文件也能开，给 200 + 零字节，不炸', async () => {
    writeFileSync(join(UPLOAD_DIR, 'range-empty.mp4'), Buffer.alloc(0));
    const opened = await createLocalStore(UPLOAD_DIR).open('range-empty.mp4');
    assert.equal(opened.status, 200);
    assert.equal(opened.size, 0);
    assert.equal((await read(opened)).length, 0);
  });

  it('local：空文件上的任何 Range 都是 416', async () => {
    writeFileSync(join(UPLOAD_DIR, 'range-empty2.mp4'), Buffer.alloc(0));
    const opened = await createLocalStore(UPLOAD_DIR).open('range-empty2.mp4', { range: 'bytes=0-9' });
    assert.equal(opened.status, 416);
    assert.equal(opened.totalSize, 0);
  });
});

/**
 * s3 那一档**不自己解析 Range**，原样透传给上游，用它回的 206/416/Content-Range。
 * 下面的假桶不是 MinIO（见文件头的说明），它只证明：Range 头确实发出去了、
 * 上游的三档回应被正确解读成了 open() 的返回结构。
 */
describe('object-store · s3 把 Range 透传给上游', () => {
  const start = async () => {
    const { createServer } = await import('node:http');
    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method, range: req.headers.range, auth: req.headers.authorization });
      const range = req.headers.range;
      if (!range) {
        res.writeHead(200, { 'content-length': String(RULER.length) }).end(RULER);
        return;
      }
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m || Number(m[1]) >= RULER.length) {
        res.writeHead(416, { 'content-range': `bytes */${RULER.length}` }).end();
        return;
      }
      const [s, e] = [Number(m[1]), Math.min(Number(m[2]), RULER.length - 1)];
      const slice = RULER.subarray(s, e + 1);
      res.writeHead(206, {
        'content-range': `bytes ${s}-${e}/${RULER.length}`,
        'content-length': String(slice.length),
      }).end(slice);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const store = createS3Store({
      endpoint: `http://127.0.0.1:${server.address().port}`, bucket: 'loop-im',
      accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin',
    });
    return { store, seen, close: () => new Promise((r) => server.close(r)) };
  };

  it('Range 头原样发给上游，206 和 Content-Range 被照单收下', async () => {
    const s = await start();
    try {
      const opened = await s.store.open('ruler.mp4', { range: 'bytes=10-19' });
      assert.equal(s.seen.at(-1).range, 'bytes=10-19', 'Range 必须原样发出去');
      assert.equal(opened.status, 206);
      assert.deepEqual([opened.start, opened.end, opened.totalSize], [10, 19, 100]);
      const chunks = [];
      for await (const c of opened.stream) chunks.push(c);
      assert.equal(Buffer.concat(chunks).toString(), '0123456789');
    } finally { await s.close(); }
  });

  it('Range 也进了签名：签了不发 / 发了不签，MinIO 都会回 403', async () => {
    const s = await start();
    try {
      await s.store.open('ruler.mp4', { range: 'bytes=0-9' });
      assert.match(s.seen.at(-1).auth, /SignedHeaders=[^,]*\brange\b/);
    } finally { await s.close(); }
  });

  it('不带 Range 时签名里就没有 range 这一项', async () => {
    const s = await start();
    try {
      await s.store.open('ruler.mp4');
      assert.doesNotMatch(s.seen.at(-1).auth, /SignedHeaders=[^,]*\brange\b/);
    } finally { await s.close(); }
  });

  it('上游的 416 被翻成 status 416 + 总长，不会当成「对象不存在」', async () => {
    const s = await start();
    try {
      const opened = await s.store.open('ruler.mp4', { range: 'bytes=500-600' });
      assert.equal(opened.status, 416);
      assert.equal(opened.totalSize, 100);
      assert.notEqual(opened, null, '416 不是落空，绝不能触发回落到本地磁盘');
    } finally { await s.close(); }
  });
});

// ---- 回源这一层 -------------------------------------------------------------

let api, token, store;

const uploadVideo = () => {
  const form = new FormData();
  form.append('file', new Blob([MP4], { type: 'video/mp4' }), 'a.mp4');
  return api.call('POST', '/api/uploads', { token, form });
};

before(async () => {
  api = await startServer();
  token = await api.loginAdmin();
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

describe('/uploads 回源 · Range', () => {
  let url, total;

  before(async () => {
    // 用 100 字节的标尺当视频正文：偏移对不对一眼看得出来。
    // key 直接放进 store，走的是「遗留 .mp4 对象」那一档（登录即可读），
    // 回源逻辑和新传的视频完全同一条路（都由扩展名白名单决定）。
    await store.put('ruler-served.mp4', RULER, 'video/mp4');
    url = '/uploads/ruler-served.mp4';
    total = RULER.length;
  });

  const take = (range) =>
    fetch(`${api.baseUrl}${url}?token=${encodeURIComponent(token)}`, range ? { headers: { Range: range } } : {});

  it('没有 Range 头时行为不变：200 + 完整内容 + Content-Length', async () => {
    const res = await take();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String(total));
    assert.equal(res.headers.get('content-range'), null);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), RULER);
  });

  it('闭区间 → 206 + Content-Range，字节和长度都对得上', async () => {
    const res = await take('bytes=10-19');
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 10-19/${total}`);
    assert.equal(res.headers.get('content-length'), '10');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(await res.text(), '0123456789');
  });

  it('开区间 bytes=N- → 206，一直给到结尾', async () => {
    const res = await take('bytes=95-');
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 95-99/${total}`);
    assert.equal(await res.text(), '56789');
  });

  it('后缀 bytes=-N → 206，给最后 N 个字节', async () => {
    const res = await take('bytes=-5');
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 95-99/${total}`);
    assert.equal(await res.text(), '56789');
  });

  it('播放器起手那一发 bytes=0- 拿到整份，但状态码是 206 而不是 200', async () => {
    const res = await take('bytes=0-');
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 0-99/${total}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), RULER);
  });

  it('越界 → 416 + `Content-Range: bytes */总长`，正文为空', async () => {
    const res = await take('bytes=500-600');
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), `bytes */${total}`);
    assert.equal((await res.text()).length, 0);
  });

  it('语法不对的 Range 同样 416，并且照样带得出总长', async () => {
    for (const bad of ['bytes=abc', 'bytes=--5', 'bytes=-0']) {
      const res = await take(bad);
      assert.equal(res.status, 416, bad);
      assert.equal(res.headers.get('content-range'), `bytes */${total}`, bad);
    }
  });

  it('单位不是 bytes 时忽略这个头，回 200 完整内容（规范要求）', async () => {
    const res = await take('items=0-9');
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), RULER);
  });

  it('206 上安全头一条不少：nosniff + video/mp4 + 没有 Content-Disposition', async () => {
    const res = await take('bytes=0-9');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('content-disposition'), null);
    assert.match(res.headers.get('cache-control'), /private/);
    await res.arrayBuffer();
  });

  it('416 上安全头同样一条不少', async () => {
    const res = await take('bytes=999-');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('content-disposition'), null);
    await res.text();
  });

  it('逐段取完能拼回一模一样的字节（播放器就是这么干的）', async () => {
    const parts = [];
    for (let at = 0; at < total; at += 7) {
      const res = await take(`bytes=${at}-${Math.min(at + 6, total - 1)}`);
      assert.equal(res.status, 206);
      parts.push(Buffer.from(await res.arrayBuffer()));
    }
    assert.deepEqual(Buffer.concat(parts), RULER);
  });

  it('真传上去的视频（不是手工塞进 store 的）同样支持 206', async () => {
    const { body } = await uploadVideo();
    const res = await fetch(`${api.baseUrl}${body.url}?token=${encodeURIComponent(token)}`, {
      headers: { Range: 'bytes=4-7' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 4-7/${MP4.length}`);
    // 偏移 4 起的四个字节正是 MP4 的 `ftyp`，说明切的位置没错。
    assert.equal(await res.text(), 'ftyp');
  });

  it('图片带 Range 也照旧 200：那一档的响应头一个字都没变', async () => {
    await store.put('range-image.png', PNG, 'image/png');
    const res = await fetch(`${api.baseUrl}/uploads/range-image.png?token=${encodeURIComponent(token)}`, {
      headers: { Range: 'bytes=0-3' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('accept-ranges'), null);
    assert.equal(res.headers.get('content-range'), null);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });
});

/**
 * 播放器拖一次进度条，就会掐掉上一段还没传完的请求。这是**常态**，不是故障 ——
 * 服务端既不能因此崩，也不能因此往日志里刷警告（看一集视频就能刷出上百行，
 * 真正的故障会被淹掉）。
 */
describe('/uploads 回源 · 客户端中途断开', () => {
  const abortMidStream = async () => {
    if (!store.objects.has('abort-me.mp4')) await store.put('abort-me.mp4', Buffer.alloc(64 * 1024 * 1024, 0x61), 'video/mp4');
    const controller = new AbortController();
    const res = await fetch(`${api.baseUrl}/uploads/abort-me.mp4?token=${encodeURIComponent(token)}`, {
      headers: { Range: 'bytes=0-67108863' },
      signal: controller.signal,
    });
    assert.equal(res.status, 206);
    const reader = res.body.getReader();
    await reader.read();                       // 收下第一块就走人
    controller.abort();
    await new Promise((r) => setTimeout(r, 150));
  };

  it('断开之后服务端还活着，后面的请求照常', async () => {
    await abortMidStream();
    const after = await fetch(`${api.baseUrl}/uploads/abort-me.mp4?token=${encodeURIComponent(token)}`, {
      headers: { Range: 'bytes=0-9' },
    });
    assert.equal(after.status, 206);
    await after.arrayBuffer();
  });

  it('不往日志里刷 upload.stream_failed —— 拖进度条不是故障', async () => {
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    const prev = process.env.LOG_IN_TEST;
    console.log = (...a) => lines.push(a.map(String).join(' '));
    console.error = (...a) => lines.push(a.map(String).join(' '));
    process.env.LOG_IN_TEST = '1';
    try {
      await abortMidStream();
    } finally {
      console.log = origLog;
      console.error = origErr;
      if (prev === undefined) delete process.env.LOG_IN_TEST;
      else process.env.LOG_IN_TEST = prev;
    }
    assert.equal(lines.filter((l) => l.includes('upload.stream_failed')).length, 0, lines.join('\n'));
  });
});

describe('/uploads 回源 · Range 与切换期双读', () => {
  it('主存储没有、本地磁盘有的老视频，Range 照样走得通（双读没被流式改造弄丢）', async () => {
    writeFileSync(join(UPLOAD_DIR, 'dual-read-video.mp4'), RULER);
    delete process.env.UPLOADS_LOCAL_FALLBACK;          // 打开回落
    try {
      const res = await fetch(`${api.baseUrl}/uploads/dual-read-video.mp4?token=${encodeURIComponent(token)}`, {
        headers: { Range: 'bytes=10-19' },
      });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), `bytes 10-19/${RULER.length}`);
      assert.equal(await res.text(), '0123456789');
    } finally {
      process.env.UPLOADS_LOCAL_FALLBACK = '0';
    }
  });

  it('回落关掉之后就取不到了（证明上一条真的是从本地磁盘读回来的）', async () => {
    const res = await fetch(`${api.baseUrl}/uploads/dual-read-video.mp4?token=${encodeURIComponent(token)}`, {
      headers: { Range: 'bytes=10-19' },
    });
    assert.equal(res.status, 404);
  });
});
