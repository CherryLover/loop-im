/**
 * 对象存储的可替换接口。全仓只认这六个方法：
 *
 *   put(key, buffer, contentType)      -> void
 *   putFile(key, path, contentType)    -> void   （**流式**写入，内存恒定，见下）
 *   get(key)                           -> Buffer | null      （不存在返回 null，不抛）
 *   open(key, { range })               -> null | 打开结果     （**流式**读取 + Range，见下）
 *   remove(key)                        -> boolean            （本来就不存在也算成功）
 *   ready()                            -> { driver, detail } （启动自检；不通过就抛）
 *
 * ── 为什么要有 putFile / open ────────────────────────────────────────────
 * 视频上限 100MB。put(Buffer) / get()->Buffer 意味着**整份进 Node 堆**，
 * 100MB × 并发 = OOM。所以大对象走这两个方法：
 *   写：调用方给一个**临时文件路径**，实现自己流式读；
 *   读：返回一个可读流 + 长度信息，路由直接 pipe 给 res，不落堆。
 * put/get 留着给小对象（启动自检的探针、迁移脚本、用例断言）用，语义一个字没变。
 *
 * open() 的返回：
 *   null                                                     —— 没有这个对象（交给上层回落）
 *   { status: 200, stream, size, totalSize }                 —— 整份
 *   { status: 206, stream, size, totalSize, start, end }     —— 一段
 *   { status: 416, stream: null, totalSize }                 —— 范围越界
 *
 * 三个实现：
 *   local  —— 落在 UPLOAD_DIR，默认，没配 MinIO 时行为和改造前完全一样；
 *   s3     —— MinIO / 任意 S3 兼容服务，只在 Docker 内网可达（见 deploy/docker-compose.yml）；
 *   memory —— 测试用。抽出这一层就是为了不必在 CI 里真起一个 MinIO 容器。
 *
 * ⚠️ 测试覆盖的边界：memory / local 两个实现被完整覆盖，s3 实现只有签名部分
 * （test/s3-sign.test.js，跑的是 AWS 官方向量）和 URL 拼装被覆盖，真实的
 * MinIO HTTP 往返、桶策略、错误码没有任何自动化用例。**Range 透传给 MinIO 这条
 * 尤其没有被真实服务覆盖**：用例里的假桶是我们自己写的 Node http server，
 * 它按我们理解的语义回 206/416，MinIO 真实的行为（比如 `bytes=-0`、超大 end）
 * 只能靠 deploy/README.md 的上线自检清单人工过一遍。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { encodeS3Path, signS3Request } from './s3-sign.js';
import { parseContentRange, parseRange, totalFromContentRange } from './range.js';

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

/**
 * 一个文件的 sha256（十六进制）。流式算，内存恒定 —— 100MB 的视频也只占一个流缓冲。
 * SigV4 的 payload hash 用它，见下面 putStreamed 里那段「为什么读两遍」。
 */
export async function sha256OfFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * local / memory 共用的 Range 落地逻辑：自己解析 Range，自己切。
 * （s3 不走这里 —— 那一档把 Range 原样透传给 MinIO，用它返回的流，见下面的注释。）
 *
 * @param {string|undefined} range 原始 Range 请求头
 * @param {number} totalSize       对象总长
 * @param {(start:number, end:number) => import('node:stream').Readable} makeStream
 */
function sliceForRange(range, totalSize, makeStream) {
  const parsed = parseRange(range, totalSize);
  if (!parsed) {
    return { status: 200, stream: makeStream(0, Math.max(0, totalSize - 1)), size: totalSize, totalSize };
  }
  if (parsed.unsatisfiable) return { status: 416, stream: null, totalSize };
  const { start, end } = parsed;
  return { status: 206, stream: makeStream(start, end), size: end - start + 1, totalSize, start, end };
}

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
    /**
     * 从临时文件落盘。先试 rename：中转目录和 UPLOAD_DIR 在同一个文件系统上
     * （见 db.js 的 UPLOAD_TMP_DIR），一次 syscall 就搬完，100MB 的视频不必读写两遍。
     * 跨设备（有人把 DATA_DIR 里的 uploads 单独挂了个卷）时 rename 会 EXDEV，退回拷贝。
     *
     * rename 会**把临时文件搬走**，调用方随后的清理因此是空操作 —— 那边用的是
     * `rm(force:true)`，文件已经不在也不报错，「不留临时文件」这个约束照样成立。
     */
    async putFile(key, path) {
      const target = join(dir, key);
      try {
        renameSync(path, target);
      } catch (err) {
        if (err?.code !== 'EXDEV') throw err;
        await copyFile(path, target);
      }
    },
    async get(key) {
      if (!isSafeKey(key)) return null;
      try {
        return readFileSync(join(dir, key));
      } catch {
        return null;                              // ENOENT / EISDIR 一律当「没有」
      }
    },
    async open(key, { range } = {}) {
      if (!isSafeKey(key)) return null;
      const full = join(dir, key);
      let info;
      try {
        info = statSync(full);
      } catch {
        return null;                              // ENOENT 一律当「没有」，交给上层回落
      }
      if (!info.isFile()) return null;            // 目录不是对象
      return sliceForRange(range, info.size, (start, end) =>
        // 空文件时 start=0/end=-1，createReadStream 会拒绝负的 end，单独给个空流。
        (info.size === 0 ? Readable.from([]) : createReadStream(full, { start, end })));
    },
    async remove(key) {
      if (!isSafeKey(key)) return false;
      rmSync(join(dir, key), { force: true });
      return true;
    },
  };
}

/** 把一个 Buffer 按 64KB 切成一串块（内存实现用，见下面 open 里的说明）。 */
function* chunksOf(buffer, size = 64 * 1024) {
  for (let at = 0; at < buffer.length; at += size) yield buffer.subarray(at, Math.min(at + size, buffer.length));
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
    // 测试实现，整份读进内存无所谓：真实驱动里这一步才是流式的。
    async putFile(key, path, contentType) {
      objects.set(key, { buffer: readFileSync(path), contentType });
    },
    async get(key) {
      return objects.has(key) ? objects.get(key).buffer : null;
    },
    async open(key, { range } = {}) {
      if (!objects.has(key)) return null;
      const { buffer } = objects.get(key);
      return sliceForRange(range, buffer.length, (start, end) =>
        // 故意按 64KB 分块，和 fs.createReadStream / undici 一致：整块一次推完的话
        // 背压根本不会发生，用例里的流式行为就和真实驱动对不上了（客户端中途断开
        // 那一组尤其会变成假绿）。
        Readable.from(chunksOf(buffer.subarray(start, end + 1))));
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
  const sendPath = async (method, path, { payload = Buffer.alloc(0), contentType, range } = {}) => {
    const { headers } = signS3Request({
      method,
      host,
      path,
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        // Range 也一起签：签名覆盖的头必须和实际发出去的头逐字一致，
        // 签了不发 / 发了不签，MinIO 都会回 403 SignatureDoesNotMatch。
        ...(range ? { range } : {}),
      },
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

  /**
   * 流式 PUT。SigV4 要求签名覆盖**整个 payload 的 sha256**，所以只能读两遍：
   *
   *   第一遍  createReadStream → createHash('sha256')，算出精确的 payload hash；
   *   第二遍  createReadStream 直接当请求体发出去。
   *
   * 两次磁盘读，内存恒定（只有 64KB 的流缓冲），签名仍然是精确的。
   *
   * **有意不用 UNSIGNED-PAYLOAD。** 那样确实能省掉第一遍读，但签名就不再覆盖正文了：
   * 任何能在我们和 MinIO 之间插一脚的人都能改写对象内容而签名照样有效。
   * 内网也不是理由——这条性质现在就有，没必要为了一次磁盘读把它交出去。
   *
   * Content-Length 必须显式给：请求体是流，不给的话 undici 会用 chunked 编码，
   * 而 S3 不接受没有 aws-chunked 声明的分块上传。它不在签名头里，SigV4 只校验
   * SignedHeaders 列出来的那些，多发一个头不影响签名。
   */
  const putStreamed = async (path, filePath, contentType) => {
    const { size } = statSync(filePath);
    const payloadHash = await sha256OfFile(filePath);
    const { headers } = signS3Request({
      method: 'PUT',
      host,
      path,
      headers: contentType ? { 'content-type': contentType } : {},
      payloadHash,
      accessKeyId,
      secretAccessKey,
      region,
    });
    return fetch(`${base}${encodeS3Path(path)}`, {
      method: 'PUT',
      headers: { ...headers, 'content-length': String(size) },
      body: Readable.toWeb(createReadStream(filePath)),
      duplex: 'half',
    });
  };

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
    async putFile(key, path, contentType) {
      const res = await putStreamed(pathOf(key), path, contentType);
      if (!res.ok) throw new Error(`对象存储写入失败（${res.status}）`);
    },
    async get(key) {
      if (!isSafeKey(key)) return null;
      const res = await send('GET', key);
      if (res.status === 404 || res.status === 403) return null;   // 没有就是没有，交给调用方回落
      if (!res.ok) throw new Error(`对象存储读取失败（${res.status}）`);
      return Buffer.from(await res.arrayBuffer());
    },
    /**
     * 流式读 + Range **透传**。我们不自己解析 Range，原样交给 MinIO，
     * 用它返回的 206/416 和 Content-Range —— 少一处需要和上游对齐语义的实现。
     * 返回的是 res.body 这个 web 流转成的 Node 流，字节从 MinIO 一路流到浏览器，不进堆。
     */
    async open(key, { range } = {}) {
      if (!isSafeKey(key)) return null;
      const res = await send('GET', key, { range });
      if (res.status === 404 || res.status === 403) {
        await res.body?.cancel();
        return null;                                              // 交给调用方回落到本地
      }
      if (res.status === 416) {
        await res.body?.cancel();
        // 上游的 416 会带 `Content-Range: bytes * /总长`，总长从那里捞。
        return { status: 416, stream: null, totalSize: totalFromContentRange(res.headers.get('content-range')) };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`对象存储读取失败（${res.status}）`);
      }
      const stream = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
      if (res.status === 206) {
        const cr = parseContentRange(res.headers.get('content-range'));
        // 上游说是 206 却给不出可解析的 Content-Range：宁可当整份处理，也不要拼出错误的头。
        if (!cr) {
          const size = Number(res.headers.get('content-length'));
          return { status: 200, stream, size, totalSize: size };
        }
        return { status: 206, stream, size: cr.end - cr.start + 1, totalSize: cr.total, start: cr.start, end: cr.end };
      }
      const size = Number(res.headers.get('content-length'));
      return { status: 200, stream, size, totalSize: size };
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
