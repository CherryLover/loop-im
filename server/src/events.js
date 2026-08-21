// Minimal SSE hub: one connection per client, fan-out by user id.
import { logEvent } from './log.js';

const clients = new Map(); // userId -> Set<res>

export function subscribe(userId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
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
  for (const res of clients.get(userId) || []) res.end();
  clients.delete(userId);
}

export function emitTo(userIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) {
    for (const res of clients.get(id) || []) res.write(payload);
  }
}

export const emitAll = (event, data) => emitTo([...clients.keys()], event, data);
