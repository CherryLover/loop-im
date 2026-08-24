/**
 * Web Push 的 VAPID 配置与**启动自检**。
 *
 * 三个环境变量，要么三个都配、要么一个都不配：
 *   VAPID_PUBLIC_KEY   base64url 的未压缩 P-256 公钥点（65 字节，0x04 开头）
 *   VAPID_PRIVATE_KEY  base64url 的 P-256 私钥标量（32 字节）
 *   VAPID_SUBJECT      真实域名的 mailto: 邮箱或 https:// URL
 *
 * ── 为什么配错了也不退出进程 ─────────────────────────────────────
 * 附件存储那一档（src/index.js 顶部）自检失败会 process.exit，因为它是核心路径：
 * 容器 Up、聊天能用、只有发图坏，这种半开状态比不启动更难查。
 * **推送不是核心路径** —— 不配推送，聊天、SSE、附件一切照旧，只是手机上不响。
 * 所以这里的处理是「关掉推送 + 打一行日志说清为什么」，绝不 exit、绝不抛。
 *
 * ── 为什么校验放在启动时而不是发第一条推送时 ─────────────────────
 * 推送是**发射后不管**的旁路（见方案 §C），出了错既没人看着、也不会有响应码回到用户。
 * 配错了的真实症状是「用户说收不到通知」，而服务端日志里什么都没有 ——
 * 等到那一步再排查，成本比启动时多一行 warn 高一个数量级。
 *
 * ── VAPID_SUBJECT 为什么值得单独写这么多校验 ─────────────────────
 * 苹果的推送服务（web.push.apple.com）对 VAPID JWT 的 sub 声明校验**比别家严**：
 * 必须是真实域名的 mailto: 或 https:// URL，`mailto:x@localhost` 这类会被直接
 * 403 BadJwtToken 拒掉，而 FCM / Mozilla 是接受的。
 * 也就是说这个错误的表现形式是：**本地和安卓全绿，上生产 iPhone 一条都收不到**，
 * 服务端只看到一个不解释原因的 403。这是本块最容易踩、又最难自己发现的坑，
 * 所以宁可在启动时把话说满。
 * 出处：<https://github.com/openclaw/openclaw/issues/83134>
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { logEvent, logWarn } from './log.js';

/**
 * 所有「推送被关掉」的原因。测试和文档都引这里，别在别处写字符串字面量。
 *
 * not_configured 是**正常状态**（默认就不开推送），其余四个都是配了但配错了。
 * 两者都走同一条路（关闭 + 一行 warn），区别只在 detail 里说的话。
 */
export const VAPID_DISABLED_REASONS = Object.freeze({
  /** 三个变量一个都没配 —— 这是默认状态，不是错误。 */
  NOT_CONFIGURED: 'not_configured',
  /** 配了一部分。整体关闭，不进入「半开」。 */
  PARTIAL_CONFIG: 'partial_config',
  /** 公钥 / 私钥格式不对，或两把钥匙不是一对。 */
  INVALID_KEY: 'invalid_key',
  /** subject 既不是 mailto: 也不是 https://。 */
  INVALID_SUBJECT: 'invalid_subject',
  /** subject 的域名不是公网可路由的（localhost / .local / 纯 IP / 单标签主机名）。 */
  SUBJECT_NOT_ROUTABLE: 'subject_not_routable',
});

/** 三个变量的名字集中放一处，日志和报错里提到它们时不要手打。 */
const ENV_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];

/**
 * 保留 / 不可路由的顶级域和主机名。
 *
 * 前四个是 RFC 2606 / RFC 6761 明文保留、永远不会被解析到公网的；
 * .local 是 mDNS（RFC 6762）；.internal 是 ICANN 2024 年划给私有网络的；
 * 剩下几个是各家路由器和内网 DNS 的事实约定。
 * 这些域名在**我们自己的网络里**可能好好的，但苹果那边看到的是一个不存在的域名。
 */
const NON_ROUTABLE_TLDS = new Set([
  // localdomain：`localhost.localdomain` 是多数 Linux 发行版 /etc/hosts 里的默认条目，
  // 填进来的概率不低。合并这一批时 web-push.js 拦了它、这里没拦，
  // 方向正好是最坏的那个（启动说「已启用」、每条推送都被发送前那道检查挡掉），
  // 由 test/vapid-validator-parity.test.js 当场抓出来。
  'localhost', 'localdomain', 'test', 'invalid', 'example',
  'local', 'internal', 'home', 'lan', 'intranet', 'corp',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** base64url 的合法字符集：不含 +、/、=。标准 base64 会在这里被拦下并给专门的提示。 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const trimmed = (value) => String(value ?? '').trim();

/**
 * 严格解 base64url。
 *
 * 必须严格：`Buffer.from(s, 'base64url')` 会**默默跳过**不认识的字符，
 * 一串带空格或换行的垃圾也能解出个 Buffer 来。所以先卡字符集，
 * 解完再原样编回去比一遍 —— 只有能来回一致的才算真的合法。
 */
function decodeBase64url(value) {
  if (!BASE64URL.test(value)) return null;
  const buf = Buffer.from(value, 'base64url');
  return buf.toString('base64url') === value ? buf : null;
}

/** 一眼看出用户是不是贴了标准 base64（含 + / =），这个错太常见，值得单独说一句。 */
const looksLikeStandardBase64 = (value) => /[+/=]/.test(value);

/**
 * 主机名是不是公网可路由的。
 *
 * 这里只做**形状**判断，不做 DNS 查询：启动自检不该依赖网络，
 * 而且内网 DNS 能解析出来的名字（比如 im.corp）在苹果那边照样不存在。
 */
function hostProblem(host) {
  const name = host.toLowerCase().replace(/\.$/, '');       // 去掉根域的那个尾点
  if (!name) return '域名是空的';
  // localhost 单独点名：它是这块最经典的一个错，报「只有一级」不如直接说破。
  if (name === 'localhost') return 'localhost 只在这台机器上存在';
  if (name.startsWith('[') || name.includes(':')) return `${host} 是 IP 地址（IPv6），不是域名`;
  if (IPV4.test(name)) return `${host} 是 IP 地址，不是域名`;
  const labels = name.split('.');
  if (labels.length < 2) return `${host} 只有一级，不是完整域名`;
  if (labels.some((label) => label === '')) return `${host} 里有空的一段`;
  const tld = labels[labels.length - 1];
  if (NON_ROUTABLE_TLDS.has(tld)) return `.${tld} 是保留 / 内网专用域名，公网上不存在`;
  return null;
}

/**
 * 校验 VAPID_SUBJECT。
 *
 * 单独导出是给 2A（web-push.js）做双保险用的：那边在真的签 JWT 之前还要再拦一道，
 * 免得有人绕过启动自检直接调底层函数。两边必须是**同一个**判定，不许各写一份。
 *
 * @param {string} subject
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string, hint: string }}
 */
export function validateSubject(subject) {
  const value = trimmed(subject);
  const bad = (reason, detail, hint) => ({ ok: false, reason, detail, hint });
  const INVALID = VAPID_DISABLED_REASONS.INVALID_SUBJECT;
  const NOT_ROUTABLE = VAPID_DISABLED_REASONS.SUBJECT_NOT_ROUTABLE;

  // 这句提示在两种失败里都要出现，所以抽出来：它是这块唯一「不写清楚就一定会踩」的知识。
  const APPLE = '苹果的推送服务会用 403 BadJwtToken 拒掉，本地和安卓却全绿';

  if (!value) {
    return bad(INVALID, 'VAPID_SUBJECT 是空的', '填真实域名的 mailto: 邮箱或 https:// 网址，例如 mailto:admin@im.example.com');
  }
  if (/\s/.test(value)) {
    return bad(INVALID, `VAPID_SUBJECT 里有空白字符：${value}`, '整个值必须是一个 URL，中间不能有空格或换行');
  }

  if (value.toLowerCase().startsWith('mailto:')) {
    const address = value.slice('mailto:'.length);
    if (address.includes(',')) {
      return bad(INVALID, 'VAPID_SUBJECT 里写了多个邮箱地址', 'VAPID 的 sub 只能是一个地址，去掉逗号后面的部分');
    }
    if (address.includes('?')) {
      return bad(INVALID, 'VAPID_SUBJECT 的 mailto: 里带了参数（?subject= 之类）', '只保留邮箱地址本身');
    }
    const at = address.lastIndexOf('@');
    if (at <= 0 || at === address.length - 1) {
      return bad(INVALID, `VAPID_SUBJECT 不是一个邮箱地址：${value}`, '格式是 mailto:someone@your-domain.com');
    }
    const problem = hostProblem(address.slice(at + 1));
    if (problem) {
      return bad(NOT_ROUTABLE, `VAPID_SUBJECT 的邮箱域名不可路由（${problem}），${APPLE}`, '换成你们真实对外域名的邮箱，例如 mailto:admin@im.example.com');
    }
    return { ok: true };
  }

  if (value.toLowerCase().startsWith('https://')) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return bad(INVALID, `VAPID_SUBJECT 不是一个能解析的网址：${value}`, '格式是 https://your-domain.com/contact');
    }
    const problem = hostProblem(url.hostname);
    if (problem) {
      return bad(NOT_ROUTABLE, `VAPID_SUBJECT 的域名不可路由（${problem}），${APPLE}`, '换成你们真实对外的域名，例如 https://im.example.com/contact');
    }
    return { ok: true };
  }

  // http:// 单独说一句：这是仅次于 localhost 的第二常见写法，且原因不直观。
  if (value.toLowerCase().startsWith('http://')) {
    return bad(INVALID, `VAPID_SUBJECT 用了 http://，RFC 8292 只认 mailto: 和 https://：${value}`, '把 http:// 改成 https://，或者干脆写成 mailto:admin@你们的域名');
  }

  return bad(INVALID, `VAPID_SUBJECT 既不是 mailto: 也不是 https://：${value}`, '只有这两种前缀合法，例如 mailto:admin@im.example.com 或 https://im.example.com/contact');
}

/**
 * 校验公钥 / 私钥这一对。
 *
 * 三层，一层比一层贵，所以按这个顺序：
 *   1. 编码与长度 —— 挡住粘贴出错、粘漏一截、公私钥填反；
 *   2. 能不能导入成 P-256 密钥 —— 挡住「长度对但点不在曲线上」的乱码；
 *   3. **签一次验一次** —— 挡住「两把钥匙各自都合法，但不是一对」。
 *
 * 第 3 层不能省：Node 从 JWK 导入 EC 私钥时**不检查** d 和 (x, y) 是否匹配，
 * 导进去一切正常，直到推送打过去被对方以「签名验不过」拒掉。
 * 这种错的来源很现实：两次跑生成脚本，公钥抄了第一次的、私钥抄了第二次的。
 */
function validateKeys(publicKey, privateKey) {
  const bad = (detail, hint) => ({ ok: false, reason: VAPID_DISABLED_REASONS.INVALID_KEY, detail, hint });
  const b64hint = '用 node scripts/generate-vapid-keys.mjs 重新生成一对，整行复制，别手打';

  const pub = decodeBase64url(publicKey);
  if (!pub) {
    return looksLikeStandardBase64(publicKey)
      ? bad('VAPID_PUBLIC_KEY 是标准 base64（含 + / = 这些字符），VAPID 要的是 base64url', b64hint)
      : bad('VAPID_PUBLIC_KEY 不是合法的 base64url', b64hint);
  }
  const priv = decodeBase64url(privateKey);
  if (!priv) {
    return looksLikeStandardBase64(privateKey)
      ? bad('VAPID_PRIVATE_KEY 是标准 base64（含 + / = 这些字符），VAPID 要的是 base64url', b64hint)
      : bad('VAPID_PRIVATE_KEY 不是合法的 base64url', b64hint);
  }

  // 65 字节 = 0x04 + 32 字节 X + 32 字节 Y，未压缩点格式，浏览器 subscribe() 也只认这个。
  if (pub.length === 32 && priv.length === 65) {
    return bad('VAPID_PUBLIC_KEY 和 VAPID_PRIVATE_KEY 填反了（65 字节的是公钥，32 字节的是私钥）', '把两行的值对调一下');
  }
  if (pub.length !== 65 || pub[0] !== 0x04) {
    return bad(`VAPID_PUBLIC_KEY 不是未压缩的 P-256 公钥点（要 65 字节、0x04 开头，实际 ${pub.length} 字节、0x${pub[0]?.toString(16).padStart(2, '0') ?? '??'} 开头）`, b64hint);
  }
  if (priv.length !== 32) {
    return bad(`VAPID_PRIVATE_KEY 不是 P-256 私钥（要 32 字节，实际 ${priv.length} 字节）`, b64hint);
  }

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: pub.subarray(1, 33).toString('base64url'),
    y: pub.subarray(33, 65).toString('base64url'),
  };
  try {
    const secret = createPrivateKey({ key: { ...jwk, d: priv.toString('base64url') }, format: 'jwk' });
    const publik = createPublicKey({ key: jwk, format: 'jwk' });
    const probe = Buffer.from('loop-im vapid self-check');
    // ieee-p1363 是 ES256 的签名编码，和 2A 签 JWT 时用的是同一档，顺带把那条路也验了。
    const signature = sign('sha256', probe, { key: secret, dsaEncoding: 'ieee-p1363' });
    if (!verify('sha256', probe, { key: publik, dsaEncoding: 'ieee-p1363' }, signature)) {
      return bad('VAPID 公钥和私钥不是一对（各自格式都对，但签名验不过）', '重新生成一对，两行一起换；混用两次生成的结果是最常见的原因');
    }
  } catch (err) {
    return bad(`VAPID 密钥导入失败：${err.message}`, b64hint);
  }

  return { ok: true };
}

/**
 * 读一份环境变量，判出推送该开还是该关。
 *
 * **纯函数**：不读全局状态（env 显式传）、不打日志、不缓存、不抛。
 * 所有分支都能在测试里一句话构造出来，这是这个模块能被钉死的前提。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ enabled: true, publicKey: string, privateKey: string, subject: string }
 *          | { enabled: false, reason: string, detail: string, hint: string,
 *              publicKey: null, privateKey: null, subject: null }}
 */
export function readVapidConfig(env = process.env) {
  const off = (reason, detail, hint) => ({
    enabled: false, reason, detail, hint, publicKey: null, privateKey: null, subject: null,
  });

  const publicKey = trimmed(env.VAPID_PUBLIC_KEY);
  const privateKey = trimmed(env.VAPID_PRIVATE_KEY);
  const subject = trimmed(env.VAPID_SUBJECT);

  const present = [publicKey, privateKey, subject].filter(Boolean).length;
  if (present === 0) {
    return off(
      VAPID_DISABLED_REASONS.NOT_CONFIGURED,
      `没配 ${ENV_KEYS.join(' / ')}，推送整体关闭；聊天、SSE、附件一切照旧`,
      '要开推送：node scripts/generate-vapid-keys.mjs 生成三行填进 .env，重启即可',
    );
  }
  if (present < ENV_KEYS.length) {
    // 半开比全关更糟：订阅存下来了却永远推不出去，用户以为开着。所以缺一项就整体关闭。
    const missing = ENV_KEYS.filter((key) => !trimmed(env[key]));
    return off(
      VAPID_DISABLED_REASONS.PARTIAL_CONFIG,
      `VAPID 只配了一部分，缺 ${missing.join(' / ')}，推送整体关闭`,
      '三项必须一起配齐 —— 缺一项就没法签 JWT，宁可全关也不留半开状态',
    );
  }

  // 三项都在，逐项验。把毛病**一次全说完**：修一个重启一次才发现下一个，太折磨人。
  const problems = [];
  const keys = validateKeys(publicKey, privateKey);
  if (!keys.ok) problems.push(keys);
  const sub = validateSubject(subject);
  if (!sub.ok) problems.push(sub);

  if (problems.length > 0) {
    return off(
      problems[0].reason,
      problems.map((p) => p.detail).join('；'),
      problems.map((p) => p.hint).join('；'),
    );
  }

  return { enabled: true, publicKey, privateKey, subject };
}

/**
 * 进程级单例。业务代码（2A 的发送、2B 的 /api/push/config）用这个，别自己去读 env。
 *
 * 缓存的理由：`validateKeys` 每次要做一轮签名 + 验签。启动时做一次是自检，
 * 每条推送都做一次就是白烧 CPU；而且判定结果在进程生命周期内不会变。
 */
let cached = null;

export function vapidConfig() {
  if (!cached) cached = readVapidConfig();
  return cached;
}

/** 语法糖。`GET /api/push/config` 的 enabled 直接用它。 */
export const pushEnabled = () => vapidConfig().enabled;

/**
 * 启动自检：算一次，打**一行**日志，返回结果。
 *
 * 只在这里打，不在每次推送时打 —— 一条一行的话，一天几万行日志里全是同一句废话。
 * 事件名固定为 push.enabled / push.disabled，运维那条
 * `docker compose logs loop-im | grep push.disabled` 靠的就是它，别改。
 */
export function logVapidStatus() {
  const config = vapidConfig();
  if (config.enabled) {
    logEvent('push.enabled', {
      subject: config.subject,
      // 只记公钥的头几位：够用来核对「线上这套是不是我刚发的那套」，又不必把整串塞进日志。
      // 私钥一个字符都不记 —— log.js 的 redact 按字段名拦截，拦不住我们主动传进去的东西。
      publicKeyHead: `${config.publicKey.slice(0, 12)}…`,
    });
  } else {
    logWarn('push.disabled', { reason: config.reason, detail: config.detail, hint: config.hint });
  }
  return config;
}

/** 测试用：清掉单例缓存，让下一次 vapidConfig() 重新读 env。 */
export function __resetVapidConfigForTest() {
  cached = null;
}
