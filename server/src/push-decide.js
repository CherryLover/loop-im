/**
 * 「这条消息该不该推、推到哪几台设备上去」——判定与扇出。
 *
 * 这个模块只做两件事，其余一概不碰：
 *   1. `targetsFor()`：纯函数，输入全部由调用方查好传进来，不碰数据库、不碰网络。
 *      每一条规则都能被单独锁住，这是它写成纯函数的全部理由。
 *   2. `queuePush()`：把判定结果扇出成一批 HTTPS 请求，**永远 resolve、永远不抛**。
 *
 * ── 判定规则（服务端唯一口径，与前端 `web/src/lib/notify.ts` 的
 *    `shouldNotifyMessage` 并排列出来，将来改任何一边都要想到另一边）─────────
 *
 * | # | 服务端（这里）                    | 前端 shouldNotifyMessage        |
 * | 1 | 收件人有订阅（`subscriptions` 里有他）| `enabled`（用户拨了开关）        |
 * | 2 | `senderId !== 收件人`             | 同                              |
 * | 3 | `kind !== 'system'`               | 同                              |
 * | 4 | 收件人没把这个会话设成免打扰        | `!conversation.muted`           |
 * | 5 | **那台设备**此刻没连着 SSE          | `!visible`（人正看着就不弹）      |
 *
 * 第 5 条是两边唯一形态不同的：前端能直接看到「这条消息此刻在不在屏幕上」，
 * 服务端看不到，改用「这台设备的 SSE 活着吗」来代替——SSE 活着说明这台设备上的网页
 * 正在跑，它自己会用本地通知处理；SSE 断了说明只有推送能触达它。见 §C.3。
 *
 * ── 两条被明确否决的「优化」，谁都别再捡回来 ─────────────────────────────
 *
 * ⚠️ **免打扰一票否决，@我 也不推。** 用户原话：「跟谁 @ 谁没关系，只要设置了免打扰
 *    就不推送」。很多 IM 让 @ 穿透免打扰，方案文档 §E.1 Q1 也讨论过，**已被否决**。
 *    这条和 `conversations.js` 顶部钉死的 muted 语义（「不打扰，不是不计数」）以及
 *    前端 `shouldNotifyMessage` 完全一致：服务端前端一套规则、没有例外。
 *    `push-decide.test.js` 里有一条专门的用例锁住「@我 且 muted → 不推」。
 *
 * ⚠️ **Aria（AI）的回复不做任何特例**，按同一套规则推给所有没设免打扰的成员。
 *    方案文档 §E.1 Q3 倾向「只推给触发她的那个人」，**已被否决**——用户要的是规则统一。
 *    所以这个文件里一个 AI_ID 都不该出现；出现了就是有人在加特例。
 */
import { onlineDeviceIds } from './events.js';
import { logError, logEvent } from './log.js';

/** 应用名。推送标题的第一段，见 pushTitle。 */
export const APP_NAME = 'Loop IM';

/**
 * 同时在飞的出站推送请求上限。
 *
 * 一个 50 人的群、每人两台设备就是 100 个出站 HTTPS 请求。一次全放出去有两个害处：
 * 瞬间打满 socket 池（这个进程还要伺候正常的 HTTP 请求），以及被推送服务判成滥用。
 * 6 是个保守值：串行太慢（每个请求几百毫秒，100 个就是半分钟），
 * 再高的并发换不来多少总时长，因为瓶颈在对端而不在本地。
 */
export const PUSH_FANOUT_CONCURRENCY = 6;

const toSet = (value) => (value instanceof Set ? value : new Set(value || []));

/** onlineDevices 允许传 Map，也允许传普通对象（测试里写起来省事）。 */
function toDeviceMap(value) {
  if (value instanceof Map) return value;
  const out = new Map();
  for (const [userId, devices] of Object.entries(value || {})) out.set(userId, toSet(devices));
  return out;
}

/**
 * 这条消息要推给哪些订阅。
 *
 * 全部输入都由调用方查好传进来 —— 这个函数不碰数据库，才能把每条规则单独锁住。
 *
 * @param message       `{ id, conversationId, senderId, kind }`
 * @param memberIds     会话成员。**不在名单里的订阅一律丢掉**：调用方本来就只会查成员的
 *                      订阅，这一道是纯粹的兜底——推送带着消息摘要，宁可失败也不能发错人。
 * @param mutedBy       Set<userId>：把这个会话设成免打扰的人
 * @param subscriptions 这批人的全部订阅，`{ id, userId, deviceId, endpoint, p256dh, auth }`
 * @param onlineDevices Map<userId, Set<deviceId>>：此刻连着 SSE 的设备
 * @returns Array<Subscription>
 */
export function targetsFor({
  message,
  memberIds = [],
  mutedBy,
  subscriptions = [],
  onlineDevices,
} = {}) {
  // 规则 3：系统消息（入群 / 改群名之类）一个都不推。放在最前面是因为它一票否决整条消息，
  // 后面那些 per-user 的判断连跑都不用跑。
  if (!message || message.kind === 'system') return [];

  const members = toSet(memberIds);
  const muted = toSet(mutedBy);
  const online = toDeviceMap(onlineDevices);

  return subscriptions.filter((sub) => {
    // 规则 1 的另一半：一条没有 endpoint 的订阅推不出去，早点丢掉省一次注定失败的请求。
    if (!sub?.userId || !sub?.endpoint) return false;
    if (!members.has(sub.userId)) return false;
    if (sub.userId === message.senderId) return false;      // 规则 2：自己发的
    if (muted.has(sub.userId)) return false;                // 规则 4：免打扰，@我 也不例外
    // 规则 5：这台设备的网页正开着（SSE 活着）→ 本地通知负责，这一台不推。
    // 没有 deviceId 的订阅判不了在不在线，按「宁可多推一条，不可漏推」照推（§C.4）。
    if (sub.deviceId && online.get(sub.userId)?.has(sub.deviceId)) return false;
    return true;
  });
}

/**
 * 推送标题：**应用名 + 发送者**，群聊再带上群名。
 *
 *   单聊 / AI：`Loop IM · 张三`
 *   群聊：     `Loop IM · 张三 · 项目组`
 *
 * 三段的理由，从后往前说：
 * - **群名必须在**。这是前端 `notifyTitle()` 早就定下的口径，理由一样成立：
 *   只看到一个人名，不知道这条消息是从哪个群冒出来的，而人往往同时在十几个群里。
 * - **发送者必须在**，锁屏上一眼看清是谁找我，这是通知的主要信息。
 * - **应用名是用户点名要的**。分隔符统一用 `·`，和前端保持同一个形状，
 *   两边同一条消息长得一样（§C.5 要求）。
 *
 * ⚠️ 真机上要确认一件事：**iOS 主屏 Web App 的通知头部可能已经自带应用名**，
 *    那样标题里再拼一遍就成了「Loop IM Loop IM · 张三」。用户明确要求带上，这里照做，
 *    但这一条要进真机验收清单实测（安卓与桌面上不存在这个问题）。
 *
 * 另一个已知取舍：通知标题在各家系统上都是**从尾部截断**的，三段拼下来窄屏上最先被切掉的
 * 是群名。把应用名放最后能保住群名，但那不符合「应用名 + 发送者」这个要求，也不符合
 * 通知标题的通行写法（应用名在前）。先按用户定的来，真机上看着不行再调。
 */
export function pushTitle(message, conversation) {
  const sender = message?.senderName || '新消息';
  return conversation?.type === 'group' && conversation.title
    ? `${APP_NAME} · ${sender} · ${conversation.title}`
    : `${APP_NAME} · ${sender}`;
}

/**
 * 推给 SW 的 payload。字段与 `web/public/sw.js` 的 push handler 一一对应。
 *
 * `tag` 用的是和前端桌面通知完全相同的 `loop-im:<会话 id>`：同一个会话连着来十条消息
 * 只留最新一条，而且桌面通知和推送通知会互相覆盖而不是各堆一摞。
 *
 * @param body 已经摘要好的正文。摘要逻辑在 `routes/conversations.js` 的 `previewOf`，
 *             和会话列表最后一条消息是**同一个函数**（不是同一份逻辑抄两遍）。
 */
export function pushPayloadFor({ message, conversation, body }) {
  return {
    title: pushTitle(message, conversation),
    body: body || '',
    tag: `loop-im:${message?.conversationId ?? ''}`,
    conversationId: message?.conversationId ?? null,
  };
}

/**
 * 响应已经发出去之后才失败的那一步，只能记在服务端日志里——没别的地方可说。
 * 和 `runAiTurn` 的 `reportAiTurnFailure` 是同一个道理、同一个形状。
 */
export function reportPushFailure(err) {
  logError('push.failed', err);
}

/**
 * 2A（`web-push.js`）和 2B（`push-store.js`）是并行开发的另外两个任务包，
 * 在本包的分支上这两个文件还不存在。
 *
 * 所以用动态 `import()` 而不是顶部的静态 import：静态 import 在**模块加载期**就会因为
 * 文件缺失而整个崩掉，那会把 `routes/conversations.js` 一起带下水——发消息这条主链路
 * 就没了。推送是附加能力，缺了它消息也必须照发照存。三个包合到一起之后这段自然命中，
 * 一行都不用改。
 *
 * 结果（包括「加载不到」这个结果）缓存一次：不然每条消息都要重试一遍失败的 import，
 * 日志会被刷爆。
 */
let bridgePromise = null;
function pushBridge() {
  bridgePromise ??= (async () => {
    try {
      const [webPush, store] = await Promise.all([
        import('./web-push.js'),
        import('./push-store.js'),
      ]);
      return {
        sendPush: webPush.sendPush,
        subscriptionsFor: store.subscriptionsFor,
        deleteSubscription: store.deleteSubscription,
        markPushResult: store.markPushResult,
      };
    } catch (err) {
      // 只记一次：这不是故障，是「推送这块还没接上」。
      logEvent('push.unavailable', { reason: err?.code || 'import_failed' });
      return null;
    }
  })();
  return bridgePromise;
}

/**
 * 只为测试留的缝，性质同 `app.js` 的 `clientDist`：把上面那座桥换成假的，
 * 好在**真的 HTTP 请求**上验「发消息 → 真的发出去一条推送」这条线接没接上。
 *
 * 为什么非要有这条缝：`queuePush` 的 deps 只能覆盖直接调用它的那个调用方，
 * 而路由处理函数是从 `router.post(...)` 里调的，测试插不进去手。没有它，
 * 「POST /messages 之后到底有没有触发推送」这一整段接线就一条用例都盖不住——
 * 而这正是本任务包最容易在合并时被改掉又没人发现的地方。
 *
 * 生产上没有任何调用点。传 `undefined` 复位成「按真模块加载」。
 */
export function setPushBridgeForTests(fake) {
  bridgePromise = fake === undefined ? null : Promise.resolve(fake);
}

/** 只把 host 记进日志。endpoint 全文带着一串能推送到用户设备的凭据，不该进日志。 */
function endpointHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid';
  }
}

/**
 * 有并发上限的扇出。worker 自己保证不抛（下面 sendOne 里已经兜住），
 * 所以这里不需要 allSettled——真有漏网的也会被 queuePush 顶层的 try 接住。
 */
async function forEachLimited(items, limit, worker) {
  const queue = [...items];
  const lanes = Math.max(1, Math.min(limit, queue.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  }));
}

/**
 * 发一条消息的推送。**发射后不管**：调用方拿到的 Promise 永远 resolve。
 *
 * 为什么必须这样（这是 issue #19 那个坑，不是洁癖）：调用点在 `res.json()` **之后**。
 * 发消息的 handler 之后再冒出来的 rejection 会被 Express 5 转给 `app.js` 末尾的错误
 * 中间件，那时 `res.headersSent` 已经是 true，中间件再 `res.status().json()` 就撞上
 * `ERR_HTTP_HEADERS_SENT`，在日志里留下一串跟真实故障毫无关系的堆栈，把排查带偏。
 * 所以：每一步各自兜住自己的错误，函数本身永远 resolve；
 * 苹果的推送服务器抽风绝不能让「发消息」这个请求失败。
 *
 * 日志口径（§C.5）：只记 `{ userId, deviceId, conversationId, endpointHost, status }`，
 * **不记 title、不记 body**。`log.js` 的 `redact()` 会拦 body/preview 这些键名，
 * 但它是兜底不是许可，调用方自己要想清楚传了什么。
 *
 * 依赖都可以从 deps 覆盖，方便测试注入失败——和 `runAiTurn` 同一个做法。
 */
export async function queuePush(ctx, deps = {}) {
  const { message, conversation, body, memberIds = [], mutedBy = new Set() } = ctx || {};
  const {
    // 默认就是真的 SSE 在线表。**不要**把它的缺省值改成 null 之类的「空实现」：
    // 那样任何一个忘了传的调用点都会静默地把推送发给正开着网页的设备。
    onlineDevices: lookupOnline = onlineDeviceIds,
    subscriptionsFor = null,
    send = null,
    forget = null,
    mark = null,
    onError = reportPushFailure,
    concurrency = PUSH_FANOUT_CONCURRENCY,
  } = deps;

  try {
    // 系统消息在 targetsFor 里也会被挡掉，这里提前返回只是为了省掉后面那些查询。
    if (!message || message.kind === 'system') return;

    const bridge = (subscriptionsFor && send) ? null : await pushBridge();
    const list = subscriptionsFor || bridge?.subscriptionsFor;
    const sendOne = send || bridge?.sendPush;
    if (!list || !sendOne) return;                 // 推送还没接上（或没配 VAPID），静默跳过

    // 只查真有可能收到的人：发送者自己和免打扰的人连查都不用查。
    const audience = [...new Set(memberIds)]
      .filter((id) => id !== message.senderId && !toSet(mutedBy).has(id));
    if (!audience.length) return;

    const subscriptions = (await list(audience)) || [];
    if (!subscriptions.length) return;

    const online = new Map();
    if (lookupOnline) for (const id of audience) online.set(id, toSet(lookupOnline(id)));

    const targets = targetsFor({ message, memberIds, mutedBy, subscriptions, onlineDevices: online });
    if (!targets.length) return;

    const payload = JSON.stringify(pushPayloadFor({ message, conversation, body }));
    const drop = forget || bridge?.deleteSubscription;
    const record = mark || bridge?.markPushResult;

    logEvent('push.fanout', {
      conversationId: message.conversationId,
      messageId: message.id,
      targets: targets.length,
    });

    await forEachLimited(targets, concurrency, async (sub) => {
      try {
        const result = await sendOne({ subscription: sub, payload });
        logEvent('push.sent', {
          userId: sub.userId,
          deviceId: sub.deviceId,
          conversationId: message.conversationId,
          endpointHost: endpointHost(sub.endpoint),
          status: result?.status ?? 0,
        });
        // 404 / 410 = endpoint 被回收了，这条订阅再也推不出去，立刻删掉；
        // 留着它只会让之后每一次群发都多一个注定失败的请求（§C.4）。
        if (result?.gone) await drop?.(sub.endpoint);
        else await record?.(sub.endpoint, !!result?.ok);
      } catch (err) {
        // 单台设备推失败不影响别的设备，更不影响这次发消息。
        onError(err);
      }
    });
  } catch (err) {
    onError(err);   // 兜底：任何没预料到的错误也不许逃出这个函数
  }
}
