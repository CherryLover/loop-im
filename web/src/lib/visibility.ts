/**
 * 「这个页面此刻在不在前台」——主动上报给服务端。
 *
 * ── 为什么需要这么一条上报（真机 bug，不是设想）─────────────────────────────
 *
 * iPhone 上 PWA 还在前台 → 立即切后台 → 马上让别人发消息 → **没有推送**；等久一点
 * 再发就有。根因在服务端：它拿「这台设备的 SSE 连接还在不在」去推断页面状态，而
 * **iOS 冻结 PWA 时 TCP 通常不会立刻断**，服务端好几分钟都以为那台还在前台，
 * 于是一个字节都没发给苹果。完整病历在 server/src/events.js 的 foregroundDeviceIds。
 *
 * 所以不再让服务端猜，改成页面自己说。这条路走得通的关键：
 * **iOS 在冻结页面之前一定会先触发 `visibilitychange`**，那一刻我们还有机会发请求。
 *
 * ── 两个必须这么写的技术细节 ──────────────────────────────────────────────
 *
 * 1. **`fetch(..., { keepalive: true })`，不是 `navigator.sendBeacon`。**
 *    `keepalive` 正是为「页面正在离开 / 即将被冻结」设计的：请求交给浏览器的网络栈，
 *    页面冻住或关掉它照样发完。sendBeacon 也能做到这一点，但它**带不了自定义请求头**，
 *    而我们这个接口要 `Authorization: Bearer`，用它等于每次都是一个 401。
 *
 * 2. **streamId：这台设备上的哪一个页面。** 桌面上同一台机器可以开两个标签页，
 *    它们共用同一个 deviceId（localStorage 是按源存的），也共用同一个推送订阅。
 *    只报 deviceId 的话，乙标签页切走时那句「我在后台」会把甲标签页的「我在前台」
 *    盖掉——于是用户明明正盯着甲看，手机（这台机器）还在冒推送。
 *    每个页面自己生成一个 streamId，同时带在 SSE 的 `?stream=` 和这条上报里，
 *    服务端就能各记各的：**只要有一个页面在前台，这台设备就算前台**。
 */

import { api } from './api';
import { deviceId } from './push';

/**
 * 这一次页面加载的标识。**不进 localStorage**：它代表「这个页面」，不是「这台设备」，
 * 刷新一次就该换一个新的（刷新会重建 SSE 连接，服务端那边旧连接连同它的可见性状态
 * 一起消失，正好对上）。
 */
let currentStreamId: string | null = null;

/** `crypto.randomUUID` 在非安全上下文和老浏览器里可能没有，退回 Math.random。口径同 push.ts。 */
function randomId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* 落到下面 */
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 本页面的 streamId，第一次问的时候生成，此后不变。 */
export function pageStreamId(): string {
  currentStreamId ??= randomId();
  return currentStreamId;
}

/**
 * 上一次**成功**报上去的状态。用来去重：`visibilitychange` 在某些浏览器上切一次窗口会
 * 连发好几发（切走、失焦、切回来各一次），状态没变就没必要再打一次请求。
 *
 * null = 还没成功报过任何东西，此时任何一次上报都要真的发出去。
 * 上报失败也会把它清回 null——宁可下次多发一次，也不能因为「以为报过了」而漏报。
 */
let lastReported: boolean | null = null;

/** 当前页面是不是可见。jsdom 和老浏览器里没有 visibilityState，那就当可见。 */
export function documentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

/**
 * 报一次。**发射后不管**：这个函数不返回 Promise，也从不抛。
 *
 * @param visible 页面在不在前台
 * @param force   忽略去重强制发一次。SSE（重）连上时要用：服务端把可见性状态挂在连接上，
 *                连接是新的，状态就得重报一遍，否则服务端重启 / 断线重连之后，
 *                一个明明开着的页面会被一直当成后台，白收一堆推送。
 */
export function reportVisibility(visible: boolean, { force = false } = {}): void {
  if (!force && lastReported === visible) return;
  // 先记下来再发。中途又来一发同样的状态时不会重复打请求；真失败了下面再清回去。
  lastReported = visible;
  try {
    void api.pushVisibility({ deviceId: deviceId(), streamId: pageStreamId(), visible })
      .catch((err) => {
        // 失败的方向要说清楚：
        // - 丢的是「我在前台」→ 服务端仍按后台处理 → 多推一条，只是打扰，可接受；
        // - 丢的是「我在后台」→ 服务端还以为在前台 → **漏推**，这才是要命的那一侧。
        //   清掉去重记忆，让下一次状态变化（哪怕是变回同一个值）一定重发。
        lastReported = null;
        console.warn('[loop-im] 上报页面可见性失败，这台设备的推送判定可能暂时不准', err);
      });
  } catch (err) {
    lastReported = null;
    console.warn('[loop-im] 上报页面可见性失败', err);
  }
}

/**
 * 挂上 `visibilitychange` 监听并立刻报一次当前状态。返回取消监听的函数。
 *
 * 立刻报这一下不能省：页面刚起来时服务端那边默认是「后台」（它从不假设），
 * 不报的话用户开着页面也会收推送，一直到他第一次切窗口为止。
 */
export function startVisibilityReporting(): () => void {
  reportVisibility(documentVisible(), { force: true });
  if (typeof document === 'undefined') return () => {};
  const onChange = () => reportVisibility(documentVisible());
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** 只给测试用：把模块级的两个缓存清干净，免得用例之间互相串。 */
export function resetVisibilityForTest(): void {
  currentStreamId = null;
  lastReported = null;
}
