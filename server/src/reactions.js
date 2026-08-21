// 消息表情回应：给一条消息点个 👍，省掉一屏「收到」「好的」。
//
// 三件事在这里定死，路由只管权限和广播：
// 1. 允许的表情是一份白名单。客户端传什么就存什么的话，「表情」里可以塞进一整段
//    文本甚至 HTML，聚合结果一路带到界面上；所以入口只认下面这几个，别的一律拒绝。
// 2. 唯一性在库里（db.js 的 idx_message_reactions_unique），不靠「先查再插」——
//    并发两次点击照样能挤过应用层的判断，挤不过唯一索引。
// 3. 聚合按批取：一页最多 200 条消息，一条一次查询就是 200 次往返，这里一次 IN 查完。
import { all, now, run } from './db.js';

/**
 * 允许的表情。故意只给一小组常用的：不引表情选择器依赖，前端也照这个顺序排。
 * 前端的同一份列表在 web/src/lib/reactions.ts，两边要一起改。
 */
export const REACTION_EMOJIS = ['👍', '❤️', '😄', '🎉', '😮', '🙏'];

/**
 * 归一：同一个表情的不同写法要落到同一个 key 上，否则库里分成两行、界面上排成两个计数。
 *
 * 要抹掉的有两类，都是**纯表现、无语义**的东西：
 *
 * 1. 变体选择符 U+FE0F / U+FE0E。❤ 和 ❤️ 肉眼一样，字节不一样；不同客户端和输入法
 *    加不加全看心情。FE0E（要求按文字渲染）是同一类，一起抹掉。
 * 2. **悬空的零宽连接符 U+200D**。ZWJ 只有夹在两个字符中间才有意义；出现在开头、
 *    结尾，或者连着好几个，都是无意义的残留 —— 而按码元/码点截断出来的碎片正好长
 *    这样（'👨‍👩‍👧' 切到一半就是 '👨‍'）。不归一的话，同一个 👍 只因为尾巴上多个 ZWJ 就被拒。
 *
 * **中间的 ZWJ 必须留着**：它是有语义的。👨‍👩‍👧（一家三口，两个 ZWJ 连起来）和
 * 👨👩👧（三个各自独立的人）是两个不同的东西，无脑把 ZWJ 全删掉会把它们合并成一行。
 * 所以这里只折叠悬空的那些，不碰夹在中间的。
 *
 * 白名单 key 也走同一个函数生成，将来往 REACTION_EMOJIS 里加 ZWJ 表情（比如 👩‍❤️‍👨）
 * 不用改这里 —— 它内部的 FE0F 会被抹掉，两侧的 ZWJ 会原样保留，正好对得上。
 */
const PRESENTATION_SELECTOR = /[\uFE0E\uFE0F]/g;
export function canonicalEmojiKey(raw) {
  return String(raw)
    .replace(PRESENTATION_SELECTOR, '')
    .replace(/\u200D{2,}/g, '\u200D')   // 连着好几个连接符，折成一个
    .replace(/^\u200D+/, '')            // 开头的连接符没有左操作数
    .replace(/\u200D+$/, '');           // 结尾的连接符没有右操作数（截断残留就长这样）
}

const CANONICAL = new Map(REACTION_EMOJIS.map((e) => [canonicalEmojiKey(e), e]));

/**
 * 长度上限，只用来在做任何字符串处理之前挡掉超大 payload，不承担白名单校验
 * ——真正说了算的是 CANONICAL。给得宽松一点：ZWJ 表情本来就长（👨‍👩‍👧‍👦 是 11 个
 * 码元），再算上可有可无的变体选择符，几十个码元都属于正常范围。
 */
const MAX_EMOJI_LENGTH = 64;

/**
 * 把客户端传来的值收敛成白名单里的写法；不在白名单里就返回 null，调用方据此拒绝。
 * 非字符串（数组、对象、数字）同样返回 null——不做 String() 转换，免得 ['👍'] 混进来。
 */
export function normalizeEmoji(input) {
  if (typeof input !== 'string' || input.length > MAX_EMOJI_LENGTH) return null;
  return CANONICAL.get(canonicalEmojiKey(input)) ?? null;
}

/**
 * 一次取回若干条消息的全部回应行（按最早点的排在前，界面上顺序才稳定）。
 * 这就是避开 N+1 的那一步：调用方拿一整页的 id 进来，只发一条 SQL。
 */
export function reactionRows(messageIds) {
  const ids = [...new Set(messageIds)];
  if (!ids.length) return [];
  return all(
    `SELECT r.message_id, r.emoji, r.user_id, u.name AS user_name
     FROM message_reactions r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.message_id IN (${ids.map(() => '?').join(',')})
     ORDER BY r.created_at, r.rowid`,
    ...ids,
  );
}

/**
 * 把行折成「消息 id → 每种表情一条」的聚合：有哪些人、多少个、我点没点。
 * mine 是相对观察者的，所以 viewerId 是入参——同一批行可以给不同的人各折一份，
 * 广播时不用为每个成员重查一次库。
 */
export function groupReactions(rows, viewerId) {
  const byMessage = new Map();
  for (const row of rows) {
    let list = byMessage.get(row.message_id);
    if (!list) {
      list = [];
      byMessage.set(row.message_id, list);
    }
    let entry = list.find((e) => e.emoji === row.emoji);
    if (!entry) {
      entry = { emoji: row.emoji, count: 0, users: [], mine: false };
      list.push(entry);
    }
    entry.count += 1;
    // 注销掉的账号（users 那行没了）不该让整条聚合塌掉，给个占位名即可。
    entry.users.push({ id: row.user_id, name: row.user_name || '已注销的成员' });
    if (row.user_id === viewerId) entry.mine = true;
  }
  return byMessage;
}

/** 批量聚合的常用组合：一页消息 id 进，Map<messageId, 聚合数组> 出。 */
export const reactionsOf = (messageIds, viewerId) => groupReactions(reactionRows(messageIds), viewerId);

/**
 * 点一个回应。重复点不是错误也不会多出一行——唯一索引在，INSERT OR IGNORE 直接跳过，
 * 返回 false 表示「本来就点过了」。
 */
export const addReaction = (messageId, userId, emoji) => run(
  'INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
  messageId, userId, emoji, now(),
).changes > 0;

/** 取消回应。没点过时删 0 行，同样不算错误。 */
export const removeReaction = (messageId, userId, emoji) => run(
  'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
  messageId, userId, emoji,
).changes > 0;
