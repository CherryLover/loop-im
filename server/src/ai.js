// Native AI member ("Aria"): silently reads group context, replies when @-ed, and keeps
// a per-person profile of communication habits it reuses on the next conversation.
import { all, get, run, now, uid } from './db.js';

export const AI_ID = 'ai';
export const AI_NAME = 'Aria';

export const PROVIDERS = [
  { key: 'gpt', name: 'OpenAI', note: '通用能力强，长上下文稳定', model: 'gpt-4o', label: 'GPT-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions' },
  { key: 'grok', name: 'xAI Grok', note: '响应快，适合群聊即时协作', model: 'grok-3', label: 'Grok',
    endpoint: 'https://api.x.ai/v1/chat/completions' },
  { key: 'codex', name: 'Codex（本地 Agent）', note: '本地通用 Agent，可执行任务型指令', model: 'codex-local', label: 'Codex',
    endpoint: process.env.CODEX_ENDPOINT || '' },
];

export const providerOf = (key) => PROVIDERS.find((p) => p.key === key) || PROVIDERS[0];

export function settings() {
  const row = get('SELECT * FROM ai_settings WHERE id = 1');
  if (row) return row;
  run(`INSERT INTO ai_settings (id, updated_at) VALUES (1, ?)`, now());
  return get('SELECT * FROM ai_settings WHERE id = 1');
}

export function saveSettings(patch) {
  const s = settings();
  const next = {
    provider: patch.provider ?? s.provider,
    api_key: patch.apiKey ?? s.api_key,
    silent_read: patch.silentRead ?? !!s.silent_read,
    reply_at_all: patch.replyAtAll ?? !!s.reply_at_all,
    allow_dm: patch.allowDm ?? !!s.allow_dm,
  };
  run(`UPDATE ai_settings SET provider = ?, api_key = ?, silent_read = ?, reply_at_all = ?, allow_dm = ?, updated_at = ?
       WHERE id = 1`,
    next.provider, next.api_key, next.silent_read ? 1 : 0, next.reply_at_all ? 1 : 0, next.allow_dm ? 1 : 0, now());
  return settings();
}

export const isConfigured = (s = settings()) => !!s.api_key || (s.provider === 'codex' && !!providerOf('codex').endpoint);

/** Resolve "@名字" / "@全员" in a message body against the conversation roster. */
export function parseMentions(body, roster) {
  const found = new Set();
  if (/@(全员|所有人|everyone|all)/i.test(body)) found.add('all');
  for (const u of roster) {
    const names = [u.name, u.name.replace(/\s+/g, '')];
    if (u.id === AI_ID) names.push(AI_NAME, 'aria');
    for (const n of names) {
      if (n && body.toLowerCase().includes(`@${n.toLowerCase()}`)) found.add(u.id);
    }
  }
  return [...found];
}

/** 被 @ 时必须回复；未被 @ 时静默读取。 */
export function shouldReply(conversation, mentions, s = settings()) {
  if (conversation.type === 'ai') return !!s.allow_dm;
  if (mentions.includes(AI_ID)) return true;
  if (mentions.includes('all')) return !!s.reply_at_all;
  return false;
}

/**
 * 这条消息发出时，AI 是否被允许读到它。写库时定档，之后改开关也不会追溯生效。
 * aiInRoom 为假（成员之间的私聊、没有 Aria 的会话）时一律不可见。
 */
export function isVisibleToAi(conversation, mentions, aiInRoom, s = settings()) {
  if (!aiInRoom) return false;
  if (conversation.type === 'ai') return !!s.allow_dm;   // AI 私聊本就是说给 Aria 听的
  if (shouldReply(conversation, mentions, s)) return true; // 要回复就必然要读
  return !!s.silent_read;                                 // 其余群消息看「群聊静默读取」
}

const stripMd = (t) => t.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/[*`>#]/g, '').replace(/\s+/g, ' ').trim();

function profileHint(userIds) {
  const rows = userIds.length
    ? all(`SELECT p.*, u.name FROM ai_profiles p JOIN users u ON u.id = p.user_id
           WHERE p.user_id IN (${userIds.map(() => '?').join(',')})`, ...userIds)
    : [];
  return rows.map((r) => {
    const habits = JSON.parse(r.habits || '[]');
    return `- ${r.name}：${r.note}${habits.length ? ` 习惯：${habits.join('；')}` : ''}`;
  }).join('\n');
}

function transcript(conversationId, limit = 30) {
  return all(
    `SELECT m.body, m.created_at, u.name, u.id AS sender_id FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? AND m.ai_visible = 1 ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    conversationId, limit,
  ).reverse();
}

async function callProvider(messages, s) {
  const p = providerOf(s.provider);
  if (!p.endpoint) throw new Error(`${p.name} 未配置调用地址`);
  const res = await fetch(p.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.api_key}` },
    body: JSON.stringify({ model: p.model, messages, temperature: 0.4 }),
  });
  if (!res.ok) throw new Error(`${p.name} 返回 ${res.status}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${p.name} 未返回内容`);
  return text.trim();
}

/** Offline fallback so the product works end-to-end without any API key. */
function stubReply(conversation, lines, askedBy) {
  const others = lines.filter((l) => l.sender_id !== AI_ID).slice(-3);
  const points = others.map((l) => `- ${l.name}：${stripMd(l.body).slice(0, 42)}`).join('\n');
  const hint = askedBy ? profileHint([askedBy]) : '';
  const tail = hint ? '\n\n（已按你以往的沟通偏好精简表达）' : '';
  if (conversation.type === 'ai') {
    return `收到。我按你说的口径整理，要点如下：\n${points || '- 暂无更多上下文'}${tail}`;
  }
  return `**已收到提及。** 我已读完本群上下文：\n${points || '- 暂无更多上下文'}\n\n建议：先约接口联调时间，再定发版日。${tail}`;
}

/** Produce Aria's reply for a conversation. Falls back to a local stub when unconfigured. */
export async function generateReply(conversation, askedBy) {
  const s = settings();
  const lines = transcript(conversation.id);
  if (!isConfigured(s)) return { body: stubReply(conversation, lines, askedBy), mode: 'stub' };

  const roster = all(
    `SELECT u.id FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?`,
    conversation.id,
  ).map((r) => r.id).filter((id) => id !== AI_ID);
  const hint = profileHint(roster);
  const system = [
    `你是 ${AI_NAME}，${conversation.type === 'group' ? '这个群聊' : '这个系统'}的原生 AI 成员。`,
    '用中文、简洁、工具化的语气回答，输出 Markdown，优先给结论再给依据。',
    hint ? `已知成员的沟通偏好，请据此调整表达：\n${hint}` : '',
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: system },
    ...lines.map((l) => ({
      role: l.sender_id === AI_ID ? 'assistant' : 'user',
      content: l.sender_id === AI_ID ? l.body : `${l.name}：${l.body}`,
    })),
  ];
  try {
    return { body: await callProvider(messages, s), mode: s.provider };
  } catch (err) {
    return { body: stubReply(conversation, lines, askedBy), mode: 'stub', error: err.message };
  }
}

export function insertAiMessage(conversationId, body) {
  const id = uid('m');
  run(`INSERT INTO messages (id, conversation_id, sender_id, body, mentions, created_at) VALUES (?, ?, ?, ?, '[]', ?)`,
    id, conversationId, AI_ID, body, now());
  return get(`SELECT * FROM messages WHERE id = ?`, id);
}

const KEY_HINT = /(接口|发版|排期|上线|评审|测试|阻塞|风险|需求|文案|版本|联调|加班)/;

/**
 * Update what the AI knows about a person from their own messages. With a provider
 * configured this asks the model for JSON; otherwise it keeps a heuristic digest.
 */
export async function learnAbout(userId, conversation) {
  if (userId === AI_ID) return;
  const mine = all(
    `SELECT body, created_at FROM messages WHERE conversation_id = ? AND sender_id = ? AND ai_visible = 1
     ORDER BY created_at DESC LIMIT 12`,
    conversation.id, userId,
  );
  if (!mine.length) return;

  const scene = conversation.type === 'ai' ? 'AI 私聊' : conversation.type === 'group' ? '群聊' : '一对一';
  const existing = get('SELECT * FROM ai_profiles WHERE user_id = ?', userId);
  let next = {
    scene,
    summary: stripMd(mine[0].body).slice(0, 60) || existing?.summary || '',
    note: existing?.note || '',
    habits: JSON.parse(existing?.habits || '[]'),
    keys: JSON.parse(existing?.keys || '[]'),
  };

  const s = settings();
  if (isConfigured(s)) {
    try {
      const raw = await callProvider([
        { role: 'system', content: '从对话片段中提炼这个人的沟通偏好与习惯。只输出 JSON：{"summary":"一句话","note":"偏好与习惯描述","habits":["…"],"keys":["关键信息点"]}' },
        { role: 'user', content: mine.map((m) => stripMd(m.body)).reverse().join('\n') },
      ], s);
      const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
      next = {
        scene,
        summary: parsed.summary || next.summary,
        note: parsed.note || next.note,
        habits: Array.isArray(parsed.habits) && parsed.habits.length ? parsed.habits.slice(0, 6) : next.habits,
        keys: Array.isArray(parsed.keys) && parsed.keys.length ? parsed.keys.slice(0, 8) : next.keys,
      };
    } catch {
      // fall through to the heuristic digest below
    }
  } else {
    const clauses = mine
      // @提及 是称呼不是内容，先去掉再切句，否则「@Aria 回归测试只留 1 天」整句都会被丢掉
      .flatMap((m) => stripMd(m.body).replace(/@\S+/g, ' ').split(/[。；;,，!？?：:]|\s-\s/))
      .map((c) => c.replace(/\[[^\]]*\]/g, '').replace(/^[-*\s]+/, '').replace(/[：:\s]+$/, '').trim())
      .filter((c) => !c.includes('@'))
      .filter((c) => !/^(我|我们|你|你们|他|她|大家)/.test(c))   // sentences, not information points
      .filter((c) => c.length >= 4 && c.length <= 16 && KEY_HINT.test(c));
    next.keys = [...new Set([...next.keys, ...clauses])].slice(0, 8);
  }

  run(
    `INSERT INTO ai_profiles (user_id, scene, summary, note, habits, keys, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET scene = excluded.scene, summary = excluded.summary,
       note = excluded.note, habits = excluded.habits, keys = excluded.keys, updated_at = excluded.updated_at`,
    userId, next.scene, next.summary, next.note, JSON.stringify(next.habits), JSON.stringify(next.keys), now(),
  );
}

export async function testConnectivity() {
  const s = settings();
  const p = providerOf(s.provider);
  if (!isConfigured(s)) return { ok: false, message: `${p.label} 未配置凭据，当前使用本地模拟回复` };
  const started = Date.now();
  try {
    await callProvider([{ role: 'user', content: 'ping' }], s);
    return { ok: true, message: `${p.label} 连通性正常 · 延迟 ${Date.now() - started}ms` };
  } catch (err) {
    return { ok: false, message: `${p.label} 连接失败 · ${err.message}` };
  }
}
