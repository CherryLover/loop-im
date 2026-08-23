import './helpers.js';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore, createMemoryStore, createS3Store } from '../src/object-store.js';
import { ensureStoreReady, __setStoreForTest, resetStore } from '../src/storage.js';

/**
 * 假的 S3：只实现自检要用到的那几种请求。
 * `bucketExists` 控制桶在不在，`deny` 控制凭据是否被拒，`swallowWrites` 模拟
 * 「PUT 返回 200 但其实没存进去」——只查桶存不存在的话，这种故障是发现不了的。
 */
function fakeS3({ bucketExists = false, deny = false, swallowWrites = false } = {}) {
  const objects = new Map();
  const seen = [];
  let exists = bucketExists;
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (deny) return res.writeHead(403).end();

    const isBucketLevel = req.url === '/loop-im';
    if (isBucketLevel) {
      if (req.method === 'HEAD') return res.writeHead(exists ? 200 : 404).end();
      if (req.method === 'PUT') {
        if (exists) return res.writeHead(409).end();     // BucketAlreadyOwnedByYou
        exists = true;
        return res.writeHead(200).end();
      }
    }

    const key = decodeURIComponent(req.url.replace('/loop-im/', ''));
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (!swallowWrites) objects.set(key, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
      return;
    }
    if (req.method === 'DELETE') { objects.delete(key); return res.writeHead(204).end(); }
    if (!objects.has(key)) return res.writeHead(404).end();
    return res.writeHead(200).end(objects.get(key));
  });
  return {
    objects,
    seen,
    get bucketExists() { return exists; },
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return createS3Store({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        bucket: 'loop-im',
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
      });
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

describe('对象存储启动自检', () => {
  it('桶不存在时自动创建 —— MinIO 起来是空的，不该要人手工 mc mb', async () => {
    const fake = fakeS3({ bucketExists: false });
    const store = await fake.start();
    try {
      const info = await store.ready();
      assert.equal(info.created, true, '应该报告「是我建的」');
      assert.equal(fake.bucketExists, true, '桶没被建出来');
      assert.ok(fake.seen.includes('PUT /loop-im'), `没发建桶请求：${fake.seen.join(' | ')}`);
    } finally { await fake.close(); }
  });

  it('桶已存在时不重复建，且照样跑一遍读写自检', async () => {
    const fake = fakeS3({ bucketExists: true });
    const store = await fake.start();
    try {
      const info = await store.ready();
      assert.equal(info.created, false);
      assert.ok(!fake.seen.includes('PUT /loop-im'), '桶已经在了还去建');
      assert.ok(fake.seen.some((r) => r.startsWith('PUT /loop-im/probe-')), '没跑读写自检');
    } finally { await fake.close(); }
  });

  it('探针对象跑完就删掉，不在桶里留垃圾', async () => {
    const fake = fakeS3({ bucketExists: true });
    const store = await fake.start();
    try {
      await store.ready();
      assert.equal(fake.objects.size, 0, `自检留下了 ${fake.objects.size} 个对象`);
    } finally { await fake.close(); }
  });

  it('凭据没权限（403）时直接报错，不会误判成「桶不存在」再去建一次', async () => {
    const fake = fakeS3({ deny: true });
    const store = await fake.start();
    try {
      await assert.rejects(() => store.ready(), /无权访问/);
      assert.ok(!fake.seen.includes('PUT /loop-im'), '403 之后不该再尝试建桶');
    } finally { await fake.close(); }
  });

  it('写进去读不回来时自检失败 —— 只查「桶在不在」是发现不了这种故障的', async () => {
    const fake = fakeS3({ bucketExists: true, swallowWrites: true });
    const store = await fake.start();
    try {
      await assert.rejects(() => store.ready(), /读不回来/);
    } finally { await fake.close(); }
  });
});

describe('ensureStoreReady 的重试', () => {
  after(() => resetStore());

  it('前几次失败、之后成功，最终算成功', async () => {
    let calls = 0;
    __setStoreForTest({
      name: 'flaky',
      async ready() {
        calls += 1;
        if (calls < 3) throw new Error('connect ECONNREFUSED');
        return { driver: 'flaky', detail: 'ok' };
      },
    });
    const logged = [];
    const info = await ensureStoreReady({ attempts: 5, delayMs: 1, log: (l) => logged.push(l) });
    assert.equal(info.driver, 'flaky');
    assert.equal(calls, 3);
    assert.equal(logged.length, 2, '每次失败都该留一行日志');
    resetStore();
  });

  it('一直失败就把最后那个错误抛出去（index.js 据此退出，交给 restart 重来）', async () => {
    __setStoreForTest({
      name: 'dead',
      async ready() { throw new Error('MinIO 一直连不上'); },
    });
    await assert.rejects(
      () => ensureStoreReady({ attempts: 3, delayMs: 1 }),
      /MinIO 一直连不上/,
    );
    resetStore();
  });
});

describe('本地驱动与内存驱动的自检', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'loop-im-store-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('本地驱动把目录建出来', async () => {
    const target = join(dir, 'nested', 'uploads');
    const store = createLocalStore(target);
    const info = await store.ready();
    assert.equal(info.driver, 'local');
    assert.ok(existsSync(target), '目录没建出来');
  });

  it('内存驱动直接就绪（测试用，不需要外部依赖）', async () => {
    const info = await createMemoryStore().ready();
    assert.equal(info.driver, 'memory');
  });
});
