/**
 * The prototype's Markdown subset: paragraphs, bullet lists, bold, inline code,
 * links, images and @mentions. Escapes first, so the result is safe to inject.
 */
const escapeHtml = (raw: string) =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// data:image/svg+xml 单独挡掉：SVG 是可执行的 XML，服务端也一律拒收（见 issue #22），
// 前端没道理留一条自己造 SVG 的口子。其余 data:image/ 是位图，进不了脚本上下文。
const safeUrl = (url: string) =>
  /^data:image\/svg/i.test(url) ? '#'
    : /^(https?:\/\/|\/|data:image\/)/i.test(url) ? url : '#';

/** 站内附件地址。服务端保证这类 URL 一定带强制下载的响应头。 */
const isAttachment = (url: string) => /^\/uploads\//i.test(url);

export function renderMarkdown(source: string): string {
  let s = escapeHtml(String(source || ''));

  /**
   * 生成好的属性值先抽出来占位，最后一步再放回去。不这么做的话，后面几条行内规则会伸进
   * 标签里改属性：一个叫「@报告.pdf」的附件，@提及那条规则会把 <strong> 塞进
   * download="…" 里，把属性撑破（同理 alt、href 里出现 @ 或 ** 也会）。
   * 占位符用 U+0000，它既不可能出现在转义后的正文里，也不会被任何一条规则匹配到。
   */
  const slots: string[] = [];
  const hold = (value: string) => `\u0000${slots.push(value) - 1}\u0000`;

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) =>
    `<img alt="${hold(alt)}" src="${hold(safeUrl(url))}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const href = safeUrl(url);
    // 指向 /uploads/ 的链接一律渲染成「文件卡片 + 下载」，永远不内联。
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
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/@([A-Za-z一-龥]+)/g, '<strong class="mention">@$1</strong>');

  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      out.push(`<ul>${list.map((i) => `<li>${i}</li>`).join('')}</ul>`);
      list = [];
    }
  };
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (/^[-*]\s+/.test(t)) {
      list.push(t.replace(/^[-*]\s+/, ''));
    } else {
      flush();
      if (t) out.push(`<p>${t}</p>`);
    }
  }
  flush();
  // 属性值原样放回。它们在 escapeHtml 之后就没再被改过，放回去仍然是转义过的。
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)]);
}

/** First character of a name, used for the initial-style avatars. */
export const initialOf = (name: string) => (name === 'Aria' ? 'Ar' : (name || '?').trim().slice(0, 1));
