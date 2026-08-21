import { truncate } from './text';
import type { Message, ReplyTarget } from './types';

/** 引用摘要的长度，与服务端 conversations.js 的 QUOTE_PREVIEW_LIMIT 保持一致。 */
export const QUOTE_PREVIEW_LIMIT = 48;

/**
 * 摘要的清洗口径：图片折成 [图片]、去掉 Markdown 记号、压空白。**不截断**。
 * 搜索结果行要的是清洗过但不限长的一行（长度交给 CSS 省略号），所以清洗和截断分开。
 * 照抄服务端 conversations.js 的 previewOf。别再各抄一遍正则——抄一遍就多一处会走样的地方。
 */
export function plainTextOf(body: string): string {
  return String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/[#*`\-\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 正文摘要：清洗 + 截断。引用块和桌面通知都用这一份。
 *
 * 截断走 text.ts 的 truncate（按字素簇），**不能用 slice** —— slice 按 UTF-16 码元切，
 * 正好切在 emoji 中间就留下半个代理对，引用块里是个 �。理由与样例见 text.ts。
 */
export function previewOf(body: string): string {
  return truncate(plainTextOf(body), QUOTE_PREVIEW_LIMIT);
}

/**
 * 从一条消息造出「正在回复它」需要的那点信息：发送者 + 正文摘要。
 * 这样输入框上方看到的和消息发出去之后气泡里看到的是同一行字。
 */
export function replyTargetOf(message: Message): ReplyTarget {
  return { id: message.id, senderName: message.senderName, preview: previewOf(message.body) };
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
