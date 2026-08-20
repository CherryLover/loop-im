import type { Message, ReplyTarget } from './types';

/** 引用摘要的长度，与服务端 conversations.js 的 QUOTE_PREVIEW_LIMIT 保持一致。 */
export const QUOTE_PREVIEW_LIMIT = 48;

/**
 * 从一条消息造出「正在回复它」需要的那点信息：发送者 + 正文摘要。
 * 口径照抄服务端（图片折成 [图片]、去掉 Markdown 记号、压空白、截断），
 * 这样输入框上方看到的和消息发出去之后气泡里看到的是同一行字。
 */
export function replyTargetOf(message: Message): ReplyTarget {
  const preview = message.body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/[#*`\-\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, QUOTE_PREVIEW_LIMIT);
  return { id: message.id, senderName: message.senderName, preview };
}

/**
 * Adds a confirmed message to a thread: drops the optimistic copy it replaces,
 * ignores duplicates (the sender gets it over both HTTP and SSE) and keeps the
 * thread in send order, with anything still in flight at the bottom.
 */
export function mergeMessage(list: Message[], message: Message): Message[] {
  if (list.some((m) => m.id === message.id)) return list;
  const withoutOptimistic = list.filter((m) => !(m.pending && m.senderId === message.senderId && m.body === message.body));
  return [...withoutOptimistic, message].sort((a, b) => {
    if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
    return a.createdAt - b.createdAt;
  });
}
