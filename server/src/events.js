// Minimal SSE hub: one connection per client, fan-out by user id.
import { logEvent } from './log.js';

/**
 * userId -> Map<res, deviceId | null>
 *
 * 为什么从 `Set<res>` 换成 `Map<res, deviceId>`：推送判定要知道**哪台设备**此刻连着，
 * 而不只是「这个人在不在线」（见 docs/PWA-与推送改造方案.md §C.3）。
 * 按人判会漏掉最常见的场景——桌面挂着网页（SSE 活着）+ 手机 PWA 关着 → 一条推送都不发
 * → 手机永远静默，而「人不在电脑前」正是最需要手机响的时候。
 *
 * 换成 Map 之后，凡是要遍历「这个人的所有连接」的地方都必须走 `.keys()`：
 * 直接 `for (const res of map)` 拿到的是 `[res, deviceId]` 这个数组，不是 res。
 * emitTo / emitAll / disconnect 的对外行为一个字都没变，只有遍历写法变了。
 */
const clients = new Map();

/**
 * 这条连接是哪台设备开的。
 *
 * 优先用调用方显式传进来的 deviceId；没传就从查询串上读 `?device=`
 * （`EventSource` 没法带自定义头，和 token 一样只能走查询串）。
 *
 * 之所以留这条兜底而不是要求调用方必须传：挂 SSE 路由的 `app.js` 归别的任务包，
 * 本包无权改它，而 deviceId 又必须在建连的那一刻就记下来。等那边显式传参之后，
 * 显式的那个自然优先，这里一行都不用动，两条路也不会打架。
 */
function deviceOf(res) {
  const raw = res?.req?.query?.device;
  // `?device=a&device=b` 时 express 给的是数组；只认单个非空字符串，其余一律当没带。
  return typeof raw === 'string' && raw ? raw : null;
}

export function subscribe(userId, res, deviceId = null) {
  // 老客户端不带 device 也不能崩：拿不到就是 null，这条连接只是不参与「设备在线」判定。
  const device = deviceId ?? deviceOf(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  if (!clients.has(userId)) clients.set(userId, new Map());
  clients.get(userId).set(res, device);
  logEvent('sse.connected', { userId, connections: clients.get(userId).size });

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    clients.get(userId)?.delete(res);
    logEvent('sse.disconnected', { userId, connections: clients.get(userId)?.size ?? 0 });
    if (clients.get(userId)?.size === 0) clients.delete(userId);
  });
}

/**
 * 这个人此刻有哪些设备连着 SSE。没带 deviceId 的连接不进这个集合。
 *
 * 推送判定用它来跳过「那台设备上的网页正开着」的订阅：SSE 连接和推送订阅本来就是
 * 同一台设备上的两条通道，一条活着另一条就该闭嘴，天然互补、不重不漏（§C.3）。
 *
 * ⚠️ 已知窗口，不打算解决（§C.4）：TCP 半开时（进电梯、拔网线）连接对象还在这张表里，
 * 服务端以为在线于是不推，最坏要等 25 秒的心跳写失败才发现。判定原则是
 * 「宁可多推一条，不可漏推」，所以断开方向一律不做宽限期——`res.on('close')` 里
 * 立刻摘掉，下一条消息就推。反方向这个窗口在 TCP 层面消不掉。
 */
export function onlineDeviceIds(userId) {
  const out = new Set();
  for (const deviceId of clients.get(userId)?.values() || []) {
    if (deviceId) out.add(deviceId);
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
