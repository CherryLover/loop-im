/**
 * 把预览里的大图存下来时用的两个小工具：起文件名、触发下载。
 *
 * 单独拆出来是因为「叫什么名字」是纯逻辑，值得直接拿用例钉住；
 * 而真正的取图（fetch）和分享（navigator.share）留在 ImageViewer 里，
 * 那部分是流程不是计算。
 */

/** 常见图片 MIME → 扩展名。响应头说了算：URL 上的扩展名可能是假的或者干脆没有。 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
};

/**
 * 给要保存的图起个名字。
 *
 * 优先用 alt：消息里的图片是 `![原始文件名](服务端地址)` 存的，alt 多半就是发送时
 * 的文件名，比服务端那串哈希（9f3a.png）对人友好得多。alt 是空的才退回 URL 的
 * basename；blob: 这种没有像样路径的地址就只剩 uuid 兜底。
 *
 * 扩展名以 MIME 为准（真下载到的是什么格式就标什么），MIME 不认识才依次退回
 * alt / URL 上原有的扩展名，最后兜底 png。
 */
export function imageFileName(alt: string, src: string, mime: string): string {
  const extFromMime = EXT_BY_MIME[(mime || '').split(';')[0]?.trim() ?? ''];

  let base = '';
  let extFromUrl = '';
  try {
    const path = new URL(src, 'http://local').pathname;
    let seg = path.split('/').pop() || '';
    try { seg = decodeURIComponent(seg); } catch { /* 保留原样 */ }
    const m = seg.match(/^(.+)\.([a-z0-9]{2,5})$/i);
    if (m) { base = m[1] ?? ''; extFromUrl = (m[2] ?? '').toLowerCase(); } else base = seg;
  } catch { /* 解析不了的地址（不该发生），靠 alt 和兜底 */ }

  // 文件名里不能出现的字符换成空格；alt 是用户输入，别让它把路径写坏。
  const cleanAlt = alt.replace(/[\\/:*?"<>|]/g, ' ').trim();
  const altM = cleanAlt.match(/^(.+)\.([a-z0-9]{2,5})$/i);
  const name = (altM ? altM[1] : cleanAlt) || base || 'image';
  const ext = extFromMime || (altM ? (altM[2] ?? '').toLowerCase() : '') || extFromUrl || 'png';
  return `${name}.${ext}`;
}

/**
 * 用一个临时 <a download> 把 Blob 落到本地。
 *
 * 先挂进 DOM 再 click：iOS Safari 对不在文档里的锚点的合成点击不理会。
 * objectURL 延迟一分钟再回收——回收太早，个别浏览器的下载还没从这个 URL 里读完。
 */
export function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
