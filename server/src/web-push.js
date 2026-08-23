/**
 * Web Push 的加密与协议层（RFC 8291 内容加密 + RFC 8292 VAPID）。
 *
 * 这个模块是**纯函数层**：不碰数据库、不碰 Express、不碰路由。
 * 输入订阅信息和明文，输出一次符合规范的 HTTPS 请求。
 *
 * ── 为什么手写而不是用 `web-push` 包 ─────────────────────────
 * `web-push` 最新版是 3.6.7（2024-01-16，停更两年半），带 5 个传递依赖，
 * 其中一个是 `minimist`。而 RFC 8291 §5 给了**完整的官方测试向量**——
 * 明文、salt、收发双方密钥对、直到最终密文全都写死在规范里。
 * 也就是说这 100 多行代码的正确性可以被**逐字节证明**，不是「看起来对」。
 * Node 22/24 原生提供全部原语（createECDH / hkdfSync / aes-128-gcm），
 * 签 VAPID JWT 用的 `jsonwebtoken` 本来就是依赖。
 * 对照测试见 `test/web-push-vectors.test.js`。
 *
 * ── 日志红线 ─────────────────────────────────────────────
 * 这里经手的是消息正文的明文和密文。**任何情况下都不记正文**，
 * 也不记完整 endpoint（它是设备的长期标识符）——只记 endpoint 的 host、
 * HTTP 状态码和 userId。见 `log.js` 顶部那段红线。
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { logWarn } from './log.js';

// ── 常量：这些字节一个都不能错，错了的表现是「推送 201 成功但设备解不开」 ──

/** RFC 8291 §3.3：第一段 HKDF 的 info 前缀，后面接 0x00 || ua_public || as_public。 */
const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0', 'utf8');
/** RFC 8188 §2.2：内容加密密钥的 info。 */
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
/** RFC 8188 §2.2：nonce 的 info。 */
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8');

const CURVE = 'prime256v1';           // 即 P-256 / secp256r1
const SALT_LENGTH = 16;               // RFC 8188 §2.1 固定 16 字节
const KEY_LENGTH = 16;                // aes128gcm
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;                // GCM authentication tag
const PUBLIC_KEY_LENGTH = 65;         // 未压缩的 P-256 公钥：0x04 || X(32) || Y(32)
const PRIVATE_KEY_LENGTH = 32;
const AUTH_SECRET_LENGTH = 16;
/**
 * 记录大小。RFC 8291 §5 的官方向量用的就是 4096，
 * 换一个数字向量就对不上了——所以这是个常量，不是可调参数。
 */
const RECORD_SIZE = 4096;
/** 一条记录里能放下的最大明文：rs - GCM tag - 1 字节的 padding 分隔符。 */
const MAX_PLAINTEXT_LENGTH = RECORD_SIZE - TAG_LENGTH - 1;

/** VAPID JWT 的有效期。RFC 8292 §2 的硬上限是 24 小时，这里留一半余量。 */
const JWT_TTL_SECONDS = 12 * 60 * 60;
const JWT_MAX_TTL_SECONDS = 24 * 60 * 60;

/**
 * 这些主机名推送服务方连不上，苹果还会直接 403 BadJwtToken 拒掉。
 * 见 docs/PWA-与推送改造方案.md A.1 ④。
 */
const NON_ROUTABLE_HOSTS = new Set(['localhost', 'localhost.localdomain']);
const NON_ROUTABLE_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.test', '.invalid', '.example'];

// ── base64url ──────────────────────────────────────────────────────────

/** Buffer → base64url（无填充）。 */
export function encodeBase64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * base64url → Buffer；不是合法 base64url 就返回 null（而不是抛，也不是悄悄返回半截）。
 *
 * Node 的 `Buffer.from(s, 'base64url')` 对垃圾输入是**静默丢弃**非法字符的，
 * `Buffer.from('!!!!', 'base64url')` 返回空 Buffer 而不报错。
 * 调用方（2B 的订阅校验）要靠这个函数判「格式对不对」，所以先用正则把关。
 */
export function decodeBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64url');
  return buf.length > 0 ? buf : null;
}

/** 解码并要求长度精确匹配，否则 null。 */
function decodeFixed(value, length) {
  const buf = decodeBase64Url(value);
  return buf && buf.length === length ? buf : null;
}

/**
 * 两段 HKDF 的密钥派生，单独拆出来是为了让测试能直接对 RFC 8291 §5
 * 给出的中间值（ecdh_secret / IKM / CEK / NONCE）。
 * 只对最终密文断言的话，某一步错了只能看到「结果不对」，看不出错在哪一步。
 */
function deriveKeys({ uaPublic, asPublic, sharedSecret, authSecret, salt }) {
  // 第一段（RFC 8291 §3.3）：用 auth_secret 当 salt，把 ECDH 结果拉成 IKM。
  // info 里 ua_public 在前、as_public 在后——顺序反了同样是「能发出去、解不开」。
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  // 第二段（RFC 8188 §2.2）：用消息 salt 派生 CEK 和 nonce。
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, CEK_INFO, KEY_LENGTH));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, NONCE_INFO, NONCE_LENGTH));
  return { keyInfo, ikm, cek, nonce };
}

// ── RFC 8291：内容加密 ──────────────────────────────────────────────────

/**
 * 按 RFC 8291 加密一条推送正文，返回可以直接当请求体发出去的 Buffer。
 *
 * 输出格式是 RFC 8188 的 aes128gcm：
 *   salt(16) || rs(4, 大端) || idlen(1) || as_public(65) || 密文+GCM tag
 *
 * @param {object} args
 * @param {string} args.p256dh       订阅里的 `keys.p256dh`，base64url 的 65 字节未压缩公钥
 * @param {string} args.auth         订阅里的 `keys.auth`，base64url 的 16 字节认证密钥
 * @param {string|Buffer} args.plaintext  正文（字符串按 UTF-8 编码）
 * @param {Buffer} [args.salt]              **仅供测试注入**；生产路径走 randomBytes(16)
 * @param {Buffer} [args.senderPrivateKey]  **仅供测试注入**；生产路径每条消息现生成一对
 * @returns {Buffer}
 */
export function encryptPayload({ p256dh, auth, plaintext, salt, senderPrivateKey }) {
  const uaPublic = decodeFixed(p256dh, PUBLIC_KEY_LENGTH);
  if (!uaPublic || uaPublic[0] !== 0x04) {
    throw new Error('p256dh 不是合法的 base64url P-256 未压缩公钥（应为 65 字节且以 0x04 开头）');
  }
  const authSecret = decodeFixed(auth, AUTH_SECRET_LENGTH);
  if (!authSecret) {
    throw new Error('auth 不是合法的 base64url 认证密钥（解码后应为 16 字节）');
  }

  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext ?? ''), 'utf8');
  if (body.length > MAX_PLAINTEXT_LENGTH) {
    // 我们只发一条记录。要发更长的正文就得实现多记录分片，
    // 而推送正文本来就该短——这里直接拒绝，不要悄悄截断。
    throw new Error(`推送正文过长：${body.length} 字节，单条记录上限 ${MAX_PLAINTEXT_LENGTH} 字节`);
  }

  const realSalt = salt ?? randomBytes(SALT_LENGTH);
  if (realSalt.length !== SALT_LENGTH) throw new Error('salt 必须是 16 字节');

  // 发送方（我们）的临时密钥对：每条消息一对，绝不复用。
  const ecdh = createECDH(CURVE);
  if (senderPrivateKey) {
    if (senderPrivateKey.length !== PRIVATE_KEY_LENGTH) throw new Error('senderPrivateKey 必须是 32 字节');
    ecdh.setPrivateKey(senderPrivateKey);
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();       // 65 字节未压缩
  let sharedSecret;
  try {
    sharedSecret = ecdh.computeSecret(uaPublic);
  } catch {
    // 长度对、首字节也对，但那个点根本不在 P-256 曲线上。
    // 不裸抛 crypto 的原始错误——调用方看到「Public key is not valid for specified curve」
    // 是猜不到问题出在订阅的 p256dh 上的。
    throw new Error('p256dh 不是 P-256 曲线上的有效公钥点（这条订阅存坏了，应当删掉）');
  }

  const { cek, nonce } = deriveKeys({ uaPublic, asPublic, sharedSecret, authSecret, salt: realSalt });

  // RFC 8188 §2：每条记录的明文末尾要有分隔符，最后一条记录用 0x02。
  // 我们只发一条记录，所以永远是 0x02。
  // 不做 padding：见 docs 的 §D.8「不做的事」。
  const padded = Buffer.concat([body, Buffer.from([0x02])]);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([realSalt, rs, Buffer.from([asPublic.length]), asPublic]);

  return Buffer.concat([header, ciphertext]);
}

// ── RFC 8292：VAPID ────────────────────────────────────────────────────

/**
 * 校验 VAPID 的 `sub`。
 *
 * ⚠️ 这条不是形式主义。苹果的推送服务（web.push.apple.com）对 `sub` 的校验
 * 比 FCM / Mozilla 严得多：`mailto:x@localhost` 会被 403 BadJwtToken 直接拒掉。
 * 也就是**本地开发全绿、上生产 iPhone 一条都收不到**，而服务端看到的
 * 只是一个 403，不会告诉你是 sub 的问题。所以在这一层就拦掉。
 * 出处：https://github.com/openclaw/openclaw/issues/83134
 *
 * @param {string} subject
 * @returns {{ ok: boolean, reason?: 'invalid_subject'|'subject_not_routable', message?: string }}
 */
export function validateVapidSubject(subject) {
  if (typeof subject !== 'string' || subject.trim() === '') {
    return { ok: false, reason: 'invalid_subject', message: 'VAPID subject 为空，必须是 mailto: 邮箱或 https:// URL' };
  }
  const value = subject.trim();
  let host = null;
  if (value.startsWith('mailto:')) {
    const address = value.slice('mailto:'.length);
    const at = address.lastIndexOf('@');
    if (at <= 0 || at === address.length - 1) {
      return { ok: false, reason: 'invalid_subject', message: `VAPID subject 不是合法的 mailto: 邮箱：${value}` };
    }
    host = address.slice(at + 1).toLowerCase();
  } else if (value.startsWith('https://')) {
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      return { ok: false, reason: 'invalid_subject', message: `VAPID subject 不是合法的 https:// URL：${value}` };
    }
    if (!host) {
      return { ok: false, reason: 'invalid_subject', message: `VAPID subject 不是合法的 https:// URL：${value}` };
    }
  } else {
    return {
      ok: false,
      reason: 'invalid_subject',
      message: `VAPID subject 必须以 mailto: 或 https:// 开头，当前是：${value}`,
    };
  }

  // IPv6 字面量在 URL 里带方括号，去掉再判。
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
  const isIpv6 = bare.includes(':');
  const notRoutable =
    NON_ROUTABLE_HOSTS.has(bare) ||
    NON_ROUTABLE_SUFFIXES.some((suffix) => bare.endsWith(suffix)) ||
    !bare.includes('.') ||            // 没有点 = 内网短名，公网解析不了
    isIpv4 || isIpv6;

  if (notRoutable) {
    return {
      ok: false,
      reason: 'subject_not_routable',
      message:
        `VAPID subject 的域名「${bare}」不是公网可路由的域名。` +
        '苹果的推送服务会对这种 subject 返回 403 BadJwtToken —— ' +
        '本地测试全绿、上生产 iPhone 一条都收不到。请换成真实域名的 mailto: 或 https:// URL。',
    };
  }
  return { ok: true };
}

/**
 * 校验一对 VAPID 密钥的格式和一致性。
 *
 * 一致性检查不是多余的：公钥私钥对不上时，JWT 照样能签出来，
 * 推送服务拿 `k=` 里的公钥去验签才会失败——又是一个「本地看不出来」的坑。
 *
 * @returns {{ ok: boolean, reason?: 'invalid_key', message?: string }}
 */
export function validateVapidKeys({ publicKey, privateKey }) {
  const pub = decodeFixed(publicKey, PUBLIC_KEY_LENGTH);
  if (!pub || pub[0] !== 0x04) {
    return { ok: false, reason: 'invalid_key', message: 'VAPID 公钥不是合法的 base64url P-256 未压缩公钥（65 字节、以 0x04 开头）' };
  }
  const priv = decodeFixed(privateKey, PRIVATE_KEY_LENGTH);
  if (!priv) {
    return { ok: false, reason: 'invalid_key', message: 'VAPID 私钥不是合法的 base64url P-256 私钥（解码后应为 32 字节）' };
  }
  let derived;
  try {
    const ecdh = createECDH(CURVE);
    ecdh.setPrivateKey(priv);
    derived = ecdh.getPublicKey();
  } catch {
    return { ok: false, reason: 'invalid_key', message: 'VAPID 私钥不在 P-256 曲线的有效范围内' };
  }
  if (derived.length !== pub.length || !timingSafeEqual(derived, pub)) {
    return { ok: false, reason: 'invalid_key', message: 'VAPID 公钥和私钥不是一对（用私钥推出来的公钥和配置的公钥不一致）' };
  }
  return { ok: true };
}

/** 从原始密钥造一个可以签 ES256 的 KeyObject。 */
function privateKeyObject(publicKeyBuf, privateKeyBuf) {
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: encodeBase64Url(publicKeyBuf.subarray(1, 33)),
      y: encodeBase64Url(publicKeyBuf.subarray(33, 65)),
      d: encodeBase64Url(privateKeyBuf),
    },
    format: 'jwk',
  });
}

/**
 * 生成一次推送请求的 RFC 8292 认证头。
 *
 * ⚠️ `aud` 是 **endpoint 的 origin**，不是我们自己的域名。不同订阅可能来自
 * 苹果、Google、Mozilla 三家不同的推送服务，所以 JWT 必须**按 endpoint 分别签**，
 * 不能签一次到处用。这就是这个函数要收 endpoint 的原因。
 *
 * @param {object} args
 * @param {string} args.endpoint    订阅的 endpoint URL
 * @param {string} args.subject     `mailto:` 邮箱或 `https://` URL（真实域名，见 validateVapidSubject）
 * @param {string} args.publicKey   base64url 的 VAPID 公钥（65 字节）
 * @param {string} args.privateKey  base64url 的 VAPID 私钥（32 字节）
 * @param {number} [args.expiresIn] JWT 有效期（秒），默认 12 小时，上限 24 小时
 * @returns {Record<string,string>}  形如 `{ Authorization: 'vapid t=..., k=...' }`
 */
export function vapidHeaders({ endpoint, subject, publicKey, privateKey, expiresIn = JWT_TTL_SECONDS }) {
  let audience;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('protocol');
    audience = url.origin;
  } catch {
    throw new Error(`推送 endpoint 不是合法的 https:// URL：${String(endpoint)}`);
  }

  const subjectCheck = validateVapidSubject(subject);
  if (!subjectCheck.ok) throw new Error(subjectCheck.message);

  const keyCheck = validateVapidKeys({ publicKey, privateKey });
  if (!keyCheck.ok) throw new Error(keyCheck.message);

  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > JWT_MAX_TTL_SECONDS) {
    throw new Error(`VAPID JWT 的有效期必须在 1 秒到 24 小时之间，当前是 ${expiresIn} 秒`);
  }

  const pub = decodeFixed(publicKey, PUBLIC_KEY_LENGTH);
  const priv = decodeFixed(privateKey, PRIVATE_KEY_LENGTH);
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { aud: audience, exp: now + Math.floor(expiresIn), sub: subject.trim() },
    privateKeyObject(pub, priv),
    // noTimestamp：RFC 8292 §2 只要求 aud / exp / sub 三个声明，`iat` 是 jsonwebtoken
    // 自作主张加的。去掉它，JWT 的 payload 就和 RFC 8292 §2.4 的例子逐字节一致，
    // 测试因此能对官方例子做字节级断言，而不是只能断言「有这几个字段」。
    { algorithm: 'ES256', noTimestamp: true },
  );

  // RFC 8292 §3.1 的 `vapid` 认证方案：t 是 JWT，k 是 base64url 的公钥。
  return { Authorization: `vapid t=${token}, k=${encodeBase64Url(pub)}` };
}

// ── 发送 ───────────────────────────────────────────────────────────────

/**
 * 推送服务返回这两个码 = 这条订阅已经死了，调用方**必须**把它从库里删掉。
 *
 * 404：endpoint 不存在（订阅早就被推送服务回收了）。
 * 410 Gone：RFC 8030 §7.3 明确的「订阅已失效」。
 *
 * 其它任何状态码（401/403 配置错、429 限流、5xx 服务端抽风、0 网络不通）
 * 都是**临时失败**，删订阅会误伤。这个判断放在这一层给出，
 * 不让每个调用方各自去猜 HTTP 码的含义。
 */
export function isGoneStatus(status) {
  return status === 404 || status === 410;
}

/** 从环境变量取 VAPID 配置。2E 会做启动自检，这里只是给 sendPush 一个默认来源。 */
function vapidFromEnv() {
  return {
    subject: process.env.VAPID_SUBJECT,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
}

/**
 * 发一次推送。用全局 `fetch`，不引 HTTP 客户端。
 *
 * 不重试：见 §D.8。推送只是提醒，消息本身在 SSE 和数据库里都在，
 * 为一条晚到的提醒建一套持久化重试队列不划算。
 *
 * @param {object} args
 * @param {{ endpoint: string, keys?: { p256dh: string, auth: string }, p256dh?: string, auth?: string }} args.subscription
 * @param {string|Buffer} args.payload    推送正文明文（会在这里加密）
 * @param {number} [args.ttl=86400]       推送服务替我们保存多久（秒）
 * @param {'very-low'|'low'|'normal'|'high'} [args.urgency='normal']
 * @param {{ subject: string, publicKey: string, privateKey: string }} [args.vapid]  默认读环境变量
 * @param {string} [args.userId]          只用于日志
 * @param {typeof fetch} [args.fetchImpl] 只用于测试注入
 * @returns {Promise<{ ok: boolean, status: number, gone: boolean }>}
 *          `gone: true` 表示订阅已失效，调用方必须删掉它。
 */
export async function sendPush({
  subscription,
  payload,
  ttl = 86400,
  urgency = 'normal',
  vapid = vapidFromEnv(),
  userId,
  fetchImpl,
}) {
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh ?? subscription?.p256dh;
  const auth = subscription?.keys?.auth ?? subscription?.auth;

  // endpoint 的 host 是唯一允许进日志的部分：它只说明「哪家推送服务」，
  // 不包含设备标识（那在 path 里）。
  let host = 'unknown';
  try {
    host = new URL(endpoint).host;
  } catch {
    /* 下面的 vapidHeaders 会给出更准确的报错 */
  }

  let body;
  let headers;
  try {
    body = encryptPayload({ p256dh, auth, plaintext: payload });
    headers = {
      ...vapidHeaders({ endpoint, ...vapid }),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    };
  } catch (err) {
    // 配置或订阅数据本身有问题。这不是「推送服务拒绝了」，
    // 所以 gone 一定是 false —— 别因为自己配错了就把用户的订阅删了。
    logWarn('push.send_invalid', { host, userId, reason: err.message });
    return { ok: false, status: 0, gone: false };
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  let status = 0;
  try {
    const res = await doFetch(endpoint, { method: 'POST', headers, body });
    status = res.status;
  } catch (err) {
    // 网络层没通。临时失败，不删订阅。
    logWarn('push.send_failed', { host, userId, status: 0, reason: err?.message ?? String(err) });
    return { ok: false, status: 0, gone: false };
  }

  const ok = status >= 200 && status < 300;
  const gone = isGoneStatus(status);
  if (!ok) logWarn('push.send_rejected', { host, userId, status, gone });
  return { ok, status, gone };
}

/** 测试用：把内部常量和中间步骤露出来，省得测试里再抄一遍魔数。 */
export const __internals = {
  KEY_INFO_PREFIX,
  CEK_INFO,
  NONCE_INFO,
  RECORD_SIZE,
  MAX_PLAINTEXT_LENGTH,
  JWT_MAX_TTL_SECONDS,
  deriveKeys,
  /** 给测试对 RFC 8291 §5 的中间值用：从两边的原始密钥算出 ECDH 共享密钥和三个派生结果。 */
  deriveFromRawKeys({ uaPublic, asPrivate, authSecret, salt }) {
    const ecdh = createECDH(CURVE);
    ecdh.setPrivateKey(asPrivate);
    const asPublic = ecdh.getPublicKey();
    const sharedSecret = ecdh.computeSecret(uaPublic);
    return { asPublic, sharedSecret, ...deriveKeys({ uaPublic, asPublic, sharedSecret, authSecret, salt }) };
  },
};
