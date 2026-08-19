// Minimal SSE hub: one connection per client, fan-out by user id.
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

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    clients.get(userId)?.delete(res);
    if (clients.get(userId)?.size === 0) clients.delete(userId);
  });
}

export function emitTo(userIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) {
    for (const res of clients.get(id) || []) res.write(payload);
  }
}

export const emitAll = (event, data) => emitTo([...clients.keys()], event, data);
