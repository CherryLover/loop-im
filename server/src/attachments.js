/**
 * 附件的类型判定与落盘/回源策略。issue #22 的修复都收在这一个文件里。
 *
 * 出事的地方：旧实现只信客户端自报的 `Content-Type`，落盘时又原样沿用用户传来的扩展名。
 * 于是一份 HTML 谎报成 `image/png`、取名 `x.html`，就会以 `.html` 落在 uploads 目录里，
 * `express.static` 按扩展名当网页返回，脚本在**和聊天系统同源**的页面里执行，
 * 能直接读走 localStorage 里的登录凭据 —— 存储型 XSS + 凭据窃取。
 *
 * 修法不是「只收图片、其余全拒」（那样就没法发 PDF/ZIP 了），而是**按用途分流**：
 *
 *   图片通道：必须按真实字节嗅探（magic number），只认 PNG / JPEG / GIF / WebP。
 *             扩展名由嗅探结果决定，绝不沿用用户传来的文件名。只有这一档允许内联渲染。
 *   文件通道：什么都收，但一律落成 `.bin`，回源时强制 `Content-Disposition: attachment`
 *             + `application/octet-stream` + `nosniff`，浏览器只会下载，不会当网页跑。
 *   SVG：     一律拒绝。SVG 是可执行的 XML，即使按图片对待也能带脚本。
 *
 * 原始文件名只作为**显示名**存在数据库和消息里，绝不参与磁盘路径和 URL。
 */
import { extname } from 'node:path';

/** 允许内联渲染的图片格式：扩展名和 Content-Type 都由这张表说了算。 */
const IMAGE_SIGNATURES = [
  { mime: 'image/png', ext: '.png', match: (b) => head(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  // JPEG 的 SOI + 第一个标记，JFIF/Exif/裸 JPEG 都覆盖得到。
  { mime: 'image/jpeg', ext: '.jpg', match: (b) => head(b, [0xff, 0xd8, 0xff]) },
  // "GIF87a" / "GIF89a"
  {
    mime: 'image/gif',
    ext: '.gif',
    match: (b) => head(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  },
  // "RIFF"????"WEBP"
  {
    mime: 'image/webp',
    ext: '.webp',
    match: (b) => head(b, [0x52, 0x49, 0x46, 0x46]) && head(b, [0x57, 0x45, 0x42, 0x50], 8),
  },
];

/** 非图片附件统一落成这个扩展名 + Content-Type：看一眼就知道不可能被当网页执行。 */
export const BINARY_EXT = '.bin';
export const BINARY_MIME = 'application/octet-stream';

export const SVG_REJECTED = '出于安全考虑，不支持 SVG 文件';
export const NOT_AN_IMAGE = '这不是有效的图片文件，只支持 PNG / JPEG / GIF / WebP';
export const AVATAR_NOT_IMAGE = '头像只支持 PNG / JPEG / GIF / WebP 图片';

const head = (buffer, bytes, offset = 0) =>
  buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b);

/** 真实字节是不是四种安全图片之一。是就返回该用哪个 mime / 扩展名，不是就返回 null。 */
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const hit = IMAGE_SIGNATURES.find((s) => s.match(buffer));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

/**
 * 看起来像 SVG 就算 SVG。SVG 没有 magic number，只能按文本判断：开头 1KB 里出现
 * `<svg ` / `<svg>` / `<!DOCTYPE svg` 就算命中，XML 声明、注释、BOM 打头都拦得住。
 * 宁可误伤（一份开头 1KB 里就写了 `<svg` 的纯文本会被拒），也不放过。
 */
export function looksLikeSvg(buffer) {
  if (!buffer || !buffer.length) return false;
  const text = buffer.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '');
  return /<svg[\s/>]/i.test(text) || /<!doctype\s+svg/i.test(text);
}

/**
 * 一份上传该走哪条通道。只看真实字节，`declaredMime` 只用来判断「用户想发的是不是图片」：
 * 想发图片却拿不出合法图片字节时要明确报错，而不是悄悄降级成附件 —— issue #22 的回归清单
 * 要求「HTML 谎报为 image/png」返回 400，悄悄收下会让人以为图片发出去了。
 *
 * @returns {{kind:'image'|'file', mime:string, ext:string} | {kind:'rejected', error:string}}
 */
export function inspectUpload(buffer, declaredMime = '') {
  if (looksLikeSvg(buffer)) return { kind: 'rejected', error: SVG_REJECTED };
  const image = sniffImage(buffer);
  if (image) return { kind: 'image', mime: image.mime, ext: image.ext };
  if (/^image\//i.test(String(declaredMime))) return { kind: 'rejected', error: NOT_AN_IMAGE };
  return { kind: 'file', mime: BINARY_MIME, ext: BINARY_EXT };
}

/**
 * multer 交回来的 `originalname` 是 busboy 按 latin1 解出来的，中文文件名到这里已经是乱码
 * （「交付物.zip」→「äº¤ä»\x98ç\x89©.zip」）。multipart 里的文件名本身是字节串、浏览器发的是
 * UTF-8，所以按 latin1 编回字节再按 UTF-8 解就能还原；解不出合法 UTF-8 时保留原样。
 *
 * 以前文件名只用来取扩展名和当图片 alt，乱码看不太出来；现在它是文件卡片上给人看的那行字。
 */
export function decodeUploadName(raw) {
  const text = String(raw || '');
  const utf8 = Buffer.from(text, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? text : utf8;
}

/**
 * 原始文件名只作为显示名：去掉目录部分和控制字符再限长。
 * 它会进数据库、进消息正文，但**绝不**参与磁盘路径和 URL。
 */
export function displayName(raw, fallback = '附件') {
  const base = String(raw || '').split(/[\\/]/).pop() || '';
  const clean = Array.from(base)
    .filter((ch) => ch >= ' ' && ch !== '\u007f')
    .join('')
    .trim();
  return clean.slice(0, 120) || fallback;
}

/**
 * 允许内联返回的扩展名白名单。比嗅探表多一个 `.jpeg`：修复之前落盘的文件沿用的是用户的
 * 原始扩展名，历史上的 `.jpeg` 图片不该因为这次修复变成下载。这么放宽仍然是安全的 ——
 * 白名单里的每一项都会被钉死成 `image/*` 并带 `nosniff`，浏览器不会再去猜内容类型，
 * 所以哪怕某个遗留的 `.jpeg` 里装的其实是 HTML，也只会渲染成一张坏图，不会执行。
 */
const INLINE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

/**
 * 站内附件地址长这样：`/uploads/<key>`，key 由服务端生成（randomUUID + 服务端定的扩展名）。
 * 消息正文里它以 Markdown 链接/图片的形式出现，所以「这条消息引用了哪些附件」就是在正文里
 * 扫这个模式。字符集刻意收紧到 key 真实可能出现的范围，别把后面的 `)` 或中文一起吃进来。
 */
const ATTACHMENT_URL_RE = /\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** 从一段正文里抽出它引用到的全部附件 key，去重。 */
export function attachmentKeysIn(body) {
  const keys = new Set();
  for (const m of String(body || '').matchAll(ATTACHMENT_URL_RE)) keys.add(m[1]);
  return [...keys];
}

/** `/uploads/9f3a.png` → `9f3a.png`；不是站内附件地址就返回 null。 */
export function keyFromUrl(url) {
  const m = /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(url || ''));
  return m ? m[1] : null;
}

/**
 * `/uploads` 的回源响应头。按扩展名白名单决定：
 *
 *   白名单内 —— 钉死成对应的 `image/*`，可以内联；
 *   其余（含 `.bin`，也含修复之前遗留下来的 `.html`、`.svg` 之类）—— 一律强制下载。
 *
 * 白名单之外全部按附件处理，意味着历史上已经落盘的恶意文件从这一刻起也跑不起来了，
 * 不必等清理脚本跑过（清理脚本见 scripts/cleanup-legacy-uploads.mjs）。
 */
export function setUploadHeaders(res, filePath) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ext = extname(String(filePath || '')).toLowerCase();
  const inline = INLINE_EXTENSIONS.get(ext);
  if (inline) {
    res.setHeader('Content-Type', inline);
    return;
  }
  res.setHeader('Content-Type', BINARY_MIME);
  res.setHeader('Content-Disposition', 'attachment');
  // 万一还是有人把它当文档打开（比如手工改 URL），这条 CSP 让它什么都做不了。
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
}
