// 一条 IM 消息到 hapi Agent 的完整旅程（docs/hapi-Agent-接入方案.md §C.3'/§C.4/§D/§G）。
//
// 触发（D4/D5）：群里被 @ 才响应，Agent 私聊每条都响应；AI 用户发的消息永不触发任何
// AI（防互相 @ 出死循环的硬规则）；@全员 不触发。
//
// 会话模型（§C.3'，2026-08-31 修订）：**每个「Agent × IM 会话」一条 hapi 会话**。
// 上下文由 hapi 会话自身在底层携带、由本地 Agent CLI 自己管理——消息**原样转发**，
// 不做任何上下文拼接（参照 HapiKmp 手机客户端：请求体就是 {text, localId}）。
// 唯一进文本的额外内容是群聊里的署名「张三：」——发消息接口没有「发送者」元数据
// 字段，而群里有多个人在跟同一条会话说话；私聊连署名都不加，原文直达。
// 人设与前缀的读法在 Agent 工作目录的 CLAUDE.md / AGENTS.md 里（启用时自动铺设，
// 见 agents.js 的 provisionAgentWorkdir）——会话内容里零注入，第一条也不例外。
//
// 串行队列按「Agent × 会话」分：不同群里可以并行（各自是独立的 hapi 会话/进程），
// 同一会话内一次一件事。队列积压超上限直接回「排队请求过多」。在途请求不落库（D9）。
//
// 回合结束的判定：session-updated 的 thinking 从 true 翻回 false 即结束，取回合内
// **最后一条** Agent 文本；见过 thinking 信号就不用「安静兜底」（Agent 干活前的
// 中场白不能被当成最终回复——真实环境踩过）。整体超时后出队，任务在 hapi 侧还在跑。
import { get, run, now } from '../db.js';
import { emitTo } from '../events.js';
import { logError, logEvent, logWarn } from '../log.js';
import {
  extractAgentText, hapiConfig, isHapiConfigured, openEvents,
  resumeSession, sendSessionMessage, session, spawnSession,
} from './client.js';
import { flavorOf } from './agents.js';

export const AGENT_UNAVAILABLE = (name) => `${name} 暂不可用，请联系管理员`;
export const AGENT_BUSY = (name) => `${name} 排队请求过多，请稍后再试`;
export const AGENT_TIMEOUT = (name) => `${name} 处理超时，任务可能仍在 hapi 侧继续，稍后可以再问一句拿结果`;
export const AGENT_NO_TEXT = (name) => `${name} 本次执行完成，但没有返回文字回复`;

const MAX_QUEUE = Number(process.env.HAPI_QUEUE_MAX || 5);
const turnTimeoutMs = () => Number(process.env.HAPI_TURN_TIMEOUT_MS || 10 * 60_000);
const QUIET_MS = () => Number(process.env.HAPI_TURN_QUIET_MS || 5_000);

/**
 * 这条刚发出的消息触发哪些 Agent。返回 [{ key, userId, name }]。
 * 停用中的 Agent（机器离线）也会返回——它要负责回一句 D6 的「暂不可用」，
 * 已读不回是最糟的体验。
 */
export function agentTargetsFor({ convo, roster, mentions, sender }) {
  if (!sender || sender.role === 'ai') return [];          // D5：AI 永不触发 AI
  const agents = roster.filter((u) => u.role === 'ai' && u.id.startsWith('ai-'));
  if (!agents.length) return [];
  const hit = convo.type === 'ai'
    ? agents                                               // 私聊：每条都响应
    : agents.filter((u) => mentions.includes(u.id));       // 群聊：被 @ 才响应（@全员 不算）
  return hit.map((u) => ({ key: u.id.slice(3), userId: u.id, name: u.name }));
}

// ---- 串行队列（每个「Agent × 会话」一条，跨会话并行） ---------------------

const queues = new Map();                                  // `${key}:${convoId}` -> { tail, depth }

function enqueue(queueKey, job) {
  const q = queues.get(queueKey) || { tail: Promise.resolve(), depth: 0 };
  if (q.depth >= MAX_QUEUE) return false;
  q.depth += 1;
  q.tail = q.tail
    .then(() => job())
    .catch((err) => logError('hapi.turn.failed', err))
    .finally(() => { q.depth -= 1; });
  queues.set(queueKey, q);
  return true;
}

// 「输入中」按会话计数：一个会话里可能同时有多个 Agent 在干活，
// 最后一个收工才熄灯，不然先完成的会把别人的指示灯关掉。
const typingCount = new Map();                             // conversationId -> number
function setTyping(audience, conversationId, on, emit) {
  const n = (typingCount.get(conversationId) || 0) + (on ? 1 : -1);
  typingCount.set(conversationId, Math.max(0, n));
  const visible = (typingCount.get(conversationId) || 0) > 0;
  try {
    emit(audience, 'ai-typing', { conversationId, typing: visible });
  } catch (err) {
    logWarn('hapi.turn.typing_emit_failed', { detail: String(err) });
  }
}

// ---- 会话记录（hapi_sessions：Agent × IM 会话 → hapi 会话 id） ------------

const sessionRow = (key, conversationId) =>
  get('SELECT * FROM hapi_sessions WHERE agent_key = ? AND conversation_id = ?', key, conversationId);

function upsertSessionRow(key, conversationId, sessionId) {
  run(
    `INSERT INTO hapi_sessions (agent_key, conversation_id, session_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_key, conversation_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    key, conversationId, sessionId, now(),
  );
}

// ---- 会话保活（判活 → resume → spawn；每个「Agent × 会话」一条） ----------

/**
 * spawn/resume 返回 id 只代表「hub 受理了」：runner 上的 Agent 进程要几秒才起来，
 * 期间会话是 inactive，消息发过去会被 hub 以 409 拒掉（真实环境实测踩到）。
 * 所以起完要轮询到 active 再发。
 */
async function waitActive(sessionId, { timeoutMs = 60_000 } = {}) {
  const intervalMs = Number(process.env.HAPI_ACTIVE_POLL_MS || 1000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await session(sessionId);
    if (s?.active) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function ensureSession(key, conversationId) {
  const row = sessionRow(key, conversationId);
  let sessionId = row?.session_id || null;

  if (sessionId) {
    const s = await session(sessionId);
    if (!s) {
      sessionId = null;                                    // 会话整个没了，走 spawn
    } else if (!s.active) {
      try {
        sessionId = await resumeSession(sessionId);
      } catch (err) {
        logWarn('hapi.turn.resume_failed', { agent: key, detail: String(err.message || err) });
        sessionId = null;
      }
    }
  }
  if (!sessionId) {
    const { workroot } = hapiConfig();
    // 同一 Agent 的所有会话共用同一个工作目录：记忆文件是它这个「个体」的，不分场合。
    sessionId = await spawnSession({ directory: `${workroot.replace(/\/$/, '')}/${key}`, agent: key, yolo: true });
  }
  if (sessionId !== row?.session_id) upsertSessionRow(key, conversationId, sessionId);
  if (!(await waitActive(sessionId))) throw new Error(`session ${sessionId} not active in time`);
  return { sessionId };
}

// ---- 等回复：SSE 上收文本，thinking 翻回 false 即收工 ---------------------

function waitForReply({ sessionId, timeoutMs, quietMs, events = openEvents }) {
  let subRef = null;
  const promise = new Promise((resolve) => {
    let lastText = null;
    let started = false;
    let quietTimer = null;
    let done = false;

    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      sub.close();
      resolve(outcome);
    };
    const armQuiet = () => {
      // 只在**从没见过 thinking 信号**时才用「安静几秒算结束」的兜底。
      // 见过 thinking=true 就以 thinking=false 为准：Agent 干活前常先说一句
      //「我来看一下…」，随后跑几十秒工具——这时安静计时器一响，就把中场白
      // 当成最终回复贴出去了（真实环境踩到）。
      if (started) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish({ kind: 'done', text: lastText }), quietMs);
    };

    const hardTimer = setTimeout(() => finish({ kind: 'timeout', text: lastText }), timeoutMs);
    const sub = subRef = events({
      sessionId,
      onEvent: (event) => {
        if (event.type === 'message-received' && event.sessionId === sessionId) {
          const text = extractAgentText(event.message?.content);
          if (text) {
            lastText = text;
            armQuiet();
          }
        } else if (event.type === 'session-updated' && event.sessionId === sessionId) {
          const thinking = event.data?.thinking;
          if (thinking === true) {
            started = true;
            clearTimeout(quietTimer);                      // 从此只认 thinking 翻转，安静兜底退场
          } else if (thinking === false && started) {
            finish({ kind: 'done', text: lastText });
          }
        } else if (event.type === 'session-ended' && event.sessionId === sessionId) {
          finish({ kind: 'ended', text: lastText });
        }
      },
    });
  });
  // 调用方必须先 await ready 再发消息：订阅握手期间发出的事件是收不到的。
  return { promise, ready: subRef.ready };
}

// ---- 主流程 ---------------------------------------------------------------

/**
 * 发消息路由在 201 之后调它（发射后不管）。deps 可整体覆盖，测试用。
 * postReply 由路由注入：以 Agent 用户的身份把一条 Markdown 消息贴回会话
 * （入库 + SSE 广播 + 推送），返回无所谓。
 */
export function runAgentTurns({ convo, sender, body, roster, audience, targets, postReply }, deps = {}) {
  const {
    emit = emitTo,
    ensure = ensureSession,
    send = sendSessionMessage,
    wait = waitForReply,
    timeoutMs = turnTimeoutMs(),
    quietMs = QUIET_MS(),
  } = deps;

  for (const target of targets) {
    const say = (text) => {
      try {
        postReply(target, text);
      } catch (err) {
        logError('hapi.turn.post_failed', err);
      }
    };

    const job = async () => {
      setTyping(audience, convo.id, true, emit);
      try {
        // D6：停用中（机器离线/取消勾选后残留在群里）或整体没配置 → 固定文案
        const userRow = get('SELECT * FROM users WHERE id = ?', target.userId);
        if (!isHapiConfigured() || !userRow || userRow.disabled_at || !flavorOf(target.key)) {
          say(AGENT_UNAVAILABLE(target.name));
          return;
        }
        let ensured;
        try {
          ensured = await ensure(target.key, convo.id);
        } catch (err) {
          logWarn('hapi.turn.session_unavailable', { agent: target.key, detail: String(err.message || err) });
          say(AGENT_UNAVAILABLE(target.name));
          return;
        }
        // 消息原样转发（§C.3'）：上下文在 hapi 会话里自然延续，由 Agent 自己管理。
        // 群聊补一个署名前缀（接口没有发送者字段）；私聊原文直达。第一条也不例外——
        // 人设在工作目录的 CLAUDE.md / AGENTS.md 里，不在会话内容里。
        const text = convo.type === 'group' ? `${sender.name}：${body}` : body;

        // 先挂事件流、**等它真正连上**再发消息——回合再快也不会漏事件。
        const waiter = wait({ sessionId: ensured.sessionId, timeoutMs, quietMs });
        await waiter.ready;
        try {
          try {
            await send(ensured.sessionId, text);
          } catch (err) {
            // 竞态兜底：active 轮询和真正可收消息之间仍可能差一口气，409 就再等一轮重发一次。
            if (err.status !== 409) throw err;
            logWarn('hapi.turn.send_409_retry', { agent: target.key });
            await waitActive(ensured.sessionId, { timeoutMs: 30_000 });
            await send(ensured.sessionId, text);
          }
        } catch (err) {
          logWarn('hapi.turn.send_failed', { agent: target.key, detail: String(err.message || err) });
          say(AGENT_UNAVAILABLE(target.name));
          return;
        }
        const outcome = await waiter.promise;
        logEvent('hapi.turn.finished', { agent: target.key, conversationId: convo.id, outcome: outcome.kind, hasText: !!outcome.text });
        if (outcome.kind === 'timeout' && !outcome.text) say(AGENT_TIMEOUT(target.name));
        else if (outcome.kind === 'ended' && !outcome.text) say(AGENT_UNAVAILABLE(target.name));
        else if (!outcome.text) say(AGENT_NO_TEXT(target.name));
        else say(outcome.text);
      } finally {
        setTyping(audience, convo.id, false, emit);
      }
    };

    if (enqueue(`${target.key}:${convo.id}`, job)) continue;
    try {
      postReply(target, AGENT_BUSY(target.name));           // 队列满：立刻回话，不静默丢
    } catch (err) {
      logError('hapi.turn.post_failed', err);
    }
  }
}
