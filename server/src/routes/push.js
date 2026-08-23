// Web Push 的订阅接口。三条，全部要登录（router.use(authenticate)）：
//
//   GET    /api/push/config      服务端有没有开推送、公钥是什么
//   POST   /api/push/subscribe   上报（或更新）本设备的订阅
//   DELETE /api/push/subscribe   退订本设备
//
// 「合法的订阅长什么样」「同一个 endpoint 再报一次怎么办」都在 push-store.js，
// 这里只负责鉴权、HTTP 状态码，以及**不把别人的信息泄露出去**。
import { Router } from 'express';
import { authenticate } from '../auth.js';
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
