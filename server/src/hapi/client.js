// hapi hub 的 HTTP 客户端（对接版本：0.27.3，接口形状逐条对过该 tag 的 hub 源码）。
//
// 认证链路：.env 里的 HAPI_TOKEN 是 hub 的 access token（长期有效），
// POST /api/auth 用它换一个 4 小时过期的 JWT；任何请求撞上 401 就换新 JWT 重试一次。
// JWT 只在内存里，不落库。
//
// ⚠️ hub 可能架在 Cloudflare 后面，默认 UA 会被浏览器完整性检查拦下（error 1010），
// 所以每个请求都带自定义 UA。
//
// 这里只做「怎么调」，不做「何时调 / 调了之后业务上怎么办」——那是 agents.js
// 和后续消息流转的事。所有函数在未配置（isHapiConfigured() 为 false）时直接抛错，
// 调用方应先判配置再进来。
import { logWarn } from '../log.js';

const UA = 'loop-im/1.0 (+https://github.com/CherryLover/loop-im)';

/** 部署层配置全部来自环境变量（docs/hapi-Agent-接入方案.md §C.1），读时取值方便测试注入。 */
export const hapiConfig = () => ({
  baseUrl: (process.env.HAPI_BASE_URL || '').replace(/\/$/, ''),
  token: process.env.HAPI_TOKEN || '',
  machineId: process.env.HAPI_MACHINE_ID || '',
  workroot: process.env.HAPI_WORKROOT || '',
});

export const isHapiConfigured = () => {
  const c = hapiConfig();
  return !!(c.baseUrl && c.token && c.machineId && c.workroot);
};

let jwt = null;                    // 进程内缓存的 JWT；null = 还没换过或已作废
export const resetJwtForTest = () => { jwt = null; };

/** 换 JWT。失败抛错（带上游状态码），由调用方决定怎么向用户交代。 */
async function authenticate(fetchImpl) {
  const { baseUrl, token } = hapiConfig();
  const res = await fetchImpl(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ accessToken: token }),
  });
  if (!res.ok) throw new Error(`hapi auth failed: ${res.status}`);
  const body = await res.json();
  if (!body?.token) throw new Error('hapi auth: response has no token');
  jwt = body.token;
  return jwt;
}

/**
 * 发一个带 JWT 的请求；401 时换新 JWT 重试一次（JWT 4 小时过期是常态，不算错误）。
 * 返回解析后的 JSON；非 2xx 抛 Error 且带 status 字段，调用方按需分档处理。
 */
async function request(method, path, body, { fetchImpl = fetch } = {}) {
  const { baseUrl } = hapiConfig();
  const doFetch = async () => {
    if (!jwt) await authenticate(fetchImpl);
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'user-agent': UA,
        authorization: `Bearer ${jwt}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  let res = await doFetch();
  if (res.status === 401) {
    jwt = null;
    res = await doFetch();
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 上游给了非 JSON，走下面的错误分支 */ }
  if (!res.ok) {
    const err = new Error(`hapi ${method} ${path} → ${res.status}${json?.error ? `: ${json.error}` : ''}`);
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json;
}

// ---- 各接口的薄封装（形状见 v0.27.3 hub/src/web/routes/*.ts） -------------

/** GET /health：不需要认证。返回 { status, protocolVersion, capabilities }。 */
export async function health({ fetchImpl = fetch } = {}) {
  const { baseUrl } = hapiConfig();
  const res = await fetchImpl(`${baseUrl}/health`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`hapi health → ${res.status}`);
  return res.json();
}

/** 全部机器：[{ id, active, metadata: { host, workspaceRoots, … }, runnerState }] */
export async function machines(opts) {
  const body = await request('GET', '/api/machines', undefined, opts);
  return body?.machines || [];
}

/** 配置指定的那台机器；不在线或不存在时返回 null（调用方据此停用全部 Agent 用户）。 */
export async function configuredMachine(opts) {
  const { machineId } = hapiConfig();
  const list = await machines(opts);
  return list.find((m) => m.id === machineId) || null;
}

/** 机器算「在线」：hub 标记 active 且 runner 进程在跑。 */
export const isMachineOnline = (machine) =>
  !!machine && machine.active === true && machine.runnerState?.status === 'running';

/**
 * 开会话。0.27.3 的响应是 { type: 'success', sessionId } 或 { type: 'error', message }
 * （schema 见 shared/src/apiTypes.ts 的 SpawnSessionRequestSchema / SpawnSessionResultSchema）。
 * 失败统一抛错，让上层归到「暂不可用」那一档去。
 */
export async function spawnSession({ directory, agent, yolo = true }, opts) {
  const { machineId } = hapiConfig();
  const body = await request('POST', `/api/machines/${machineId}/spawn`, { directory, agent, yolo }, opts);
  if (body?.type !== 'success' || !body.sessionId) {
    throw new Error(`hapi spawn failed: ${body?.message || 'unknown'}`);
  }
  return body.sessionId;
}

/** 会话详情：{ session: { id, active, thinking, thinkingAt, agentState, metadata, … } }；404 时返回 null。 */
export async function session(id, opts) {
  try {
    const body = await request('GET', `/api/sessions/${id}`, undefined, opts);
    return body?.session || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** 复活一个断掉的会话。成功返回（可能变化的）sessionId；失败抛错（err.code 有 hub 的归因）。 */
export async function resumeSession(id, opts) {
  const body = await request('POST', `/api/sessions/${id}/resume`, {}, opts);
  return body?.sessionId || id;
}

export async function reopenSession(id, opts) {
  const body = await request('POST', `/api/sessions/${id}/reopen`, {}, opts);
  return body?.sessionId || id;
}

/** 给会话发一条消息；回复经 SSE 到达（POST 只回 { ok: true }）。 */
export async function sendSessionMessage(id, text, opts) {
  return request('POST', `/api/sessions/${id}/messages`, { text }, opts);
}

/** 翻会话消息（默认最新 50 条）：{ messages: [{ id, seq, content, createdAt, … }], … } */
export async function sessionMessages(id, { limit = 50 } = {}, opts) {
  return request('GET', `/api/sessions/${id}/messages?limit=${limit}`, undefined, opts);
}

/**
 * 从一条 hapi 消息的 content 里抽出「Agent 说的话」的纯文本。
 * 逻辑照抄 hub 自己的 extractAssistantPlainText（v0.27.3 shared/src/messages.ts）：
 * 消息是 { role, content } 信封（可能再包一层 message / data.message）；
 * role='agent' 且 content.type 为 'codex'（data.message 是字符串）或
 * 'output'（claude SDK 透传，assistant message.content[] 里的 text 块）才算数；
 * 工具调用、推理过程、token 统计一律返回 null，调用方跳过。
 */
export function extractAgentText(content) {
  const record = unwrapEnvelope(content);
  if (!record || record.role !== 'agent') return null;
  const c = record.content;
  if (!c || typeof c !== 'object') return null;

  if (c.type === 'codex') {
    const data = c.data;
    if (!data || typeof data !== 'object' || data.type !== 'message') return null;
    return typeof data.message === 'string' && data.message.length > 0 ? data.message : null;
  }
  if (c.type === 'output') {
    const data = c.data;
    if (!data || typeof data !== 'object') return null;
    if (data.type === 'agy_message') {
      return typeof data.content === 'string' && data.content.trim() ? data.content : null;
    }
    if (data.type !== 'assistant') return null;
    const blocks = Array.isArray(data.message?.content) ? data.message.content : null;
    if (!blocks) return null;
    const parts = blocks
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

function unwrapEnvelope(value) {
  const isRecord = (v) => !!v && typeof v === 'object' && typeof v.role === 'string' && 'content' in v;
  if (isRecord(value)) return value;
  if (!value || typeof value !== 'object') return null;
  if (isRecord(value.message)) return value.message;
  const data = value.data;
  if (data && typeof data === 'object' && isRecord(data.message)) return data.message;
  return null;
}

/**
 * 订阅 hub 的 SSE 事件流（GET /api/events?sessionId=…，Bearer JWT）。
 * 事件是一行行 `data: <json>`；要关心的类型（v0.27.3 SyncEventSchema）：
 * 'message-received'（带 message: DecryptedMessage）、'session-updated'（thinking 翻转）、
 * 'session-ended'、'heartbeat'。
 *
 * 返回 { close, ready }。ready 在事件流**真正挂上**时兑现——调用方要先 await ready
 * 再触发会产生事件的动作，否则「订阅还在握手、事件已经发完」这个竞态会把回合漏掉。
 * 断线自动重连（指数退避，封顶 30 秒）；close() 后不再重连。
 * onEvent 抛错不会打断读取（记日志继续），一条坏事件不该弄死整个订阅。
 */
export function openEvents({ sessionId, onEvent, fetchImpl = fetch }) {
  let closed = false;
  let backoff = 1000;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  // close() 必须真的掐断在途连接：光设标记的话，流上没有新字节时 for-await 永远
  // 醒不过来，连接和进程句柄就一直挂着（测试进程因此退不出去，生产则是慢性泄漏）。
  const controller = new AbortController();

  const connect = async () => {
    while (!closed) {
      try {
        if (!jwt) await authenticate(fetchImpl);
        const { baseUrl } = hapiConfig();
        const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '?all=true';
        const res = await fetchImpl(`${baseUrl}/api/events${qs}`, {
          headers: { 'user-agent': UA, authorization: `Bearer ${jwt}`, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (res.status === 401) { jwt = null; continue; }
        if (!res.ok || !res.body) throw new Error(`hapi events → ${res.status}`);
        backoff = 1000;
        readyResolve();
        await readSse(res.body, (event) => {
          try { onEvent(event); } catch (err) { logWarn('hapi.events.handler_failed', { detail: String(err) }); }
        }, () => closed);
        // 流正常结束（服务端关连接）也走重连
      } catch (err) {
        if (!closed) logWarn('hapi.events.disconnected', { detail: String(err) });
      }
      if (closed) break;
      // 重连退避挂在可中止的计时器上：close() 时立刻醒来退出，不拖住进程。
      await new Promise((resolve) => {
        const t = setTimeout(resolve, backoff);
        controller.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      backoff = Math.min(backoff * 2, 30_000);
    }
    readyResolve();                                       // close 后也要放行等 ready 的人
  };
  const running = connect();
  return {
    close: () => { closed = true; controller.abort(); },
    ready,
    // 测试用：等 connect 循环退出，避免悬着的定时器
    _done: running,
  };
}

/** 极简 SSE 解析：只认 data: 行，空行分帧。够用——hub 的每帧就是一行 JSON。 */
async function readSse(stream, emit, isClosed) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    if (isClosed()) return;
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { emit(JSON.parse(payload)); } catch { /* 非 JSON 帧（不该出现），忽略 */ }
    }
  }
}
