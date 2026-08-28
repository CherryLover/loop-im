// 消息内容搜索。会话列表顶上的搜索框原来只过滤会话标题，搜不到聊天记录。
//
// 正文是明文落库的：secret-box 只加密个别凭据字段，messages.body 从来没进过
// encrypt()（见 routes/conversations.js 的 INSERT 与 ai.js 的 insertAiMessage），
// 所以直接用 SQL 的 LIKE 就能搜，不需要在应用层解密后过滤。
import { Router } from 'express';
import { all, get } from '../db.js';
import { authenticate } from '../auth.js';
import { serializeMessage } from './conversations.js';
import { escapeLike } from '../sql.js';
import { reactionsOf } from '../reactions.js';
import { graphemeLength } from '../text.js';

export const router = Router();
router.use(authenticate);

// 搜索结果比消息气泡短，一页给少一点；上限防止有人用 limit 把整库拉走。
export const SEARCH_PAGE_SIZE = 30;
export const MAX_SEARCH_PAGE_SIZE = 100;
// 关键词长度上限。再长也不会是真的检索意图，只会让 LIKE 全表扫得更慢。
// 按字素簇数算，不按 .length —— 报错文案说的是「100 个字符」，而 .length 数的是
// UTF-16 码元：一个 emoji 算 2 个、一家三口 👨‍👩‍👧 算 8 个，纯 emoji 关键词会在
// 远不到 100「个字」的时候就被拒，与文案对不上。上限本身仍然是常数级，
// 最坏情况也就几百个码元，对 LIKE 的扫描成本没有影响。
export const MAX_QUERY_LENGTH = 100;

/** 拼「包含关键词」的 LIKE 模式。转义规则见 sql.js —— 查询侧必须配 ESCAPE '\\'。 */
export const likeContains = (input) => `%${escapeLike(input)}%`;

/** ?q=a&q=b 之类的重复参数会解析成数组，一律当没传，不要 String() 出个 "a,b" 来搜。 */
const oneString = (value) => (typeof value === 'string' ? value : '');

/**
 * 结果要带上会话标题，前端才能直接渲染。群聊用群名，一对一/AI 会话用对方的名字
 * （与 conversations.js 的 serializeConversation 一致：标题是相对观察者的）。
 */
function titleResolver(viewerId) {
  const cache = new Map();
  return (row) => {
    if (row.convo_type === 'group') return row.convo_title || '群聊';
    if (cache.has(row.conversation_id)) return cache.get(row.conversation_id);
    const peer = get(
      `SELECT u.name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ? AND cm.user_id != ? ORDER BY cm.joined_at, u.rowid LIMIT 1`,
      row.conversation_id, viewerId,
    );
    const title = peer?.name || '会话';
    cache.set(row.conversation_id, title);
    return title;
  };
}

/**
 * GET /api/messages/search?q=&conversationId=&limit=&before=
 *
 * 硬性边界：只搜当前用户仍是成员的会话。这一点靠 SQL 里那个
 * `JOIN conversation_members ... AND cm.user_id = ?` 保证——不是先查后过滤，
 * 而是压根不让不属于自己的行进入结果集，游标那一步同理。
 *
 * 结果按时间倒序（最新的在前），游标写法与 /conversations/:id/messages 一致：
 * before 传一条消息 id，取比它更早的；同一毫秒内多条用 rowid 兜底定序。
 */
router.get('/search', (req, res) => {
  const q = oneString(req.query.q).trim();
  if (!q) return res.status(400).json({ error: '请输入搜索关键词' });
  if (graphemeLength(q) > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: `搜索关键词不能超过 ${MAX_QUERY_LENGTH} 个字符` });
  }

  // 限定某个会话时先验成员身份，理由和 requireMembership 一样：不是成员就当会话不存在，
  // 不用 403 泄露「这个会话确实存在」。
  const conversationId = oneString(req.query.conversationId).trim();
  if (conversationId) {
    const mine = get(
      'SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      conversationId, req.user.id,
    );
    if (!mine) return res.status(404).json({ error: '会话不存在' });
  }

  const asked = Number(req.query.limit);
  const limit = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : SEARCH_PAGE_SIZE, 1), MAX_SEARCH_PAGE_SIZE);

  const before = oneString(req.query.before).trim();
  const anchor = before
    ? get(
      `SELECT m.created_at, m.rowid FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
       WHERE m.id = ?${conversationId ? ' AND m.conversation_id = ?' : ''}`,
      ...[req.user.id, before, ...(conversationId ? [conversationId] : [])],
    )
    : null;
  if (before && !anchor) return res.status(400).json({ error: '游标无效' });

  const params = [req.user.id, likeContains(q)];
  let extra = '';
  if (conversationId) {
    extra += ' AND m.conversation_id = ?';
    params.push(conversationId);
  }
  if (anchor) {
    extra += ' AND (m.created_at < ? OR (m.created_at = ? AND m.rowid < ?))';
    params.push(anchor.created_at, anchor.created_at, anchor.rowid);
  }
  params.push(limit + 1);   // 多取一条，用来判断还有没有更早的，省掉一次 count

  // kind = 'user'：系统提示（谁加入/退出群、群名改了）是界面生成的说明文字，
  // 不是聊天内容；把它们算进来，搜一个人名就会被入群通知刷屏。
  const rows = all(
    `SELECT m.*, u.name AS sender_name, u.avatar_url, c.type AS convo_type, c.title AS convo_title
     FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
     JOIN conversations c ON c.id = m.conversation_id
     JOIN users u ON u.id = m.sender_id
     WHERE m.kind = 'user' AND m.body LIKE ? ESCAPE '\\'${extra}
     ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    ...params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const titleOf = titleResolver(req.user.id);
  // 表情回应也是整页一次查完，理由同 /conversations/:id/messages：逐条查就是一页 N 次往返。
  const reactions = reactionsOf(page.map((r) => r.id), req.user.id);
  res.json({
    query: q,
    results: page.map((r) => ({
      ...serializeMessage(r, { name: r.sender_name, avatar_url: r.avatar_url }, reactions.get(r.id) || []),
      conversationTitle: titleOf(r),
      conversationType: r.convo_type,
    })),
    hasMore,
    // 倒序排列，本页最早的那条是最后一个，下一页从它往前翻。
    nextBefore: hasMore && page.length ? page[page.length - 1].id : null,
  });
});
