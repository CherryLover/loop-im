// 一条 IM 消息到 hapi Agent 的完整旅程（docs/hapi-Agent-接入方案.md §C.3/§C.4/§D/§G）。
//
// 触发（D4/D5）：群里被 @ 才响应，Agent 私聊每条都响应；AI 用户发的消息永不触发任何
// AI（防互相 @ 出死循环的硬规则）；@全员 不触发。
//
// 会话模型（§C.3）：每个 Agent 一个全局 hapi 会话，承接它在所有群和私聊里的全部请求。
// 会话是可抛弃的现场：发消息前判活，死了 resume，再不行就在同一目录 spawn 新的——
// 记忆靠工作目录里的文件（人设与守则放在 runner 侧，见方案 §E）。
//
// 串行队列（§C.3）：同一 Agent 一次处理一条，排队期间「输入中」持续亮着；不同 Agent
// 并行。队列积压超过上限直接回「排队请求过多」。在途请求不落库（D9）：进程重启即丢，
// 用户再问一次。
//
// 回合结束的判定：hub 的 session-updated 事件带 thinking 布尔（true=Agent 在干活）。
// thinking 从 true 翻回 false 即回合结束，取回合内**最后一条** Agent 文本当回复
//（中间的工具调用、推理过程不转发）。有些流转不出 thinking 翻转（极快的回合），
// 兜底：收到过文本且安静了几秒也算结束。整体超时后出队，任务在 hapi 侧其实还在跑。
import { get, all } from '../db.js';
import { emitTo } from '../events.js';
import { logError, logEvent, logWarn } from '../log.js';
import { truncate } from '../text.js';
import {
  extractAgentText, hapiConfig, isHapiConfigured, openEvents,
  resumeSession, sendSessionMessage, session, spawnSession,
} from './client.js';
import { agentRow, agentUserId, flavorOf, setAgentSession } from './agents.js';

export const AGENT_UNAVAILABLE = (name) => `${name} 暂不可用，请联系管理员`;
export const AGENT_BUSY = (name) => `${name} 排队请求过多，请稍后再试`;
export const AGENT_TIMEOUT = (name) => `${name} 处理超时，任务可能仍在 hapi 侧继续，稍后可以再问一句拿结果`;
export const AGENT_NO_TEXT = (name) => `${name} 本次执行完成，但没有返回文字回复`;

const MAX_QUEUE = Number(process.env.HAPI_QUEUE_MAX || 5);
const turnTimeoutMs = () => Number(process.env.HAPI_TURN_TIMEOUT_MS || 10 * 60_000);
const QUIET_MS = () => Number(process.env.HAPI_TURN_QUIET_MS || 5_000);
const CONTEXT_MESSAGES = 20;

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

// ---- 串行队列（每个 Agent 一条） -----------------------------------------

const queues = new Map();                                  // key -> { tail: Promise, depth: number }

function enqueue(key, job) {
  const q = queues.get(key) || { tail: Promise.resolve(), depth: 0 };
  if (q.depth >= MAX_QUEUE) return false;
  q.depth += 1;
  q.tail = q.tail
    .then(() => job())
    .catch((err) => logError('hapi.turn.failed', err))
    .finally(() => { q.depth -= 1; });
  queues.set(key, q);
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

// ---- 请求正文的拼装（§C.4） ----------------------------------------------

/** 群里最近几条消息当上下文；正文超长的截断，系统提示跳过。 */
function contextBlock(conversationId, excludeMessageId) {
  const rows = all(
    `SELECT m.id, m.body, m.kind, u.name AS sender_name FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    conversationId, CONTEXT_MESSAGES + 1,
  ).filter((r) => r.kind !== 'system' && r.id !== excludeMessageId).slice(0, CONTEXT_MESSAGES).reverse();
  if (!rows.length) return '';
  const lines = rows.map((r) => `${r.sender_name || '成员'}: ${truncate(r.body.replace(/\s+/g, ' '), 300)}`);
  return `[最近的对话上下文]\n${lines.join('\n')}\n[/上下文]\n\n`;
}

/** 新会话的开场白：工作目录里的人设文件（方案 §E）还没铺好之前，这段就是底线守则。 */
function introBlock(agentName) {
  return `（你是团队 IM「Loop IM」里的成员「${agentName}」。接下来会收到带来源前缀的消息，`
    + `例如「群『发版』的 张三：…」。你的回复会原样贴回那个聊天，请用中文、直接说结论、`
    + `Markdown 排版；不要复述前缀，也不要把这段说明当成对话内容。）\n\n`;
}

function originPrefix(convo, senderName) {
  return convo.type === 'group'
    ? `群『${convo.title || '未命名群聊'}』的 ${senderName}`
    : `与你私聊的 ${senderName}`;
}

// ---- 会话保活（§C.3：判活 → resume → spawn） -----------------------------

async function ensureSession(key) {
  const row = agentRow(key);
  let isNew = false;
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
    sessionId = await spawnSession({ directory: `${workroot.replace(/\/$/, '')}/${key}`, agent: key, yolo: true });
    isNew = true;
  }
  if (sessionId !== row?.session_id) setAgentSession(key, sessionId);
  return { sessionId, isNew };
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
            armQuiet();                                    // 没有 thinking 翻转的兜底：文本后安静几秒算结束
          }
        } else if (event.type === 'session-updated' && event.sessionId === sessionId) {
          const thinking = event.data?.thinking;
          if (thinking === true) {
            started = true;
            clearTimeout(quietTimer);                      // 还在干活，别让安静计时器提前收工
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
export function runAgentTurns({ convo, sender, body, messageId, roster, audience, targets, postReply }, deps = {}) {
  const {
    emit = emitTo,
    ensure = ensureSession,
    send = sendSessionMessage,
    wait = waitForReply,
    timeoutMs = turnTimeoutMs(),
    quietMs = QUIET_MS(),
  } = deps;

  const jobs = targets.map((target) => {
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
          ensured = await ensure(target.key);
        } catch (err) {
          logWarn('hapi.turn.session_unavailable', { agent: target.key, detail: String(err.message || err) });
          say(AGENT_UNAVAILABLE(target.name));
          return;
        }
        const text = (ensured.isNew ? introBlock(target.name) : '')
          + contextBlock(convo.id, messageId)
          + `${originPrefix(convo, sender.name)}：${body}`;

        // 先挂事件流、**等它真正连上**再发消息——回合再快也不会漏事件。
        const waiter = wait({ sessionId: ensured.sessionId, timeoutMs, quietMs });
        await waiter.ready;
        try {
          await send(ensured.sessionId, text);
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

    return { target, job };
  });

  for (const { target, job } of jobs) {
    if (enqueue(target.key, job)) continue;
    try {
      postReply(target, AGENT_BUSY(target.name));           // 队列满：立刻回话，不静默丢
    } catch (err) {
      logError('hapi.turn.post_failed', err);
    }
  }
}
