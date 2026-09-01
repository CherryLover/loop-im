// 群聊补课（docs/hapi-Agent-接入方案.md D14）：群里没 @ Agent 的消息不会实时转发，
// 它对这些消息是「彻底没见过」，不是「晚点会看到」——真实使用中 Agent 因此答非所问
//（2026-09-01 用户实测：连发两条没 @ 的，再 @ 问「看到了吗」，Agent 只能装懂）。
//
// 修法：每个「Agent × 群」记一个水位（messages.rowid），被 @ 时把水位之后、触发消息
// 为止的所有消息按顺序打包成一段文本发过去，每条带时间和署名；发送成功后推水位。
// 这和「原样转发/零注入」（D13）不冲突：D13 砍的是重复拼 Agent 已知的历史，
// 这里补的是它**从没收到过**的消息——会话里没有的东西，不补就永远没有。
//
// 规则：
// - 只算它进群之后的消息（joined_at 起）；首次被 @ 最多回补 HAPI_BACKLOG_CAP 条（默认 50）。
// - 它自己发过的不重发（它记得）；**其他 AI** 的要带上，否则同群的 Agent 互相隐身。
//   带上只是让它看见，AI 永不触发 AI（D5）不变。
// - 系统提示（谁进群退群）不算消息，不带。
// - 时间格式 [HH:MM]（时区 HAPI_TZ，默认北京时间）；批次跨天时插一行「—— M月D日 ——」，
//   第一条不是今天的也先标一行日期。
// - 附件走占位：站内图变 [图片]、站内文件变 [文件：名字]——Agent 反正取不到 URL。
// - 私聊不走这里：私聊每条都实时转发，没有这个洞。
import { all, get, run, now } from '../db.js';

const CAP = () => Number(process.env.HAPI_BACKLOG_CAP || 50);
const TZ = () => process.env.HAPI_TZ || 'Asia/Shanghai';

const timeOf = (ms) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ(), hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(ms));

function dayOf(ms) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ(), month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(ms));
  const p = (t) => parts.find((x) => x.type === t)?.value;
  return `${p('month')}月${p('day')}日`;
}

/** 站内附件降级成占位文字：图片和文件的 Markdown 都指向 /uploads/<key>。 */
export function stripAttachments(body) {
  return String(body)
    .replace(/!\[[^\]]*\]\(\/uploads\/[^)]+\)/g, '[图片]')
    .replace(/\[([^\]]*)\]\(\/uploads\/[^)]+\)/g, (_, name) => `[文件：${name || '未命名'}]`);
}

/**
 * 组一段「从上次看到 → 这次触发」的群消息批次文本。
 * 返回 { text, lastRowid, count }；lastRowid 交给 advanceWatermark 在**发送成功后**推进
 * ——发送失败不推，消息下次还会再补，宁可重见一次也不能永久丢。
 */
export function buildGroupBacklog({ agentKey, agentUserId, conversationId, triggerMessageId }) {
  if (!triggerMessageId) return null;                       // 没有触发消息 id（直调注入的测试路径）→ 走调用方兜底
  const trigger = get('SELECT rowid AS rid, * FROM messages WHERE id = ?', triggerMessageId);
  if (!trigger) return null;
  const watermark = get(
    'SELECT last_seen_rowid FROM hapi_sessions WHERE agent_key = ? AND conversation_id = ?',
    agentKey, conversationId,
  )?.last_seen_rowid ?? null;
  const joinedAt = get(
    'SELECT joined_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    conversationId, agentUserId,
  )?.joined_at ?? 0;

  let rows = all(
    `SELECT m.rowid AS rid, m.body, m.created_at, u.name AS sender_name
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? AND m.rowid <= ? AND m.rowid > ?
       AND m.kind = 'user' AND m.sender_id != ? AND m.created_at >= ?
     ORDER BY m.rowid`,
    conversationId, trigger.rid, watermark ?? -1, agentUserId, joinedAt,
  );
  const cap = CAP();
  if (rows.length > cap) rows = rows.slice(-cap);           // 首次进老群：只补最近的，别灌历史

  const lines = [];
  let prevDay = dayOf(now());                               // 今天的消息不用标日期
  for (const row of rows) {
    const day = dayOf(row.created_at);
    if (day !== prevDay) {
      lines.push(`—— ${day} ——`);
      prevDay = day;
    }
    lines.push(`[${timeOf(row.created_at)}] ${row.sender_name}：${stripAttachments(row.body)}`);
  }
  return { text: lines.join('\n'), lastRowid: trigger.rid, count: rows.length };
}

/** 发送成功后推水位。只往前不往后：并发/重试时旧批次不能把新水位拽回去。 */
export function advanceWatermark(agentKey, conversationId, rowid) {
  run(
    `UPDATE hapi_sessions SET last_seen_rowid = MAX(COALESCE(last_seen_rowid, -1), ?), updated_at = ?
     WHERE agent_key = ? AND conversation_id = ?`,
    rowid, now(), agentKey, conversationId,
  );
}
