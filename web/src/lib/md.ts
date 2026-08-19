/**
 * The prototype's Markdown subset: paragraphs, bullet lists, bold, inline code,
 * links, images and @mentions. Escapes first, so the result is safe to inject.
 */
const escapeHtml = (raw: string) =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeUrl = (url: string) =>
  /^(https?:\/\/|\/|data:image\/)/i.test(url) ? url : '#';

export function renderMarkdown(source: string): string {
  let s = escapeHtml(String(source || ''));

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) =>
    `<img alt="${alt}" src="${safeUrl(url)}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    `<a href="${safeUrl(url)}" target="_blank" rel="noreferrer">${label}</a>`);
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
  return out.join('');
}

/** First character of a name, used for the initial-style avatars. */
export const initialOf = (name: string) => (name === 'Aria' ? 'Ar' : (name || '?').trim().slice(0, 1));
