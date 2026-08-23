/**
 * 对象存储的可替换接口。全仓只认这四个方法：
 *
 *   put(key, buffer, contentType) -> void
 *   get(key)                      -> Buffer | null      （不存在返回 null，不抛）
 *   remove(key)                   -> boolean            （本来就不存在也算成功）
 *   ready()                       -> { driver, detail } （启动自检；不通过就抛）
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
import { randomUUID } from 'node:crypto';
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

/**
 * 启动自检用的探针对象：写进去、读回来比对、再删掉。
 *
 * 只检查「桶存在」是不够的 —— 桶在、但凭据只读，或者策略不让写，
 * 要到用户第一次发图才会暴露。跑一个完整来回才算真的「准备就绪」。
 * key 必须满足 isSafeKey（get() 会校验），所以用字母开头、不带点号前缀。
 */
const PROBE_BODY = Buffer.from('loop-im-store-probe');
const probeKey = () => `probe-${randomUUID()}`;

/** 本地磁盘。 */
export function createLocalStore(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    name: 'local',
    async ready() {
      // 目录在构造时就建好了；这里再确认一次是因为挂载卷可能在运行期被换掉。
      mkdirSync(dir, { recursive: true });
      return { driver: 'local', detail: dir };
    },
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
    async ready() {
      return { driver: 'memory', detail: '进程内' };
    },
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

  // 桶级请求（HEAD/PUT /<bucket>）和对象级请求签的是不同的路径，所以按 path 发。
  const sendPath = async (method, path, { payload = Buffer.alloc(0), contentType } = {}) => {
    const { headers } = signS3Request({
      method,
      host,
      path,
      headers: contentType ? { 'content-type': contentType } : {},
      payload,
      accessKeyId,
      secretAccessKey,
      region,
    });
    return fetch(`${base}${encodeS3Path(path)}`, {
      method,
      headers,
      body: method === 'PUT' ? payload : undefined,
    });
  };

  const send = (method, key, opts) => sendPath(method, pathOf(key), opts);

  return {
    name: 's3',
    urlOf,

    /**
     * 启动自检：桶不在就建，然后跑一个 put → get → remove 的完整来回。
     *
     * 为什么要程序自己建桶：MinIO 起来时是空的，不会替你建。放在这里而不是让运维
     * 手工执行 `mc mb`，是因为「compose 起来就能用」要求没有任何手工步骤；
     * 而且重装、换机器、加一个新环境时，谁都不会记得那条命令。
     *
     * 建桶是幂等的：已存在时 HEAD 直接返回 200；并发启动撞车时 MinIO 回 409
     * （BucketAlreadyOwnedByYou），那也算成功 —— 别人替我们建好了。
     */
    async ready() {
      const head = await sendPath('HEAD', `/${bucket}`);
      let created = false;
      if (head.status === 404) {
        const made = await sendPath('PUT', `/${bucket}`);
        // 409 = 已经有了（并发启动），等价于成功。
        if (!made.ok && made.status !== 409) {
          throw new Error(`建桶失败（HTTP ${made.status}）：${bucket} @ ${base}`);
        }
        created = made.ok;
      } else if (head.status === 403) {
        // 凭据能连上但没权限：这是配置错，不是「桶不存在」，别再去建一次掩盖它。
        throw new Error(`凭据无权访问桶 ${bucket}（HTTP 403）：检查 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY`);
      } else if (!head.ok) {
        throw new Error(`探测桶失败（HTTP ${head.status}）：${bucket} @ ${base}`);
      }

      // 桶在不等于能用：跑一个完整来回，把「只读凭据」「策略禁止写」这类问题当场暴露。
      const key = probeKey();
      await this.put(key, PROBE_BODY, 'application/octet-stream');
      const back = await this.get(key);
      if (!back || !back.equals(PROBE_BODY)) {
        throw new Error(`自检失败：写进去的探针对象读不回来（桶 ${bucket}）`);
      }
      await this.remove(key);
      return { driver: 's3', detail: `${base}/${bucket}`, created };
    },
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
