import { truncate } from './text';
import { isVideoAttachment } from './md';
import type { Message, ReplyTarget } from './types';

/** 引用摘要的长度，与服务端 conversations.js 的 QUOTE_PREVIEW_LIMIT 保持一致。 */
export const QUOTE_PREVIEW_LIMIT = 48;

/**
 * 这个站内附件是不是视频。
 *
 * 判据抄自 md.ts 的 isVideoAttachment（那边没导出，md.ts 不在这次的改动范围里），
 * 三件事必须跟它一模一样，否则同一条正文会「渲染成播放器、摘要里却写着 [文件]」：
 *   1. 只认 /uploads/ 开头的站内附件；
 *   2. 后缀只认 .mp4 / .webm；
 *   3. 先切掉 ?query / #hash 再看后缀 —— 正文是用户手打的，
 *      `[x](/uploads/a.bin?v=.mp4)` 不能被当成视频。
 * 口径漂了的话下面 messages.test.ts 里那组共享用例会红。
 */
// 判据只有一份，在 md.ts —— 渲染成 <video> 和摘要折成 [视频] 必须是同一条规则，
// 否则会出现「气泡里是播放器、引用块里却说这是个文件」。原先这里抄了一份，已删。
const isVideoAttachmentUrl = isVideoAttachment;

/**
 * 摘要的清洗口径：附件折成 [图片] / [视频] / [文件] 名字、去掉 Markdown 记号、压空白。**不截断**。
 * 搜索结果行要的是清洗过但不限长的一行（长度交给 CSS 省略号），所以清洗和截断分开。
 *
 * 照抄服务端 conversations.js 的 previewOf。别再各抄一遍正则——抄一遍就多一处会走样的地方。
 * （这句话原来就写在这儿，然后它还是漂了：服务端有「非图片附件 → [文件] 名字」那条，
 * 这边一直没有，结果引用块和桌面通知里把 /uploads/ 的原始路径整条抖了出来。
 * 两边的口径只有一份，就是 [图片] / [视频] / [文件] 名字这三种形态。）
 *
 * 顺序不能换：图片那条必须先跑。`![x](y)` 里也含着一个 `[x](y)`，
 * 链接那条先跑就会把图片语法从中间咬开。
 */
export function plainTextOf(body: string): string {
  return String(body || '')
    // ![alt](url)：指向站内视频的一律 [视频]（md.ts 把这种写法也渲染成播放器），其余 [图片]。
    .replace(/!\[[^\]]*\]\(([^)]*)\)/g, (_m, url: string) => (isVideoAttachmentUrl(url) ? '[视频]' : '[图片]'))
    // [名字](/uploads/…)：站内视频同样折成 [视频]，其余非图片附件只显示「[文件] 名字」，
    // 不把 /uploads/ 路径抖出来。站外普通链接不动，它本来就是可读的一段字。
    .replace(
      /\[([^\]]*)\]\((\/uploads\/[^)]*)\)/g,
      (_m, label: string, url: string) => (isVideoAttachmentUrl(url) ? '[视频]' : `[文件] ${label}`),
    )
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
