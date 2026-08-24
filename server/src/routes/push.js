// Web Push 的订阅接口。四条，全部要登录（router.use(authenticate)）：
//
//   GET    /api/push/config      服务端有没有开推送、公钥是什么
//   POST   /api/push/subscribe   上报（或更新）本设备的订阅
//   DELETE /api/push/subscribe   退订本设备
//   POST   /api/push/visibility  上报本页面此刻在不在前台（决定这台设备该不该收推送）
//
// 「合法的订阅长什么样」「同一个 endpoint 再报一次怎么办」都在 push-store.js，
// 这里只负责鉴权、HTTP 状态码，以及**不把别人的信息泄露出去**。
import { Router } from 'express';
import { authenticate } from '../auth.js';
import { clearDeviceVisibility, setDeviceVisibility } from '../events.js';
import {
  deleteSubscriptionForUser, normalizeUa, upsertSubscription, validateSubscriptionInput,
} from '../push-store.js';

export const router = Router();
router.use(authenticate);

/**
 * VAPID 状态的来源。
 *
 * 真正的自检在 2E 的 `vapid-config.js`（它认三个环境变量、验密钥格式和 subject 可路由性），
 * 那个文件不归这个任务包管，而且落地之前这里也不能凭空猜它的导出名。所以留一个 setter：
 * 2E 在 `index.js` 里调一次 `setPushConfigProvider(...)` 就接上了，不用改这个文件。
 *
 * **默认值是「没启用」而不是「假装启用」**：没接上时前端看到 `enabled: false`，
 * 会把开关显示成「服务端未启用推送」；反过来默认成 true 的话，用户点了开关、
 * 浏览器要一个公钥，拿到 null 之后 `subscribe()` 直接抛错，界面只剩一个转不动的开关。
 */
const PUSH_DISABLED = { enabled: false, publicKey: null };
let readPushConfig = () => PUSH_DISABLED;

/** 2E 用它把真正的 VAPID 自检结果接进来。传 null 恢复成「未启用」（用例会用到）。 */
export function setPushConfigProvider(provider) {
  readPushConfig = typeof provider === 'function' ? provider : () => PUSH_DISABLED;
}

/**
 * 前端在打开通知开关之前先问这里。
 * 公钥本来就要发给浏览器（`subscribe()` 的入参），不是秘密；私钥永远不出服务端。
 */
router.get('/config', (_req, res) => {
  const config = readPushConfig() || PUSH_DISABLED;
  res.json({ enabled: !!config.enabled, publicKey: config.enabled ? (config.publicKey || null) : null });
});

/**
 * 上报订阅。**这是 upsert，不是 create**：iOS 不支持 `pushsubscriptionchange`
 * （见 docs/PWA-与推送改造方案.md A.2 ⑪），前端只能每次启动无条件重新 subscribe 再报一次，
 * 所以「已经有了」是常态而不是错误。重复上报返回 201，和第一次一模一样 ——
 * 让调用方能无脑重试，不用先查再决定用 POST 还是 PUT。
 *
 * 归属一律取自 `req.user.id`，**不看请求体里的任何 userId**：
 * 让调用方指定订阅记在谁名下，等于让任何登录用户往别人头上挂一条订阅。
 */
router.post('/subscribe', (req, res) => {
  const check = validateSubscriptionInput(req.body);
  // 校验不过就是 400 且不入库：一条格式错的订阅不会在这里出问题，
  // 它会在几天后的每一次群发里各失败一次，那时候已经查不到是谁报的了。
  if (!check.ok) return res.status(400).json({ error: check.error });

  upsertSubscription({
    userId: req.user.id,
    ...check.value,
    ua: normalizeUa(req.headers['user-agent']),
  });
  res.status(201).json({ ok: true });
});

/**
 * 退订本设备。只删**自己名下**那一条（`WHERE endpoint = ? AND user_id = ?`）——
 * 少了后半句，任何登录用户拿着别人的 endpoint 就能把别人的推送关掉。
 *
 * 「这条订阅不存在」和「它不是你的」返回**同一个 204**，理由和引用回复那里一样
 * （routes/conversations.js 的 replyTo 校验）：分开说等于把这个接口变成
 * 「某个 endpoint 在不在库里」的探针。
 *
 * 顺带这也让退订天然幂等：前端重复调、或者在服务端早已清掉之后再调，都是 204，
 * 不需要为「本来就没有」写一条特殊分支。
 */
router.delete('/subscribe', (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
  if (!endpoint) return res.status(400).json({ error: '缺少 endpoint' });
  deleteSubscriptionForUser(endpoint, req.user.id);
  res.status(204).end();
});

// ── 页面可见性上报 ─────────────────────────────────────────────────────────
//
// 这一条接口的存在理由，是一个真机 bug：iPhone 上 PWA 还在前台 → 立即切后台 →
// 马上让别人发消息 → 一条推送都收不到。根因是服务端拿「SSE 连接还在不在」去**推断**
// 页面状态，而 iOS 冻结 PWA 时 TCP 不会立刻断（完整病历在 events.js 的
// foregroundDeviceIds 上面）。所以改成页面**主动上报**，服务端不再猜。
//
// 挂在 /api/push 下而不是另起一个路由文件：这条上报唯一的用途就是决定「这台设备该不该
// 收推送」，和订阅上报是同一件事的两半，共用同一个 `router.use(authenticate)`。

/** 上报里的两个 id 都只是字典 key，长度按 UUID 留足，口径同 push-store 的 deviceId。 */
const MAX_ID_LENGTH = 128;

/** 非空、不超长、不含控制字符（它会被原样塞进日志和内存表的 key）。 */
function normalizeId(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_ID_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

/**
 * 每台设备的上报限流。
 *
 * 为什么要限：`visibilitychange` 在某些浏览器上切一次窗口会连发好几次（切走、失焦、
 * 再切回来各一发），而且这个接口是登录用户就能打的，不能让它变成一个免费的写循环。
 * 前端那边已经做了去重（状态没变就不发，见 web/src/lib/visibility.ts），
 * 这里是**兜底**，不是第一道防线。
 *
 * 窗口给得比任何正常操作都宽：正常用户切一次窗口最多带出两三发，20 次 / 10 秒够用了。
 */
const VISIBILITY_WINDOW_MS = 10_000;
const VISIBILITY_MAX_REPORTS = 20;
const visibilityHits = new Map();   // `${userId}|${deviceId}` -> number[]（上报时刻）

/** 测试用：把窗口清空，免得用例之间互相影响。口径同 rate-limit.js 的 resetRateLimit。 */
export const resetVisibilityLimit = () => visibilityHits.clear();

/**
 * 记一次上报，返回「这次是不是超限了」。
 *
 * ⚠️ 超限之后**不能只是把这次上报丢掉**。丢掉的如果正好是那一条「我切后台了」，
 * 服务端就永远停在「前台」上，这台设备从此再也收不到推送——那正是这次要修的 bug。
 * 所以超限的处理是「把这台设备一把踩成后台」（在下面的 handler 里做），
 * 失败方向永远偏向多推。
 */
function overVisibilityLimit(key, now = Date.now()) {
  const list = (visibilityHits.get(key) || []).filter((t) => t > now - VISIBILITY_WINDOW_MS);
  list.push(now);
  visibilityHits.set(key, list);
  return list.length > VISIBILITY_MAX_REPORTS;
}

/**
 * 上报「本页面此刻在不在前台」。
 *
 * 请求体 `{ deviceId, streamId, visible }`：
 * - `deviceId`  这台设备（同 SSE 的 `?device=`、同推送订阅的 device_id）；
 * - `streamId`  这台设备上的**哪一个页面**（同 SSE 的 `?stream=`）。桌面开两个标签页时
 *               两条连接共用一个 deviceId，只能靠它区分是谁切走了；
 * - `visible`   `document.visibilityState === 'visible'`，布尔。
 *
 * 归属一律取自 `req.user.id`，**不看请求体里的任何 userId**：这个接口只能改自己名下的
 * 连接。setDeviceVisibility 是按 `(userId, deviceId, streamId)` 三元组精确命中的，
 * 拿到别人的 deviceId 也改不动别人——那个 userId 根本对不上。
 *
 * 命中不了任何连接（页面还没建 SSE、连接刚断、streamId 对不上）不是错误：返回 200 和
 * `connections: 0`。这个方向天然安全——没有连接报告前台 = 这台设备算后台 = 照推。
 */
router.post('/visibility', (req, res) => {
  const deviceId = normalizeId(req.body?.deviceId);
  const streamId = normalizeId(req.body?.streamId);
  if (!deviceId || !streamId) return res.status(400).json({ error: 'deviceId / streamId 不合法' });
  if (typeof req.body?.visible !== 'boolean') return res.status(400).json({ error: 'visible 必须是布尔值' });

  if (overVisibilityLimit(`${req.user.id}|${deviceId}`)) {
    // 见 overVisibilityLimit 的 ⚠️：被限流的设备一律当作「状态不明」，而状态不明就推。
    clearDeviceVisibility(req.user.id, deviceId);
    return res.status(429).json({ error: '上报过于频繁' });
  }

  const connections = setDeviceVisibility(req.user.id, { deviceId, streamId, visible: req.body.visible });
  res.json({ ok: true, connections });
});
