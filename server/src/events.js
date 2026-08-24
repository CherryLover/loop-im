// Minimal SSE hub: one connection per client, fan-out by user id.
import { logEvent } from './log.js';

/**
 * userId -> Map<res, { deviceId, streamId, foreground }>
 *
 * 为什么从 `Set<res>` 换成 Map：推送判定要知道**哪台设备**此刻正被人看着，
 * 而不只是「这个人在不在线」（见 docs/PWA-与推送改造方案.md §C.3）。
 * 按人判会漏掉最常见的场景——桌面挂着网页 + 手机 PWA 关着 → 一条推送都不发
 * → 手机永远静默，而「人不在电脑前」正是最需要手机响的时候。
 *
 * 每条连接上记三样东西：
 * - `deviceId`：这条连接是哪台设备开的（`?device=`）；
 * - `streamId`：这条连接是**这台设备上的哪一个页面**开的（`?stream=`）。
 *   同一台设备可以开两个标签页，两条连接共用一个 deviceId，靠这个区分；
 * - `foreground`：这个页面**自己报告**它此刻在不在前台。默认 false，见下面 §「为什么
 *   不能拿连接在不在当在线」。
 *
 * 凡是要遍历「这个人的所有连接」的地方都必须走 `.keys()`：
 * 直接 `for (const res of map)` 拿到的是 `[res, state]` 这个数组，不是 res。
 * emitTo / emitAll / disconnect 的对外行为一个字都没变，只有遍历写法变了。
 */
const clients = new Map();

/**
 * 从查询串上读一个单值参数。
 *
 * `?device=a&device=b` 时 express 给的是数组；只认单个非空字符串，其余一律当没带。
 * `EventSource` 没法带自定义头，所以 device / stream 和 token 一样只能走查询串。
 */
function queryParam(res, name) {
  const raw = res?.req?.query?.[name];
  return typeof raw === 'string' && raw ? raw : null;
}

export function subscribe(userId, res, deviceId = null) {
  // 老客户端不带 device / stream 也不能崩：拿不到就是 null。
  // 这样的连接永远不会被 setDeviceVisibility 命中，于是永远算「没报告前台」→ 照推。
  const device = deviceId ?? queryParam(res, 'device');
  const stream = queryParam(res, 'stream');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  if (!clients.has(userId)) clients.set(userId, new Map());
  // foreground 一律从 false 起步。**不能默认 true**：默认 true 等于回到「连着就算在前台」，
  // 也就是下面那段说的那个真机 bug。页面自己报上来之前，这台设备一律按后台处理。
  clients.get(userId).set(res, { deviceId: device, streamId: stream, foreground: false });
  logEvent('sse.connected', { userId, connections: clients.get(userId).size });

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    // 可见性状态就挂在这条连接上，连接一没它自动跟着没——不需要额外的清理，
    // 也**不可能**残留（见 foregroundDeviceIds 的注释里那条边界）。
    clients.get(userId)?.delete(res);
    logEvent('sse.disconnected', { userId, connections: clients.get(userId)?.size ?? 0 });
    if (clients.get(userId)?.size === 0) clients.delete(userId);
  });
}

/**
 * 这台设备上的某个页面报告了自己在不在前台。`POST /api/push/visibility` 调这里。
 *
 * 按 `(deviceId, streamId)` 精确命中**一条连接**，不是按设备一把改：同一台设备开两个
 * 标签页时，甲可见、乙切走，只能改乙那一条；一把改会让乙的「后台」把甲的「前台」盖掉，
 * 于是用户正盯着甲看，手机（这台机器）还在冒推送。
 *
 * 命中不了（页面还没建 SSE、连接刚断、streamId 对不上）就什么都不做，返回 0。
 * **这个方向是安全的**：命中不了 = 没有连接报告前台 = 这台设备算后台 = 照推。
 *
 * @returns 改到了几条连接。0 表示没命中。
 */
export function setDeviceVisibility(userId, { deviceId, streamId, visible }) {
  if (!deviceId || !streamId) return 0;
  let changed = 0;
  for (const state of clients.get(userId)?.values() || []) {
    if (state.deviceId !== deviceId || state.streamId !== streamId) continue;
    state.foreground = !!visible;
    changed += 1;
  }
  return changed;
}

/**
 * 这台设备的**全部**可见性状态一把清成「后台」。限流兜底会用到（见 routes/push.js）。
 *
 * 只往「后台」这一个方向踩，永远不会踩成前台：这是「宁可多推一条，不可漏推」在
 * 异常路径上的具体落法——被限流的设备当作状态不明，状态不明就推。
 *
 * @returns 改到了几条连接。
 */
export function clearDeviceVisibility(userId, deviceId) {
  if (!deviceId) return 0;
  let changed = 0;
  for (const state of clients.get(userId)?.values() || []) {
    if (state.deviceId !== deviceId || !state.foreground) continue;
    state.foreground = false;
    changed += 1;
  }
  return changed;
}

/**
 * 这个人此刻有哪些设备**报告了自己在前台**。推送判定跳过这些设备。
 *
 * ── 为什么判据是「报告了前台」而不是「SSE 连接还在」（真机 bug，别改回去）──────
 *
 * 上一版这里返回的是「有 SSE 连接的设备」。真机上的表现：iPhone 上 PWA 还在前台 →
 * 立即切后台 → 马上让别人发消息 → **一条推送都收不到**；等久一点再发就有。
 *
 * 根因：iOS 冻结 PWA 时 **TCP 连接通常不会立刻断**。`res.write(': ping')` 还能往内核
 * 缓冲区里写成功，`res.on('close')` 好几分钟都不触发，服务端于是一直以为那台在线，
 * push-decide 直接跳过它——一个字节都没发给苹果。
 *
 * 旧注释把这个窗口写成「TCP 半开，最坏等 25 秒心跳」，**低估了**：拔网线是链路真的断了，
 * 而 iOS 冻结页面时链路好端端的，socket 在很长时间里都是「可写」的，心跳压根不会失败。
 *
 * 所以判定不再从连接的存在去**推断**页面状态，改成页面**主动上报**：
 * 页面在被冻结之前一定会收到 `visibilitychange`，那一刻用 `fetch(keepalive)` 报一句
 * 「我切后台了」（见 web/src/lib/visibility.ts）。上报到了就是到了，不用猜。
 *
 * ── 三条不变量 ────────────────────────────────────────────────────────
 *
 * 1. **默认后台。** 没报过的设备（老客户端、上报失败、刚建连还没来得及报）一律不在这个
 *    集合里，于是照推。判定原则是「宁可多推一条，不可漏推」——多一条通知是打扰，
 *    漏一条是功能失效。
 * 2. **状态挂在连接上，连接一断自动没。** 页面关掉 / 网断了，那条连接的 foreground
 *    跟着消失，这台设备立刻回到「后台」。反过来把状态存在别处（比如按 deviceId 存一张
 *    独立的表）就会残留：用户关掉浏览器的那一刻状态还停在「前台」，从此这台设备
 *    **永远收不到推送**，而且没有任何报错——正是最坏的那个方向。
 * 3. **同一台设备只要有一个页面在前台，这台设备就算前台。** 桌面开两个标签页，
 *    人在甲上看着、乙切走了，这台机器上的人**确实**看得见新消息，不该再推。
 */
export function foregroundDeviceIds(userId) {
  const out = new Set();
  for (const state of clients.get(userId)?.values() || []) {
    if (state.deviceId && state.foreground) out.add(state.deviceId);
  }
  return out;
}

/**
 * 掐断某个人当前所有的实时连接。
 *
 * authenticate 只在 SSE 建连的那一刻跑一次，之后这条连接就一直开着写事件；
 * 停用一个正在线上的人，不主动断开的话他那边还会继续收到消息，一直到自己关页面。
 * 所以停用时要显式调这个——挡住新连接（authenticate）+ 关掉老连接（这里），
 * 两件事都做了，「立刻失效」才是真的立刻。
 */
export function disconnect(userId) {
  const open = clients.get(userId)?.size || 0;
  // 停用一个人时被动断开的连接数：跟 admin.user.disabled 对着看，
  // 就知道「立刻掉线」到底有没有真的生效、当时他开着几个页面。
  if (open) logEvent('sse.force_disconnected', { userId, connections: open });
  for (const res of clients.get(userId)?.keys() || []) res.end();
  clients.delete(userId);
}

export function emitTo(userIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) {
    for (const res of clients.get(id)?.keys() || []) res.write(payload);
  }
}

export const emitAll = (event, data) => emitTo([...clients.keys()], event, data);
