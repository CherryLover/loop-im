/**
 * 已登录接口的用量限流：按**用户**维度，统计「成功做成了几次」。
 *
 * ── 为什么不复用 rate-limit.js ──────────────────────────────────────────
 * rate-limit.js 是给登录写的，语义是「只数失败，成功清零」——正常用户登录成功
 * 之后计数归零，永远不会被自己的正常行为拖近上限。发消息恰好相反：每一次**成功**
 * 才是要计的那一笔，成功清零就等于永不限流。两套语义共用一份计数表，改任何一边
 * 都会顺手改坏另一边，所以分成两个模块，各自守各自的账；rate-limit.js 一个字不动。
 *
 * 另一处不同是分档：登录只有一档阈值，这里每类动作一档（发消息 / @AI / 上传 /
 * 群写操作），@AI 那档单独且更严——它每次都真实调用大模型，是这套系统里唯一
 * 直接烧钱的接口，和「多写了几行 SQLite」不是一个量级。
 *
 * 维度是 userId 而不是 IP：这些接口都在 authenticate 之后，身份是确定的。
 * 按 IP 会把同一个办公室出口的所有人算成一个人，那才是真的误伤。
 *
 * 存储沿用进程内滑动窗口。部署形态是单进程 + SQLite，进程内就是全局，
 * 够用且不值得为它引 redis；换成多进程时这里要整体换实现，不要打补丁。
 */
import { logWarn } from './log.js';

/** 环境变量取正数，非法或缺省时退回默认值。 */
const num = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * 各档默认值。定档原则只有一条：**限流误伤正常用户比不限流更糟**，
 * 所以每一档都按「正常人的峰值再乘几倍」来取，脚本刷会撞上，人不会。
 *
 * - message 60 条 / 分钟：人手打字最猛的时候（一串「好」「收到」「行」）大概
 *   15~20 条/分钟，这里给了三四倍余量；而循环脚本是每秒上千条，一秒内就撞上。
 * - ai 10 次 / 5 分钟：@AI 一轮是「问 → 等回复 → 读完 → 再问」，5 分钟问 10 次
 *   已经比人读得完的速度还快。Aria 退役后这一档暂时没有消费方，保留给接入中的
 *   hapi Agent（那边一次触发就是一次真实的 Agent 任务，还要排队）——见
 *   docs/hapi-Agent-接入方案.md。
 * - upload 20 次 / 分钟：附件一次最多选 9 个（前端 Composer 的 MAX_ATTACHMENTS，
 *   这一档就是照着这里的额度定的），连发两批 18 次仍在额度内；一分钟内传满 20 个
 *   已经不像人在操作。改这一档之前先看一眼那个上限，两边是配套的。
 * - write 30 次 / 分钟：建群、加成员、改群名这类操作正常一天也用不了几次。
 */
export const DEFAULT_LIMITS = {
  message: { windowMs: 60_000, max: 60, env: 'RATE_MESSAGE', hint: '消息发得太快了' },
  ai: { windowMs: 5 * 60_000, max: 10, env: 'RATE_AI', hint: '@AI 太频繁了' },
  upload: { windowMs: 60_000, max: 20, env: 'RATE_UPLOAD', hint: '上传太频繁了' },
  write: { windowMs: 60_000, max: 30, env: 'RATE_WRITE', hint: '操作太频繁了' },
};

/** 生效值 = 环境变量覆盖 > 上面的默认值。启动时读一次，之后不再看环境变量。 */
export const usageLimits = Object.fromEntries(
  Object.entries(DEFAULT_LIMITS).map(([action, d]) => [action, {
    windowMs: num(`${d.env}_WINDOW_MS`, d.windowMs),
    max: num(`${d.env}_MAX`, d.max),
    hint: d.hint,
  }]),
);

const buckets = new Map();                      // `${action}:${userId}` -> number[]（成功时间戳）

const bucketKey = (action, userId) => `${action}:${userId}`;

/**
 * AI 用户自己发的消息走服务端内部路径，压根不经过这些路由，正常情况下碰不到限流。
 * 这里再显式豁免一次，是为了万一将来有人给 AI 用户接上一条 HTTP 出口，也不会出现
 * 「用户把额度用完了，AI 就哑了」——AI 的回复是系统行为，不该算进任何人的额度。
 * 覆盖两代 AI 的 id 约定：退役的 Aria（'ai'）与 hapi Agent 用户（'ai-<agent>'）。
 */
export const isInternalSender = (userId) => userId === 'ai' || String(userId || '').startsWith('ai-');

/** 取出窗口内还有效的那些时间戳，顺手把过期的丢掉（窗口自然滑动，不会永久锁死）。 */
function hits(action, userId, now) {
  const key = bucketKey(action, userId);
  const conf = usageLimits[action];
  const list = (buckets.get(key) || []).filter((t) => t > now - conf.windowMs);
  if (list.length) buckets.set(key, list);
  else buckets.delete(key);
  return list;
}

/**
 * 现在还能不能做这个动作。只读，不计数——真正的一笔要等动作做成之后由
 * consumeQuota 记上，所以参数校验失败（空消息、非法引用）不会白白吃掉额度。
 *
 * retryAfterMs 是**相对**毫秒：窗口里最早那一笔滑出去还要多久。
 */
export function quotaState(action, userId, now = Date.now()) {
  const conf = usageLimits[action];
  if (!conf) throw new Error(`未知的限流档位：${action}`);
  if (isInternalSender(userId)) return { allowed: true, retryAfterMs: 0, used: 0, limit: conf.max };

  const list = hits(action, userId, now);
  if (list.length < conf.max) return { allowed: true, retryAfterMs: 0, used: list.length, limit: conf.max };
  return {
    allowed: false,
    retryAfterMs: Math.max(1, list[0] + conf.windowMs - now),
    used: list.length,
    limit: conf.max,
  };
}

/** 动作确实做成了，记上一笔。AI 的内部动作不计。 */
export function consumeQuota(action, userId, now = Date.now()) {
  if (!usageLimits[action]) throw new Error(`未知的限流档位：${action}`);
  if (isInternalSender(userId)) return;
  const list = hits(action, userId, now);
  list.push(now);
  buckets.set(bucketKey(action, userId), list);
}

const lastLogged = new Map();                   // `${action}:${userId}` -> 上次记日志的时刻

/** 同一个人同一档，一个窗口内只记一条限流日志。返回 true 表示这次该记。 */
function shouldLog(action, userId, now = Date.now()) {
  const key = bucketKey(action, userId);
  const previous = lastLogged.get(key);
  if (previous !== undefined && previous > now - usageLimits[action].windowMs) return false;
  lastLogged.set(key, now);
  return true;
}

/**
 * 触发限流时统一这么回。前端要能说出「几点几分可以再发」，所以给的是：
 *   - Retry-After 头（秒，给中间层和通用客户端看）
 *   - retryAfterMs：**相对**毫秒
 *   - serverNow：服务端此刻的时间戳
 *
 * 这里故意**不**下发一个「可以再发的绝对时间」让前端直接显示。客户端的钟可能
 * 偏几分钟甚至几小时，把服务端算好的绝对时刻搬到那台机器上显示出来，用户对着
 * 自己的表看就是错的。正确做法是前端用 `Date.now() + retryAfterMs` 在本地换算，
 * 这样显示出来的钟点和用户自己的表永远一致。serverNow 只用于排查时差，不要拿来显示。
 */
export function rejectOverQuota(res, action, state, meta = {}) {
  const conf = usageLimits[action];
  // 日志红线（见 log.js）：只记「谁、哪个接口、还要等多久」，正文一个字都不进来。
  //
  // 每个窗口只记一条：撞上限流的往往正是一个死循环脚本，每秒能撞上千次，
  // 一次一条日志等于把「有人在刷」这条信息淹在自己制造的噪音里，还顺带把磁盘写满。
  if (shouldLog(action, meta.userId)) {
    logWarn('rate-limited', {
      action,
      userId: meta.userId,
      route: meta.route,
      retryAfterMs: state.retryAfterMs,
      limit: conf.max,
      windowMs: conf.windowMs,
    });
  }
  res.set('Retry-After', String(Math.max(1, Math.ceil(state.retryAfterMs / 1000))));
  return res.status(429).json({
    error: `${conf.hint}，请稍后再试`,
    scope: action,
    retryAfterMs: state.retryAfterMs,
    serverNow: Date.now(),
    limit: conf.max,
    windowMs: conf.windowMs,
  });
}

/**
 * 「检查 + 立刻计数」的中间件，给上传和群写操作用。
 *
 * 这两类和发消息不同，故意数的是**尝试**而不是成功：上传的代价在于把最多 100MB
 * 字节收下来（现在是写进中转文件，不再是收进内存，但带宽和磁盘照样要付），
 * 无论后面 inspectUpload 判没判过都已经付出了；所以中间件要挂在 multer 前面，
 * 超额时连收都不收。视频那一档把这个代价抬高了一个量级，这条更要紧了。
 */
export const limitUsage = (action) => (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) return next();                   // 未登录的请求由 authenticate 去挡
  const state = quotaState(action, userId);
  if (!state.allowed) return rejectOverQuota(res, action, state, { userId, route: req.originalUrl });
  consumeQuota(action, userId);
  return next();
};

/** 测试用：清空所有档位的计数，免得用例之间互相影响。 */
export const resetUsageLimits = () => {
  buckets.clear();
  lastLogged.clear();
};

/**
 * 测试用：临时改某一档的阈值。返回一个还原函数——用例跑完务必调用，
 * 否则会把后面的用例一起改掉。
 */
export function configureUsageLimit(action, patch) {
  const conf = usageLimits[action];
  const before = { windowMs: conf.windowMs, max: conf.max };
  // 只认这两项：直接摊 patch 会把 DEFAULT_LIMITS 里的 env/hint 也带进生效表。
  if (patch.windowMs !== undefined) conf.windowMs = patch.windowMs;
  if (patch.max !== undefined) conf.max = patch.max;
  return () => Object.assign(conf, before);
}
