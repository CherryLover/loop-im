// Agent 回合的「执行过程」记录（方案 D15）：中间说明文字和工具动作按步落库，
// 挂到最终回复那条消息上——随时翻聊天都能看到它当时是怎么干的；进行中的步子
// 实时推给前端（ai-progress 事件），显示在「正在输入」指示行下面。
//
// 记什么、不记什么（2026-09-01 与用户对齐）：
// - 中间文字：存全文（Agent 说给人听的话，最有信息量）；
// - 工具动作：存一句人话标签（优先工具自带的描述，其次命令/路径），不存执行结果；
// - 模型的推理独白（reasoning）、token 计数：不存——量大、噪音多。
// 同一次工具调用 hub 会推多条状态更新（pending → in_progress → …），按 callId 只记第一条。
// 最终回复本身也会以 message 事件先到一步——落库后在挂接时把「和回复原文一样的
// 最后一步」删掉，过程里不重复正文。
//
// 失败回合（暂不可用/超时）同样挂过程：出事时点开一看就知道卡在哪一步。
import { all, get, run, now, uid } from '../db.js';
import { logWarn } from '../log.js';

const MAX_STEPS = () => Number(process.env.HAPI_STEPS_MAX || 200);
const LABEL_LIMIT = 200;

/** 工具调用 → 一句人话。优先它自带的描述；命令太长掐尾。 */
export function toolLabel(call) {
  const input = call.input || {};
  if (typeof input.description === 'string' && input.description.trim()) {
    return input.description.trim().slice(0, LABEL_LIMIT);
  }
  let cmd = typeof input.command === 'string' ? input.command : '';
  if (cmd) {
    // codex 系喜欢包一层 /bin/zsh -lc "…"，对人没有信息量，剥掉
    cmd = cmd.replace(/^\/bin\/\w*sh\s+-lc\s+/, '').replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
    return `执行命令：${cmd}`.slice(0, LABEL_LIMIT);
  }
  if (typeof input.path === 'string' && input.path) {
    return `${call.name || '读写文件'}：${input.path}`.slice(0, LABEL_LIMIT);
  }
  const name = typeof call.name === 'string' && call.name ? call.name : '工具调用';
  return name.slice(0, LABEL_LIMIT);
}

/**
 * 开一个回合的过程记录器。落库与实时推送同源：每步 INSERT 的同时 emit 一条
 * ai-progress（audience 与消息广播一致）。步数封顶 HAPI_STEPS_MAX（默认 200），
 * 到顶再补一条省略说明，之后的不再记——防个别回合刷出几千步。
 */
export function beginTurn({ conversationId, agent, triggerMessageId, audience, emit }) {
  const turnId = uid('t');
  let seq = 0;
  let lastText = null;
  let capped = false;
  const seenCalls = new Set();

  const record = (kind, content) => {
    if (capped) return;
    seq += 1;
    if (seq > MAX_STEPS()) {
      capped = true;
      content = '（过程步骤太多，之后的不再记录）';
      kind = 'text';
    }
    const createdAt = now();
    run(
      `INSERT INTO hapi_turn_steps (turn_id, conversation_id, agent_user_id, trigger_message_id, seq, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      turnId, conversationId, agent.userId, triggerMessageId ?? null, seq, kind, content, createdAt,
    );
    try {
      emit(audience, 'ai-progress', {
        conversationId,
        agent: { id: agent.userId, name: agent.name },
        step: { seq, kind, content, createdAt },
      });
    } catch (err) {
      logWarn('hapi.steps.emit_failed', { detail: String(err) });
    }
  };

  return {
    turnId,
    addText(text) {
      if (!text || text === lastText) return;             // 同一段话的重复推送只记一次
      lastText = text;
      record('text', text);
    },
    addTool(call) {
      // hapi 的内部杂务（给会话改标题）不算「干活」，记出来只有噪音（本地实测见到）。
      if (/change_title/.test(call.name || '')) return;
      const key = call.callId || call.id;
      if (key) {
        if (seenCalls.has(key)) return;                   // 一次调用多条状态更新，只记第一条
        seenCalls.add(key);
      }
      record('tool', toolLabel(call));
    },
  };
}

/**
 * 回合收尾：把这轮的步子挂到回复消息上。replyText 用来剔重——最终回复的原文
 * 若已被当成「最后一步文字」记了，删掉它，过程里不复读正文。
 * 必须在序列化/广播回复**之前**调：progressCount 要一次就对。
 */
export function attachStepsToReply(turnId, replyMessageId, replyText) {
  if (!turnId || !replyMessageId) return;
  const last = get(
    `SELECT rowid AS rid, kind, content FROM hapi_turn_steps
     WHERE turn_id = ? ORDER BY seq DESC LIMIT 1`, turnId,
  );
  if (last && last.kind === 'text' && last.content === replyText) {
    run('DELETE FROM hapi_turn_steps WHERE rowid = ?', last.rid);
  }
  run('UPDATE hapi_turn_steps SET reply_message_id = ? WHERE turn_id = ?', replyMessageId, turnId);
}

export const stepsOfMessage = (messageId) => all(
  `SELECT seq, kind, content, created_at AS createdAt FROM hapi_turn_steps
   WHERE reply_message_id = ? ORDER BY seq`, messageId,
);

export const stepCountOf = (messageId) =>
  get('SELECT COUNT(*) AS n FROM hapi_turn_steps WHERE reply_message_id = ?', messageId).n;
