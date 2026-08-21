// 附件存储。默认写本地磁盘；配了 S3_BUCKET 就写 MinIO（或任意 S3 兼容服务）。
// 两条路都只对外交出 { key, url }，url 永远是 `/uploads/<key>` —— 浏览器**始终**只跟
// Express 打交道，绝不直连对象存储。理由见 routes/upload-files.js 开头那段。
import { randomUUID } from 'node:crypto';
import { UPLOAD_DIR } from './db.js';
import { createLocalStore, createS3Store } from './object-store.js';

/**
 * 驱动是**每次调用现算**的，不是模块加载时定死的。
 *
 * 以前写成 `export const driver = process.env.S3_BUCKET ? 's3' : 'local'`，于是：
 * 测试里改 process.env 完全无效（模块早就求过值了），线上切驱动只能重启进程。
 * 改成函数之后，切换只是改环境变量 + 让下一次调用重新解析。
 */
export const getDriver = () => (process.env.S3_BUCKET ? 's3' : 'local');

/** 解析出来的 store 按配置缓存：配置没变就复用，变了自动重建。 */
let cache = { signature: null, store: null };
/** 测试注入用；非 null 时压过一切。 */
let injected = null;

const signatureOf = () => JSON.stringify([
  getDriver(), process.env.S3_BUCKET, process.env.S3_ENDPOINT,
  process.env.S3_ACCESS_KEY_ID, process.env.S3_REGION,
]);

export function getStore() {
  if (injected) return injected;
  const signature = signatureOf();
  if (cache.signature === signature && cache.store) return cache.store;
  const store = getDriver() === 's3'
    ? createS3Store({
      endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      region: process.env.S3_REGION || 'us-east-1',
    })
    : createLocalStore(UPLOAD_DIR);
  cache = { signature, store };
  return store;
}

/** 本地磁盘那一份，切换期用来兜底回读（见 getObject）。 */
let localFallback = null;
const getLocalFallback = () => (localFallback ||= createLocalStore(UPLOAD_DIR));

/** 测试钩子：塞一个内存实现进来，跑完记得 resetStore()。 */
export const __setStoreForTest = (store) => { injected = store; };
export const resetStore = () => { injected = null; cache = { signature: null, store: null }; };

/**
 * 落盘/落桶。`ext` 是**服务端**定的扩展名（图片按真实字节嗅探的结果，其余一律 `.bin`），
 * 调用方绝不能把用户传来的文件名传进来 —— 那正是 issue #22 的成因：
 * 沿用 `x.html` 会让回源逻辑按网页返回，脚本就在同源下执行了。
 */
export async function putObject({ buffer, ext = '', mime }) {
  const key = `${randomUUID()}${ext}`;
  await getStore().put(key, buffer, mime);
  return { key, url: `/uploads/${key}`, mime };
}

/**
 * 取对象。**双读**：主存储没有就回落到本地磁盘。
 *
 * 这是为了让「本地 → MinIO」的迁移可以分两步走：先把服务切到 MinIO（新文件进桶），
 * 再从容地跑 scripts/migrate-uploads-to-minio.mjs 把老文件搬过去。少了这一步，
 * 切换的那一刻起所有老图立刻 404。搬完并确认无误后，可以设 UPLOADS_LOCAL_FALLBACK=0 关掉。
 */
export async function getObject(key) {
  const store = getStore();
  const hit = await store.get(key);
  if (hit) return hit;
  if (store.name === 'local' || process.env.UPLOADS_LOCAL_FALLBACK === '0') return null;
  return getLocalFallback().get(key);
}

/** 删对象。主存储和本地兜底那一份都要删，否则清理完了老文件还留在磁盘上。 */
export async function deleteObject(key) {
  const store = getStore();
  await store.remove(key);
  if (store.name !== 'local') await getLocalFallback().remove(key);
  return true;
}
