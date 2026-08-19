import { Router } from 'express';
import { all, get, run, now, uid } from '../db.js';
import { authenticate, publicUser, requireAdmin } from '../auth.js';
import { emitTo } from '../events.js';
import { AI_ID, generateReply, insertAiMessage, learnAbout, parseMentions, settings, shouldReply } from '../ai.js';

export const router = Router();
router.use(authenticate);

const memberIds = (conversationId) =>
  all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conversationId).map((r) => r.user_id);

const memberRows = (conversationId) =>
  all(
    `SELECT u.*, cm.joined_at FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ? ORDER BY cm.joined_at, u.rowid`,
    conversationId,
  );

function requireMembership(req, res, id) {
  const convo = get('SELECT * FROM conversations WHERE id = ?', id);
  if (!convo || !memberIds(id).includes(req.user.id)) {
    res.status(404).json({ error: '会话不存在' });
    return null;
  }
  return convo;
}

const previewOf = (body) =>
  body.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/[#*`\-\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 26);

export function serializeMessage(row, sender) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: sender?.name || row.sender_id,
    senderAvatarUrl: sender?.avatar_url || null,
    body: row.body,
    mentions: JSON.parse(row.mentions || '[]'),
    createdAt: row.created_at,
    isAI: row.sender_id === AI_ID,
  };
}

function serializeConversation(convo, viewerId) {
  // Creator first, AI last — the reading order the design shows in the member pane.
  const members = memberRows(convo.id).sort((a, b) => {
    const rank = (u) => (u.id === convo.created_by ? 0 : u.role === 'ai' ? 2 : 1);
    return rank(a) - rank(b) || a.joined_at - b.joined_at;
  });
  const peer = convo.type !== 'group' ? members.find((m) => m.id !== viewerId) : null;
  const last = get(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    convo.id,
  );
  return {
    id: convo.id,
    type: convo.type,
    title: convo.type === 'group' ? convo.title : peer?.name || '会话',
    peerId: peer?.id || null,
    members: members.map((m) => ({ ...publicUser(m), roleInGroup: m.id === convo.created_by ? '管理员' : m.role === 'ai' ? '常驻' : m.dept })),
    lastMessage: last
      ? { preview: `${last.sender_id === viewerId ? '我：' : ''}${previewOf(last.body)}`, createdAt: last.created_at }
      : null,
  };
}

router.get('/', (req, res) => {
  const rows = all(
    `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE cm.user_id = ?`,
    req.user.id,
  ).map((c) => serializeConversation(c, req.user.id));
  rows.sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
  res.json({ conversations: rows });
});

router.get('/:id', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  res.json({ conversation: serializeConversation(convo, req.user.id) });
});

// 管理员把 2–3 人拉到一起建群，AI 助手默认加入。
router.post('/group', requireAdmin, (req, res) => {
  const title = String(req.body?.title || '').trim() || '新群聊';
  const picked = [...new Set((req.body?.memberIds || []).filter((id) => id !== req.user.id && id !== AI_ID))];
  if (picked.length < 2 || picked.length > 3) return res.status(400).json({ error: '请选择 2–3 名成员' });
  const known = all(`SELECT id FROM users WHERE id IN (${picked.map(() => '?').join(',')})`, ...picked).map((r) => r.id);
  if (known.length !== picked.length) return res.status(400).json({ error: '成员不存在' });

  const id = uid('c');
  const ts = now();
  run('INSERT INTO conversations (id, type, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    id, 'group', title, req.user.id, ts);
  for (const m of [req.user.id, ...picked, AI_ID]) {
    run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', id, m, ts);
  }
  const convo = get('SELECT * FROM conversations WHERE id = ?', id);
  const hello = insertAiMessage(id, '群聊已创建，我已加入并开始记录上下文。需要我做什么时 **@Aria**。');
  const serialized = serializeConversation(convo, req.user.id);
  emitTo([req.user.id, ...picked], 'conversation-created', { conversationId: id });
  emitTo([req.user.id, ...picked], 'message', { message: serializeMessage(hello, { name: 'Aria' }) });
  res.status(201).json({ conversation: serialized });
});

// 联系人页「去聊天」：拿到或新建一对一会话（对 Aria 则是 AI 私聊）。
router.post('/direct', (req, res) => {
  const peerId = String(req.body?.userId || '');
  const peer = get('SELECT * FROM users WHERE id = ?', peerId);
  if (!peer || peer.id === req.user.id) return res.status(400).json({ error: '联系人不存在' });
  if (peer.role === 'ai' && !settings().allow_dm) return res.status(403).json({ error: '管理员已关闭与 AI 的私聊' });

  const type = peer.role === 'ai' ? 'ai' : 'dm';
  const existing = get(
    `SELECT c.id FROM conversations c
     JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
     JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
     WHERE c.type = ? LIMIT 1`,
    req.user.id, peer.id, type,
  );
  if (existing) {
    return res.json({ conversation: serializeConversation(get('SELECT * FROM conversations WHERE id = ?', existing.id), req.user.id) });
  }
  const id = uid('c');
  const ts = now();
  run('INSERT INTO conversations (id, type, title, created_by, created_at) VALUES (?, ?, NULL, ?, ?)', id, type, req.user.id, ts);
  run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', id, req.user.id, ts);
  run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', id, peer.id, ts);
  emitTo([req.user.id, peer.id], 'conversation-created', { conversationId: id });
  res.status(201).json({ conversation: serializeConversation(get('SELECT * FROM conversations WHERE id = ?', id), req.user.id) });
});

// 成员可见的一行摘要：AI 目前从这个群里掌握到什么。
router.get('/:id/ai-context', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  const ids = memberIds(convo.id).filter((id) => id !== AI_ID);
  const keys = ids.length
    ? all(
      `SELECT keys FROM ai_profiles WHERE user_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC`,
      ...ids,
    ).flatMap((r) => JSON.parse(r.keys || '[]'))
    : [];
  const top = [...new Set(keys)].slice(0, 2);
  res.json({ line: [...top, `相关成员 ${ids.length} 人`].join(' · ') });
});

router.get('/:id/messages', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  const rows = all(
    `SELECT m.*, u.name AS sender_name, u.avatar_url FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? ORDER BY m.created_at, m.rowid`,
    convo.id,
  );
  res.json({
    messages: rows.map((r) => serializeMessage(r, { name: r.sender_name, avatar_url: r.avatar_url })),
  });
});

router.post('/:id/messages', async (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: '消息不能为空' });

  const roster = memberRows(convo.id);
  const mentions = parseMentions(body, roster);
  const id = uid('m');
  run('INSERT INTO messages (id, conversation_id, sender_id, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, convo.id, req.user.id, body, JSON.stringify(mentions), now());
  const message = serializeMessage(get('SELECT * FROM messages WHERE id = ?', id), req.user);
  const audience = roster.map((m) => m.id);
  emitTo(audience, 'message', { message });
  res.status(201).json({ message });

  // Aria: 被 @ 时必回；未被 @ 时静默读取上下文并持续学习这个人的沟通习惯。
  const s = settings();
  const aiInRoom = audience.includes(AI_ID);
  learnAbout(req.user.id, convo).catch(() => {});
  if (!aiInRoom) return;
  if (!shouldReply(convo, mentions, s)) return;

  emitTo(audience, 'ai-typing', { conversationId: convo.id, typing: true });
  try {
    const { body: reply } = await generateReply(convo, req.user.id);
    const row = insertAiMessage(convo.id, reply);
    emitTo(audience, 'message', { message: serializeMessage(row, { name: 'Aria' }) });
  } finally {
    emitTo(audience, 'ai-typing', { conversationId: convo.id, typing: false });
  }
});
