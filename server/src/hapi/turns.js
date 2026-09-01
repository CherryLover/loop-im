// 一条 IM 消息到 hapi Agent 的完整旅程（docs/hapi-Agent-接入方案.md §C.3'/§C.4/§D/§G）。
//
// 触发（D4/D5）：群里被 @ 才响应，Agent 私聊每条都响应；AI 用户发的消息永不触发任何
// AI（防互相 @ 出死循环的硬规则）；@全员 不触发。
//
// 会话模型（§C.3'，2026-08-31 修订）：**每个「Agent × IM 会话」一条 hapi 会话**。
// 上下文由 hapi 会话自身在底层携带、由本地 Agent CLI 自己管理——**私聊消息原样转发**，
// 不做任何上下文拼接（参照 HapiKmp 手机客户端：请求体就是 {text, localId}）。
// 群聊自 2026-09-01 走「补课批次」（D14，见 backlog.js）：没 @ 它的消息平时不转发，
// 被 @ 时把上次水位之后的消息带时间与署名一起补给它——不补的话那些消息它永远看不到，
// 只能对着单句硬答（用户实测踩到）。这不违背零注入：补的是它从没收到过的，不是重复已知的。
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
  extractAgentText, extractGeneratedImages, extractToolCalls, hapiConfig, isHapiConfigured,
  openEvents, resumeSession, sendSessionMessage, session, spawnSession,
} from './client.js';
import { flavorOf } from './agents.js';
import { advanceWatermark, collectGroupBacklog, formatGroupBacklog } from './backlog.js';
import { beginTurn } from './steps.js';
import { annotateAttachments, deliverGeneratedImages, pushAttachmentsToSession } from './files.js';

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

// 「输入中」按会话计数，且细到每个 Agent：一个会话里可能同时有多个 Agent 在干活，
// 最后一个收工才熄灯（typing 布尔的老语义），不然先完成的会把别人的指示灯关掉。
// 计数结构是「会话 → (Agent 用户 id → 计数)」：同一 Agent 排队多条时只累计数，
// agents 列表里不重复出现；Map 的插入序天然就是「谁先开工」的顺序。
// payload 里 typing 布尔保留不动（老前端只认它），agents 是新增字段，
// 让前端能把指示器细到「是哪几个 Agent 在忙」。
const typingByConvo = new Map();                           // conversationId -> Map(agentUserId -> { name, count })
function setTyping(audience, conversationId, target, on, emit) {
  const perConvo = typingByConvo.get(conversationId) || new Map();
  typingByConvo.set(conversationId, perConvo);
  const entry = perConvo.get(target.userId);
  if (on) {
    if (entry) entry.count += 1;
    else perConvo.set(target.userId, { name: target.name, count: 1 });
  } else if (entry) {
    entry.count -= 1;
    if (entry.count <= 0) perConvo.delete(target.userId);
  }
  const agents = [...perConvo.entries()].map(([id, e]) => ({ id, name: e.name }));
  try {
    emit(audience, 'ai-typing', { conversationId, typing: agents.length > 0, agents });
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

function waitForReply({ sessionId, timeoutMs, quietMs, events = openEvents, recorder = null, onImage = null }) {
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
            recorder?.addText(text);                       // 中间文字进过程记录（D15）
            armQuiet();
          }
          if (recorder) {
            for (const call of extractToolCalls(event.message?.content)) recorder.addTool(call);
          }
          if (onImage) {
            // Agent 交付了图片（display_image）：先记下来，收工后统一下载并贴进聊天（D16）。
            for (const image of extractGeneratedImages(event.message?.content)) onImage(image);
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
 * （入库 + SSE 广播 + 推送），第三个参数是要引用的消息 id，返回无所谓。
 */
export function runAgentTurns({ convo, sender, body, messageId, roster, audience, targets, postReply }, deps = {}) {
  const {
    emit = emitTo,
    ensure = ensureSession,
    send = sendSessionMessage,
    wait = waitForReply,
    collectBacklog = collectGroupBacklog,
    formatBacklog = formatGroupBacklog,
    pushFiles = pushAttachmentsToSession,
    deliverImages = deliverGeneratedImages,
    timeoutMs = turnTimeoutMs(),
    quietMs = QUIET_MS(),
  } = deps;

  // 群里多人可能同时在说话，Agent 的回帖一律引用触发它的那条消息，回的是谁那句
  // 一眼可辨；私聊一对一本来就清楚，引用反而累赘。失败文案（暂不可用/超时/排队）
  // 同样要引用——恰恰是没办成事的时候，更得指明「没办成的是哪条」。
  const replyTo = convo.type === 'group' ? messageId : null;

  for (const target of targets) {
    let recorder = null;                                   // 回合的过程记录器（D15），会话就绪后开
    const say = (text) => {
      try {
        // turnId 一起递过去：贴回复时把过程步子挂上（失败文案也挂——出事更要能看过程）
        postReply(target, text, replyTo, recorder?.turnId);
      } catch (err) {
        logError('hapi.turn.post_failed', err);
      }
    };

    const job = async () => {
      setTyping(audience, convo.id, target, true, emit);
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
        // 私聊原样转发（§C.3'）：每条都实时送达，上下文在 hapi 会话里自然延续。
        // 群聊走「补课批次」（D14）：没 @ 它的消息平时不转发，这次把水位之后的
        // 一并带上，每条带 [时间] 署名，最后一条就是 @ 它的这条。人设在工作目录的
        // CLAUDE.md / AGENTS.md 里，会话内容里依旧零注入。
        // 附件摆渡（D16）：正文里引用的站内附件先传进会话、链接换成 runner 上的
        // 路径说明——传不了的留占位注明原因，绝不递一个 Agent 打不开的内链。
        let text = body;
        let backlog = null;
        let attachments = [];
        if (convo.type === 'group') {
          backlog = collectBacklog({
            agentKey: target.key, agentUserId: target.userId,
            conversationId: convo.id, triggerMessageId: messageId,
          });
          if (backlog) {
            const ferry = await pushFiles(ensured.sessionId, backlog.rows.map((r) => r.body));
            attachments = ferry.attachments;
            text = formatBacklog(backlog.rows, { annotate: (b) => annotateAttachments(b, ferry.noteFor) });
          } else {
            // 兜底：触发消息查不到（理论上不会）就退回老式单条署名，别让回合黄掉。
            text = `${sender.name}：${body}`;
          }
        } else {
          const ferry = await pushFiles(ensured.sessionId, [body]);
          attachments = ferry.attachments;
          text = annotateAttachments(body, ferry.noteFor);
        }

        // 先挂事件流、**等它真正连上**再发消息——回合再快也不会漏事件。
        recorder = beginTurn({
          conversationId: convo.id, agent: target,
          triggerMessageId: messageId ?? null, audience, emit,
        });
        const images = [];                                   // 回合里交付的图片（D16），收工后统一贴
        const waiter = wait({
          sessionId: ensured.sessionId, timeoutMs, quietMs, recorder,
          onImage: (image) => images.push(image),
        });
        await waiter.ready;
        try {
          try {
            await send(ensured.sessionId, text, { attachments });
          } catch (err) {
            // 竞态兜底：active 轮询和真正可收消息之间仍可能差一口气，409 就再等一轮重发一次。
            if (err.status !== 409) throw err;
            logWarn('hapi.turn.send_409_retry', { agent: target.key });
            await waitActive(ensured.sessionId, { timeoutMs: 30_000 });
            await send(ensured.sessionId, text, { attachments });
          }
        } catch (err) {
          logWarn('hapi.turn.send_failed', { agent: target.key, detail: String(err.message || err) });
          say(AGENT_UNAVAILABLE(target.name));
          return;
        }
        // 发送成功才推水位（D14）：失败/不可用时不推，这批消息下次被 @ 时重新补。
        if (backlog) advanceWatermark(target.key, convo.id, backlog.lastRowid);
        const outcome = await waiter.promise;
        logEvent('hapi.turn.finished', {
          agent: target.key, conversationId: convo.id, outcome: outcome.kind,
          hasText: !!outcome.text, images: images.length,
        });
        if (outcome.kind === 'timeout' && !outcome.text) say(AGENT_TIMEOUT(target.name));
        else if (outcome.kind === 'ended' && !outcome.text) say(AGENT_UNAVAILABLE(target.name));
        else if (!outcome.text) say(AGENT_NO_TEXT(target.name));
        else say(outcome.text);
        if (images.length) {
          // 交付的图片跟在文字后面贴（媒体随文字的拆条约定）。超时了也照贴——
          // 图是真实产物，来都来了不能扔。
          await deliverImages({ sessionId: ensured.sessionId, images, target, postReply });
        }
      } finally {
        setTyping(audience, convo.id, target, false, emit);
      }
    };

    if (enqueue(`${target.key}:${convo.id}`, job)) continue;
    try {
      postReply(target, AGENT_BUSY(target.name), replyTo);  // 队列满：立刻回话，不静默丢
    } catch (err) {
      logError('hapi.turn.post_failed', err);
    }
  }
}
