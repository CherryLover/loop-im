// Loop IM 的 Service Worker。
//
// 职责清单就四条，多一件都要先讨论（见方案 §D.3）：
//   install            → skipWaiting()
//   activate           → clients.claim()
//   push               → 解析 → showNotification()（**唯一出口**，含兜底）
//   notificationclick  → matchAll + focus + postMessage，兜底 openWindow
//
// 明确不做的：fetch、sync、periodicsync、缓存 API、pushsubscriptionchange
//（最后一个 iOS 不支持，靠前端每次启动重新 subscribe 兜住，见 lib/push.ts）。
//
// ── 红线：这个文件里永远不许出现 fetch 事件监听 ──────────────────────
// 我们要 Service Worker，只是为了 Web Push —— iOS 上不注册 SW，连 subscribe() 都发起
// 不了，因为 PushManager 挂在 ServiceWorkerRegistration 上。仅此而已。
//
// 一旦加了 fetch handler，页面资源就会走 SW 的网络路径和缓存策略，而这个项目刚吃过
// 「静默缓存导致用户看到旧界面、没有任何报错」的亏（见 src/styles-integrity.test.js
// 顶部那段事故说明，同一类问题：不报错，但行为不对）。
// 没有 fetch handler = 所有请求原样走网络 = 缓存行为和没有 SW 时逐字节相同，风险为零。
// 这不是「靠人自觉不写缓存代码」，而是**结构上不可能**：浏览器压根不会把请求交给我们。
//
// 代价说清楚：没有 fetch handler 就没有离线能力。对一个 IM 来说这个代价是零 ——
// 离线打开一个连消息都拉不到的空壳，没有任何意义。离线可用不在本项目的目标里。
//
// src/sw-source.test.js 会读这个文件的源码，断言里面没有任何 'fetch' 监听。
// 想加缓存请先删掉那条闸门并说明理由 —— 那时你就得对着这段注释想清楚。
// ───────────────────────────────────────────────────────────────────

// 装上就立刻接管，不等所有旧页面关掉。
// 我们不缓存任何东西，所以「新旧 SW 并存」没有半点好处，只会让排查变复杂：
// 真机上看到的到底是哪一版 SW 在跑，是个纯粹多余的问题。
self.addEventListener('install', () => self.skipWaiting());

// 同理，激活后立刻接管已经打开的页面，不必等用户手动刷新。
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// ── 第二条红线：push handler 收到推送就**必须**弹一条通知，一次都不能省 ──────
//
// WebKit 的原话：「Violations of the userVisibleOnly promise will result in a push
// subscription being revoked.」
//
// 这句话的分量要说透：在 push handler 里 return 一次（哪怕理由再充分，比如「这条不该
// 弹」「这个会话被静音了」），代价**不是「这次不弹」，是这台设备的订阅被永久吊销** ——
// 用户毫不知情，我们也收不到任何错误，只会表现为「从某天起这台设备再也收不到推送了」。
// 和上面那条缓存红线是同一类事故：不报错，但行为不对，而且要好几天才有人报上来。
//
// 所以：「该不该弹」这个判断**整个搬到了服务端**（server/src/push-decide.js，那五条
// 规则和 lib/notify.ts 的 shouldNotifyMessage 逐条对齐）。到了这里就只剩一件事 ——
// 弹。连 JSON 解析失败都要弹一条兜底的，绝不静默返回。
//
// 下面这个函数因此没有任何 early return：所有分支都汇到同一句 showNotification。
// ───────────────────────────────────────────────────────────────────

/** payload 里拿不到东西时用的兜底文案。宁可弹一条含糊的，也不能不弹。 */
const FALLBACK_TITLE = 'Loop IM';
const FALLBACK_BODY = '你有一条新消息';

/** 只接受非空字符串。payload 是服务端给的，但坏掉的字段不该把兜底逻辑带偏。 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * 把一条推送变成一条通知。**没有不弹的出口。**
 *
 * @param {PushEvent} event
 */
async function showIncoming(event) {
  let data = null;
  try {
    // event.data 可能是 null（服务端推了一条空的），json() 可能抛（正文不是 JSON、
    // 或者解密后是别的格式）。两种都不是「不弹」的理由，落到兜底文案继续走。
    data = event.data ? event.data.json() : null;
  } catch {
    /* 故意吞掉：兜底文案已经准备好了 */
  }
  // data 也可能是数字、字符串、null —— 在这些值上取属性都是 undefined，不会抛。
  const d = data && typeof data === 'object' ? data : {};

  const conversationId = text(d.conversationId);
  await self.registration.showNotification(text(d.title) || FALLBACK_TITLE, {
    body: text(d.body) || FALLBACK_BODY,
    // tag 必须和前台 notifyMessage 用的 `loop-im:${conversationId}` 一致：
    // 同一个会话连来十条，本地通知和推送通知互相覆盖，而不是堆成二十条。
    tag: text(d.tag) || (conversationId ? `loop-im:${conversationId}` : 'loop-im:fallback'),
    // notificationclick 靠它知道该跳哪个会话。iOS 上自定义 actions 不显示
    // （只有系统的「查看」），所以这里**不要**加 actions。
    data: { conversationId },
  });

  // 角标严格排在 showNotification **之后**，这个顺序是安全属性不是风格：
  // Badging API 在这个环境里不一定存在，放前面的话它一抛，通知就没了 —— 那正是
  // 上面那段红线说的「订阅被吊销」。放后面，最坏也只是角标不准。
  try {
    if (typeof d.badge === 'number' && Number.isFinite(d.badge) && self.navigator) {
      if (d.badge > 0 && typeof self.navigator.setAppBadge === 'function') {
        await self.navigator.setAppBadge(d.badge);
      } else if (d.badge === 0 && typeof self.navigator.clearAppBadge === 'function') {
        await self.navigator.clearAppBadge();
      }
    }
  } catch {
    /* 角标不是关键路径，失败就算了 */
  }
}

self.addEventListener('push', (event) => event.waitUntil(showIncoming(event)));

/**
 * 点通知回到那个会话。**降级链**，从最可靠到最不可靠：
 *
 *   1. matchAll 找到已经开着的窗口 → focus() → postMessage 让页面自己跳会话；
 *   2. focus() 被拒（浏览器不一定给）也照样 postMessage —— 窗口确实存在，
 *      页面能收到消息就能跳，最坏是用户得自己切回来；
 *   3. 一个窗口都没有，才用 clients.openWindow()。
 *
 * 为什么把 openWindow 压到最后：Safari / iOS 上它有多份「不报错也不做事」的报告
 * （developer.apple.com/forums/thread/733538）。能不用就不用。
 *
 * 这一整块都要能优雅降级：点不动，最多是回不到那个会话；
 * 绝不能让它反过来影响通知本身（通知在 push handler 里早就弹出去了）。
 */
async function openConversation(event) {
  const conversationId = event.notification.data ? event.notification.data.conversationId : null;
  let windows = [];
  try {
    windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch {
    /* 拿不到窗口列表就当一个都没有，落到 openWindow */
  }

  const target = windows[0];
  if (target) {
    try {
      await target.focus();
    } catch {
      /* 聚焦被拒不影响下面的跳转：窗口还在，页面照样收得到消息 */
    }
    try {
      target.postMessage({ type: 'open-conversation', conversationId });
    } catch {
      /* 页面已经在卸载之类，忽略 */
    }
    return;
  }

  try {
    if (typeof self.clients.openWindow === 'function') {
      // 带上会话 id，AppShell 启动时会认这个查询参数。
      await self.clients.openWindow(conversationId ? `/?c=${encodeURIComponent(conversationId)}` : '/');
    }
  } catch {
    /* 见上：openWindow 在 iOS 上本来就不保证有用 */
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openConversation(event));
});
