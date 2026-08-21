#!/usr/bin/env node
/**
 * 把 UPLOAD_DIR 里已有的附件搬进 MinIO（或任意 S3 兼容对象存储）。
 *
 *   node scripts/migrate-uploads-to-minio.mjs                  # 只清点，什么都不传（默认）
 *   node scripts/migrate-uploads-to-minio.mjs --apply          # 真的上传
 *   node scripts/migrate-uploads-to-minio.mjs --apply --delete-local  # 传完删本地（危险，见下）
 *   node scripts/migrate-uploads-to-minio.mjs --dir /path/to/uploads
 *   node scripts/migrate-uploads-to-minio.mjs --help
 *
 * 连接参数走和服务端**同一套**环境变量（S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID /
 * S3_SECRET_ACCESS_KEY / S3_REGION），不要在这里另配一份，也不要把密钥写进任何文件。
 * 典型跑法是在 compose 网络里起一个一次性容器，让它能解析到 minio 这个主机名：
 *
 *   docker compose run --rm -e S3_BUCKET=... loop-im \
 *     node scripts/migrate-uploads-to-minio.mjs --apply
 *
 * ── 为什么默认 dry-run ───────────────────────────────────────────────
 * 这些是用户数据。跑错环境、桶名打错、凭据指向了别的集群，默认就动手的话没有回头路。
 * 先看一眼清单，确认数目对得上再加 --apply。
 *
 * ── 为什么可以从容地搬 ───────────────────────────────────────────────
 * 服务端的 getObject 是**双读**的（server/src/storage.js）：主存储没有就回落到本地磁盘。
 * 所以正确的切换顺序是
 *   1. 配好 S3_* 环境变量重启服务 —— 新附件直接进桶，老附件继续从磁盘回落，没有任何一刻是坏的；
 *   2. 从容地跑这个脚本，把老文件搬进桶；
 *   3. 核对数目无误后，再设 UPLOADS_LOCAL_FALLBACK=0 关掉回落。
 * --delete-local 只应该在第 3 步之后、并且备份过 data/ 目录之后再考虑。
 *
 * 幂等：默认跳过桶里已经存在的同名对象（--force 覆盖）。中途断了直接重跑即可。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createS3Store, isSafeKey } from '../server/src/object-store.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (has('--help') || has('-h')) {
  console.log(String.raw`
把本地 uploads 目录里的附件搬进 MinIO / S3。

  --apply           真的上传（不加就只清点，默认 dry-run）
  --force           桶里已经有同名对象时也覆盖（默认跳过）
  --delete-local    上传成功后删掉本地那一份（务必先备份，先关掉双读回落）
  --dir <path>      指定 uploads 目录（默认 $DATA_DIR/uploads）
  --help            这段话

连接参数取自环境变量，和服务端同一套：
  S3_ENDPOINT（默认 http://minio:9000）、S3_BUCKET、
  S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY、S3_REGION（默认 us-east-1）
`.trim());
  process.exit(0);
}

const dataDir = process.env.DATA_DIR || new URL('../server/data', import.meta.url).pathname;
const dir = valueOf('--dir') || join(dataDir, 'uploads');
const apply = has('--apply');
const force = has('--force');
const deleteLocal = has('--delete-local');

if (!process.env.S3_BUCKET) {
  console.error('缺少 S3_BUCKET：没有桶名就不知道往哪儿搬。凭据请走环境变量，不要写进文件。');
  process.exit(1);
}
if (deleteLocal && !apply) {
  console.error('--delete-local 必须和 --apply 一起用。');
  process.exit(1);
}

const store = createS3Store({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  region: process.env.S3_REGION || 'us-east-1',
});

/**
 * 上传时给的 Content-Type 无关紧要 —— 回源永远由 Express 按 attachments.js 的白名单
 * 重新钉死响应头，浏览器根本看不到桶里存的这个值（见 routes/upload-files.js）。
 * 统一写 application/octet-stream，免得给人「桶里的类型说了算」的错觉。
 */
const STORED_CONTENT_TYPE = 'application/octet-stream';

let scanned = 0; let uploaded = 0; let skipped = 0; let failed = 0; let ignored = 0;

const entries = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name)
  .sort();

console.log(`${apply ? '开始搬运' : '预演（不会改动任何东西，加 --apply 才真的传）'}：${dir} → ${process.env.S3_BUCKET}`);
console.log(`共 ${entries.length} 个文件\n`);

// 先探一下连通性再逐个跑：桶名打错、凭据不对、跑在 compose 网络外面解析不到 minio ——
// 这几种情况下每个文件都会失败一次，刷一屏没用的报错，不如一开始就说清楚。
// 取一个必然不存在的 key：能拿到 null 就说明网络、凭据、桶都是通的。
// key 必须是合法形状，否则 store.get 会在本地就短路掉，根本不发请求。
try {
  await store.get('connectivity-probe-0000.bin');
} catch (err) {
  console.error(`连不上对象存储：${err.message}`);
  console.error(`  endpoint=${process.env.S3_ENDPOINT || 'http://minio:9000'} bucket=${process.env.S3_BUCKET}`);
  console.error('  MinIO 只在 Docker 内网监听，这个脚本要在 compose 网络里跑。');
  process.exit(1);
}

for (const name of entries) {
  // key 的形状由服务端生成时保证；不合形状的（比如 quarantine 之类的残留）跳过不碰。
  if (!isSafeKey(name)) {
    ignored += 1;
    console.log(`  忽略  ${name}（key 形状不合法，服务端也不会回源它）`);
    continue;
  }
  scanned += 1;
  const bytes = statSync(join(dir, name)).size;

  try {
    if (!force && await store.get(name)) {
      skipped += 1;
      console.log(`  已有  ${name}（${bytes} 字节）`);
      continue;
    }
    if (!apply) {
      console.log(`  待传  ${name}（${bytes} 字节）`);
      continue;
    }
    await store.put(name, await readFile(join(dir, name)), STORED_CONTENT_TYPE);
    // 传完立刻回读一次核对：宁可慢一点，也不要在没确认的情况下删本地文件。
    const back = await store.get(name);
    if (!back || back.length !== bytes) throw new Error('回读核对失败，桶里的字节数对不上');
    uploaded += 1;
    if (deleteLocal) rmSync(join(dir, name), { force: true });
    console.log(`  已传  ${name}（${bytes} 字节）${deleteLocal ? '，本地已删' : ''}`);
  } catch (err) {
    failed += 1;
    console.error(`  失败  ${name}：${err.message}`);
  }
}

console.log(`\n清点：${scanned} 个候选，已传 ${uploaded}，跳过（桶里已有）${skipped}，失败 ${failed}，忽略 ${ignored}`);
if (!apply) console.log('这是预演。确认清单没问题后加 --apply 真正执行。');
if (failed) process.exit(1);
