// 一个受测试控制的假 hapi hub：只实现我们客户端会碰的那几个端点，
// 形状照抄 v0.27.3（auth 换 JWT、machines 列表、spawn、session、messages、SSE events）。
// 每个用例可以随意改 state 来模拟机器离线、JWT 过期、spawn 失败等情形。
import { createServer } from 'node:http';

export async function startMockHub({ accessToken = 'test-access-token' } = {}) {
  const state = {
    accessToken,
    jwtSerial: 1,                    // 换发的 JWT 是 jwt-<serial>；invalidateJwts() 后旧的全 401
    machines: [],
    spawnResult: { type: 'success', sessionId: 's_mock_1' },
    sessions: new Map(),             // id -> session 对象
    messages: new Map(),             // id -> DecryptedMessage[]
    requests: [],                    // { method, path, ua, auth } 供断言
    sseClients: new Set(),
  };

  const validJwt = () => `jwt-${state.jwtSerial}`;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const record = { method: req.method, path: url.pathname, ua: req.headers['user-agent'] || '', auth: req.headers.authorization || '' };
    state.requests.push(record);
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;

      if (req.method === 'GET' && url.pathname === '/health') return json(200, { status: 'ok', protocolVersion: 1 });
      if (req.method === 'POST' && url.pathname === '/api/auth') {
        if (body?.accessToken !== state.accessToken) return json(401, { error: 'bad token' });
        return json(200, { token: validJwt(), user: { id: 'owner' } });
      }
      // 其余全部要 JWT
      if (record.auth !== `Bearer ${validJwt()}`) return json(401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/api/machines') return json(200, { machines: state.machines });
      const spawn = url.pathname.match(/^\/api\/machines\/([^/]+)\/spawn$/);
      if (req.method === 'POST' && spawn) {
        state.lastSpawn = { machineId: spawn[1], ...body };
        return json(200, state.spawnResult);
      }
      const msgs = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (msgs && req.method === 'GET') return json(200, { messages: state.messages.get(msgs[1]) || [] });
      if (msgs && req.method === 'POST') {
        state.lastMessage = { sessionId: msgs[1], ...body };
        return json(200, { ok: true });
      }
      const resume = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
      if (resume && req.method === 'POST') return json(200, { type: 'success', sessionId: resume[1] });
      const sess = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sess && req.method === 'GET') {
        const s = state.sessions.get(sess[1]);
        return s ? json(200, { session: s }) : json(404, { error: 'Session not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const client = res;
        state.sseClients.add(client);
        res.on('close', () => state.sseClients.delete(client));
        return; // 挂着不结束
      }
      return json(404, { error: `mock has no ${req.method} ${url.pathname}` });
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    state,
    /** 让所有已换发的 JWT 立刻失效（模拟 4 小时过期）。 */
    invalidateJwts: () => { state.jwtSerial += 1; },
    /** 给所有挂着的 SSE 客户端推一个事件。 */
    pushEvent: (event) => {
      for (const c of state.sseClients) c.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    onlineMachine: (id, host = 'Mock-Machine') => ({
      id, active: true, metadata: { host }, runnerState: { status: 'running' },
    }),
    close: () => new Promise((resolve) => {
      for (const c of state.sseClients) c.end();
      server.close(resolve);
    }),
  };
}
