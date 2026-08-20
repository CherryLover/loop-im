import { Router } from 'express';
import { all, get, run, now, uid } from '../db.js';
import { authenticate, publicUser, requireAdmin } from '../auth.js';
import { emitTo } from '../events.js';
import { AI_ID, generateReply, insertAiMessage, isVisibleToAi, learnAbout, parseMentions, settings, shouldReply } from '../ai.js';

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

// ---- 已读位置 ----------------------------------------------------------
// 未读计数和已读回执共用 conversation_reads：一个人在一个会话里读到哪一刻。

const lastReadAt = (conversationId, userId) =>
  get('SELECT last_read_at FROM conversation_reads WHERE conversation_id = ? AND user_id = ?',
    conversationId, userId)?.last_read_at || 0;

/** 未读 = 比我的已读位置更新、且不是我自己发的消息。 */
const unreadCount = (conversationId, userId) => get(
  'SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND sender_id != ? AND created_at > ?',
  conversationId, userId, lastReadAt(conversationId, userId),
).n;

/**
 * 会话里其他人的已读位置。一次性给出来，前端自己算每条消息被谁读过，
 * 避免为每条消息都查一次库。AI 不参与已读统计。
 */
const readsOf = (conversationId, viewerId) => all(
  `SELECT r.user_id, r.last_read_at FROM conversation_reads r
   JOIN users u ON u.id = r.user_id
   WHERE r.conversation_id = ? AND r.user_id != ? AND u.role != 'ai'`,
  conversationId, viewerId,
).map((r) => ({ userId: r.user_id, lastReadAt: r.last_read_at }));

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
    unread: unreadCount(convo.id, viewerId),
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

// 分页：默认只给最新的一页，再往前用 before 游标翻。原来是把整个会话的历史
// 一次性返回，消息一多就是几 MB 的响应加上前端一次渲染几千个气泡。
export const MESSAGE_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

router.get('/:id/messages', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;

  const asked = Number(req.query.limit);
  const limit = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : MESSAGE_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  // before 传的是一条消息的 id，取比它更早的那些。同一毫秒内的多条消息用 rowid
  // 兜底定序，否则翻页会漏掉或重复。
  const before = req.query.before ? String(req.query.before) : '';
  const anchor = before
    ? get('SELECT created_at, rowid FROM messages WHERE id = ? AND conversation_id = ?', before, convo.id)
    : null;
  if (before && !anchor) return res.status(400).json({ error: '游标无效' });

  // 多取一条用来判断还有没有更早的，不用再跑一次 count。
  const rows = anchor
    ? all(
      `SELECT m.*, u.name AS sender_name, u.avatar_url FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? AND (m.created_at < ? OR (m.created_at = ? AND m.rowid < ?))
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      convo.id, anchor.created_at, anchor.created_at, anchor.rowid, limit + 1,
    )
    : all(
      `SELECT m.*, u.name AS sender_name, u.avatar_url FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      convo.id, limit + 1,
    );

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse();   // 返回给前端仍是由早到晚
  res.json({
    messages: page.map((r) => serializeMessage(r, { name: r.sender_name, avatar_url: r.avatar_url })),
    hasMore,
    nextBefore: hasMore && page.length ? page[0].id : null,          // 下一页从本页最早那条往前翻
    reads: readsOf(convo.id, req.user.id),                          // 谁读到了哪一刻，前端据此标已读
  });
});

/**
 * 上报已读位置。upTo 省略时按此刻算；只允许前进，也不允许超过当前时间
 * （否则客户端传一个很大的值就能把以后收到的消息也预先标成已读）。
 */
router.post('/:id/read', (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;

  const ts = now();
  const asked = Number(req.body?.upTo);
  const upTo = Math.min(Number.isFinite(asked) && asked > 0 ? asked : ts, ts);
  const current = lastReadAt(convo.id, req.user.id);
  const next = Math.max(current, upTo);

  run(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_id)
     DO UPDATE SET last_read_at = excluded.last_read_at, updated_at = excluded.updated_at`,
    convo.id, req.user.id, next, ts,
  );
  // 位置没变就不用惊动别人，省掉一轮无意义的广播。
  if (next !== current) {
    emitTo(memberIds(convo.id), 'read', { conversationId: convo.id, userId: req.user.id, lastReadAt: next });
  }
  res.json({ conversationId: convo.id, lastReadAt: next, unread: unreadCount(convo.id, req.user.id) });
});

router.post('/:id/messages', async (req, res) => {
  const convo = requireMembership(req, res, req.params.id);
  if (!convo) return;
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: '消息不能为空' });

  const roster = memberRows(convo.id);
  const mentions = parseMentions(body, roster);
  const audience = roster.map((m) => m.id);
  // 可见性在写库时定档：之后管理员再改开关，也不会让 Aria 追溯读到这条消息。
  const s = settings();
  const aiInRoom = audience.includes(AI_ID);
  const aiVisible = isVisibleToAi(convo, mentions, aiInRoom, s);
  const id = uid('m');
  run('INSERT INTO messages (id, conversation_id, sender_id, body, mentions, ai_visible, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, convo.id, req.user.id, body, JSON.stringify(mentions), aiVisible ? 1 : 0, now());
  const message = serializeMessage(get('SELECT * FROM messages WHERE id = ?', id), req.user);
  emitTo(audience, 'message', { message });
  res.status(201).json({ message });

  // Aria: 被 @ 时必回；未被 @ 时按「群聊静默读取」决定是否读取上下文并学习沟通习惯。
  if (!aiVisible) return;
  learnAbout(req.user.id, convo).catch(() => {});
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
