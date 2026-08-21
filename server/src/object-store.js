/**
 * 对象存储的可替换接口。全仓只认这三个方法：
 *
 *   put(key, buffer, contentType) -> void
 *   get(key)                      -> Buffer | null      （不存在返回 null，不抛）
 *   remove(key)                   -> boolean            （本来就不存在也算成功）
 *
 * 三个实现：
 *   local  —— 落在 UPLOAD_DIR，默认，没配 MinIO 时行为和改造前完全一样；
 *   s3     —— MinIO / 任意 S3 兼容服务，只在 Docker 内网可达（见 deploy/docker-compose.yml）；
 *   memory —— 测试用。抽出这一层就是为了不必在 CI 里真起一个 MinIO 容器。
 *
 * ⚠️ 测试覆盖的边界：memory / local 两个实现被完整覆盖，s3 实现只有签名部分
 * （test/s3-sign.test.js，跑的是 AWS 官方向量）和 URL 拼装被覆盖，真实的
 * MinIO HTTP 往返、桶策略、错误码没有任何自动化用例。见 deploy/README.md 的上线自检清单。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeS3Path, signS3Request } from './s3-sign.js';

/**
 * 对象 key 的合法形状。key 由服务端生成（randomUUID + 服务端定的扩展名），
 * 这里只是回源时的最后一道闸：不许出现 `/`、`..`、控制字符，
 * 否则 local 实现的 join() 就能被拿去读 uploads 目录之外的文件。
 */
export const isSafeKey = (key) =>
  typeof key === 'string' && key.length > 0 && key.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) && !key.includes('..');

/** 本地磁盘。 */
export function createLocalStore(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    name: 'local',
    async put(key, buffer) {
      writeFileSync(join(dir, key), buffer);
    },
    async get(key) {
      if (!isSafeKey(key)) return null;
      try {
        return readFileSync(join(dir, key));
      } catch {
        return null;                              // ENOENT / EISDIR 一律当「没有」
      }
    },
    async remove(key) {
      if (!isSafeKey(key)) return false;
      rmSync(join(dir, key), { force: true });
      return true;
    },
  };
}

/** 内存实现：测试专用，进程退出即消失。 */
export function createMemoryStore() {
  const objects = new Map();
  return {
    name: 'memory',
    objects,                                      // 用例里直接断言内容用
    async put(key, buffer, contentType) {
      objects.set(key, { buffer: Buffer.from(buffer), contentType });
    },
    async get(key) {
      return objects.has(key) ? objects.get(key).buffer : null;
    },
    async remove(key) {
      objects.delete(key);
      return true;
    },
  };
}

/**
 * MinIO / S3 兼容。用 path-style（`http://minio:9000/<bucket>/<key>`）：
 * virtual-host style 要求 `<bucket>.minio` 能被 DNS 解析，Docker 内网做不到。
 */
export function createS3Store({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'us-east-1' }) {
  const base = String(endpoint).replace(/\/+$/, '');
  const { host } = new URL(base);
  const pathOf = (key) => `/${bucket}/${key}`;
  const urlOf = (key) => `${base}${encodeS3Path(pathOf(key))}`;

  const send = async (method, key, { payload = Buffer.alloc(0), contentType } = {}) => {
    const { headers } = signS3Request({
      method,
      host,
      path: pathOf(key),
      headers: contentType ? { 'content-type': contentType } : {},
      payload,
      accessKeyId,
      secretAccessKey,
      region,
    });
    return fetch(urlOf(key), {
      method,
      headers,
      body: method === 'PUT' ? payload : undefined,
    });
  };

  return {
    name: 's3',
    urlOf,
    async put(key, buffer, contentType) {
      const res = await send('PUT', key, { payload: Buffer.from(buffer), contentType });
      if (!res.ok) throw new Error(`对象存储写入失败（${res.status}）`);
    },
    async get(key) {
      if (!isSafeKey(key)) return null;
      const res = await send('GET', key);
      if (res.status === 404 || res.status === 403) return null;   // 没有就是没有，交给调用方回落
      if (!res.ok) throw new Error(`对象存储读取失败（${res.status}）`);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(key) {
      if (!isSafeKey(key)) return false;
      const res = await send('DELETE', key);
      // S3 删不存在的对象照样返回 204，这里只把真正的错误挡出去。
      if (!res.ok && res.status !== 404) throw new Error(`对象存储删除失败（${res.status}）`);
      return true;
    },
  };
}
