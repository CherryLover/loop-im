import { truncate } from './text';

/**
 * The prototype's Markdown subset: paragraphs, headings, bullet/ordered lists, blockquotes,
 * fenced code blocks, bold, italic, inline code, links, images, inline video and @mentions.
 * Escapes first, so the result is safe to inject.
 *
 * 刻意不做的两样：**表格**（在聊天气泡这么窄的地方排不出可读的版）和**原始 HTML**
 * （这个函数的输出是直接 innerHTML 进 DOM 的，放行 HTML 等于把 XSS 开在自家门口）。
 */
import { attachmentUrl } from './api';

const escapeHtml = (raw: string) =>
  raw
    // U+0000 是下面占位槽的分隔符。正文里真出现一个 NUL 就会和占位符撞车，让用户输入
    // 有机会指向别人的槽位，所以进门第一件事是把它剔掉（它在聊天正文里也没有意义）。
    .replace(/\u0000/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// data:image/svg+xml 单独挡掉：SVG 是可执行的 XML，服务端也一律拒收（见 issue #22），
// 前端没道理留一条自己造 SVG 的口子。其余 data:image/ 是位图，进不了脚本上下文。
const safeUrl = (url: string) =>
  /^data:image\/svg/i.test(url) ? '#'
    : /^(https?:\/\/|\/|data:image\/)/i.test(url) ? url : '#';

/** 站内附件地址。服务端保证这类 URL 一定带强制下载的响应头。 */
const isAttachment = (url: string) => /^\/uploads\//i.test(url);

/**
 * 这个站内附件是不是视频。
 *
 * 判据是 **URL 的扩展名**，不是 Markdown 写法：
 *
 *   - `/uploads/<key>` 里的 key 完全由服务端生成（randomUUID + 服务端按真实字节嗅探出的
 *     扩展名，见 server/src/attachments.js）。用户原来的文件名不参与 URL，所以 `.mp4` /
 *     `.webm` 这个后缀是服务端替我们背书过的事实，不是用户说了算的东西。
 *   - 反过来，Markdown 语法是用户说了算的。同一段视频，有人写 `![片子](…)`、有人写
 *     `[片子](…)`；AI 生成的、老客户端发的、手打的正文都在库里存着。只按语法区分，
 *     等于让「能不能播」取决于当初谁怎么打的那行字，同一个附件会有两种表现。
 *   - 所以两种写法都在这里收敛到同一个判断上：链接指向 /uploads/ 且后缀是视频 → 播放器。
 *
 * 注意要在 attachmentUrl() 拼上 ?token= **之前**判断，否则后缀后面还跟着查询串。
 */
const isVideoAttachment = (url: string) => isAttachment(url) && /\.(mp4|webm)$/i.test(url);

export function renderMarkdown(source: string): string {
  let s = escapeHtml(String(source || ''));

  /**
   * 生成好的属性值先抽出来占位，最后一步再放回去。不这么做的话，后面几条行内规则会伸进
   * 标签里改属性：一个叫「@报告.pdf」的附件，@提及那条规则会把 <strong> 塞进
   * download="…" 里，把属性撑破（同理 alt、href 里出现 @ 或 ** 也会）。
   * 占位符用 U+0000，它既不可能出现在转义后的正文里（escapeHtml 已经把它剔掉了），
   * 也不会被任何一条规则匹配到。
   */
  const slots: string[] = [];
  const hold = (value: string) => `\u0000${slots.push(value) - 1}\u0000`;
  /**
   * 整块的槽位（目前只有代码块）。它们和行内槽位共用一个数组，只是额外记下「这一个是
   * 块级的」——分块时它要独占一行直出，不能被 <p> 包起来。
   */
  const blockSlots = new Set<number>();
  const holdBlock = (html: string) => {
    const token = hold(html);
    blockSlots.add(slots.length - 1);
    return token;
  };

  const videoTag = (safe: string, label: string) =>
    '<video class="mdvideo" controls playsinline preload="metadata"'
    // preload 是 metadata 不是 auto：一屏里滚过几个视频，auto 会把每一个都拉下来，
    // 流量和内存都吃不消。metadata 只取时长和首帧信息，点了才开始下。
    // playsinline 是给 iOS Safari 的：不写它，手机上一点播放就强制全屏接管。
    + ` src="${hold(attachmentUrl(safe))}" aria-label="${hold(label || '视频附件')}"></video>`;

  // ---- 1) 代码先抽走 ----
  // 代码块和行内代码的内容立刻进槽位，之后所有行内规则都碰不到它。所以代码里的
  // **粗体**、@某人、![图]() 一律保持字面量 —— 这正是「代码块」该有的语义。
  // 内容此时已经过 escapeHtml，放回去仍然是转义过的。
  // 必须有闭合的 ``` 才成块；只开不闭时这条规则不匹配，那几行原样当普通文字，
  // 不会把后面的正文整段吞掉。开头那行的语言标注（```js）读进来但不用。
  s = s.replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (_m, code: string) =>
    holdBlock(`<pre class="mdcode"><code>${code.replace(/\n$/, '')}</code></pre>`));
  // 行内代码同理，内容也进槽位；顺带把它排在图片/链接前面，`![图](x)` 这种写在反引号
  // 里的东西才真的是字面量。
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${hold(code)}</code>`);

  // ---- 2) 图片 / 视频 / 链接 ----
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => {
    const safe = safeUrl(url);
    if (isVideoAttachment(safe)) return videoTag(safe, alt);
    return `<img alt="${hold(alt)}" src="${hold(attachmentUrl(safe))}">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const safe = safeUrl(url);
    // 视频走原生播放器。它和下面的文件卡片是同一个「站内附件」分支的两档，
    // 区别只在服务端给的后缀：视频回源带真实 Content-Type + Accept-Ranges，不带
    // Content-Disposition，所以能直接喂给 <video>；其余仍然只能下载。
    if (isVideoAttachment(safe)) return videoTag(safe, label);
    const href = attachmentUrl(safe);
    // 指向 /uploads/ 的非视频链接一律渲染成「文件卡片 + 下载」，永远不内联。
    // 真正拦住脚本执行的是服务端的响应头（Content-Disposition: attachment +
    // application/octet-stream + nosniff，见 server/src/attachments.js）——
    // md.ts 允许站内相对链接，恶意附件地址本来就能被包装成一条普通聊天链接，
    // 所以这条路径的安全性不能指望前端。这里的 download 只是让点击行为更直白，
    // 并且让下载下来的文件用回原来的显示名，而不是磁盘上的那串 uuid.bin。
    if (isAttachment(href)) {
      return `<a class="filecard" href="${hold(href)}" download="${hold(label)}" rel="noreferrer">`
        + `<span class="filecard__name">${label}</span><span class="filecard__hint">点击下载</span></a>`;
    }
    return `<a href="${hold(href)}" target="_blank" rel="noreferrer">${label}</a>`;
  });

  // ---- 3) 其余行内规则 ----
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体只认 *…*，不认 _…_。两个原因：一是生成好的标签里有 target="_blank"，下划线写法
  // 会跨过标签把两个 _ 之间的属性整段吃掉，把标签撑破（占位槽护得住属性值，护不住
  // 我们自己写死的 target="_blank"）；二是 user_id、__init__ 这类标识符里的下划线
  // 在技术群里满地都是，误判率太高。内容里排除掉 \n，免得一个落单的 * 跨行乱配。
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/@([A-Za-z一-龥]+)/g, '<strong class="mention">@$1</strong>');

  // ---- 4) 分块 ----
  const out: string[] = [];
  let list: string[] = [];
  let listTag: 'ul' | 'ol' = 'ul';
  let quote: string[] = [];
  const flushList = () => {
    if (list.length) {
      out.push(`<${listTag}>${list.map((i) => `<li>${i}</li>`).join('')}</${listTag}>`);
      list = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map((l) => `<p>${l}</p>`).join('')}</blockquote>`);
      quote = [];
    }
  };
  const flush = () => {
    flushList();
    flushQuote();
  };
  const pushItem = (tag: 'ul' | 'ol', item: string) => {
    flushQuote();
    if (list.length && listTag !== tag) flushList();   // 无序转有序（或反过来）另起一个列表
    listTag = tag;
    list.push(item);
  };

  for (const line of s.split('\n')) {
    const t = line.trim();

    // 代码块整块直出。这里比对的是占位符本身，块里的内容还在槽位里没回来，所以下面
    // 那几条块级规则（引用、标题、列表）不可能误伤代码块里以 >、#、- 开头的行。
    const token = /^\u0000(\d+)\u0000$/.exec(t);
    if (token && blockSlots.has(Number(token[1]))) {
      flush();
      out.push(t);
      continue;
    }
    // 引用。注意 escapeHtml 早就把 '>' 变成了 '&gt;'，这里要按转义后的形态匹配。
    const quoted = /^&gt;\s?(.*)$/.exec(t);
    if (quoted) {
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(t);
    if (heading) {
      flush();
      out.push(`<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(t);
    if (bullet) {
      pushItem('ul', bullet[1]);
      continue;
    }
    // 有序列表：`1. 项` 和 `1) 项` 都认。序号本身不保留，交给 <ol> 自己编。
    const ordered = /^\d{1,9}[.)]\s+(.+)$/.exec(t);
    if (ordered) {
      pushItem('ol', ordered[1]);
      continue;
    }
    flush();
    if (t) out.push(`<p>${t}</p>`);
  }
  flush();
  // 槽位原样放回。它们在 escapeHtml 之后就没再被改过，放回去仍然是转义过的。
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)]);
}

/**
 * First character of a name, used for the initial-style avatars.
 * 取「第一个字」用 truncate 而不是 slice(0, 1)：名字以 emoji 开头时 slice 只拿到半个
 * 代理对，头像里就是一个 �（见 text.ts）。
 */
export const initialOf = (name: string) => (name === 'Aria' ? 'Ar' : truncate((name || '?').trim(), 1));
