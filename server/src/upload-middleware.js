import multer from 'multer';
import { UPLOAD_TMP_DIR } from './db.js';

// 附件体积上限，前后端提示同一个数字。**按类型分档**：
//   图片 / 普通文件 —— 8MB，和改造前一模一样；
//   视频           —— 100MB，浏览器原生 <video> 内联播放那一档。
export const MAX_UPLOAD_MB = 8;
export const MAX_VIDEO_MB = 100;
export const OVERSIZED_MESSAGE = `文件大小不能超过 ${MAX_UPLOAD_MB}MB`;
export const VIDEO_OVERSIZED_MESSAGE = `视频大小不能超过 ${MAX_VIDEO_MB}MB`;

// 这个 +1 不是笔误，别删：busboy 的 limits.fileSize 是「不得达到」而不是「不得超过」——
// 写入字节数一达到该值就判超限，所以填 8*1024*1024 时实际放行的最大值只有 8MB-1 字节，
// 正好 8MB 的图片会被拒。前端 checkSize 用的是严格大于（正好 8MB 放行），界面文案也写的
// 「不超过 8MB」，语义上都包含 8MB 这一档；填 +1 才能让三者对齐。见 issue #15。
// 分档之后这条语义原样适用于 100MB 那一档，multer 的 limits 里那个 +1 见下面。
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;

/** 这一档的上限是多少字节。kind 来自 inspectUpload（image / video / file）。 */
export const maxBytesFor = (kind) => (kind === 'video' ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES);
/** 超限时给用户看的话，和上面那张表配套。 */
export const oversizedMessageFor = (kind) => (kind === 'video' ? VIDEO_OVERSIZED_MESSAGE : OVERSIZED_MESSAGE);

/**
 * 该按哪一档卡体积。
 *
 * 嗅探出真实类型（image / video / file）时就按真实类型，没有第二种可能。
 * 嗅探不通过（rejected，比如一片随机字节自称 image/png）时手上没有真实类型，
 * 这时**只**拿客户端自报的 Content-Type 挑一档 —— 注意它在这里决定的仅仅是
 * 「先告诉用户哪个错：太大了，还是格式不对」，一个字都不参与安全判定，
 * 落盘扩展名、能不能内联仍然只看嗅探结果。
 *
 * 为什么体积要排在格式前面：一份 9MB 的乱码自称 image/png，回「文件太大」比回
 * 「这不是有效的图片」有用得多——用户第一步就该去压缩，而不是去换格式。
 * 这也是改造前的行为（那时 multer 在嗅探之前就把它 413 掉了），用例见 test/issue-9.test.js。
 */
export const sizeTierFor = (kind, declaredMime) => {
  if (kind !== 'rejected') return kind;
  return /^video\//i.test(String(declaredMime || '')) ? 'video' : 'file';
};

/**
 * ── 「上传时还不知道是不是视频」怎么办 ────────────────────────────────────
 *
 * multer 决定要不要继续收字节的那一刻，我们手上只有客户端自报的 Content-Type，
 * 而那玩意儿正是 issue #22 的成因，一个字都不能信。真实类型要等字节落地、
 * 按 magic number 嗅探过才知道 —— 也就是说**分档判定天然晚于收字节**。
 *
 * 所以这里分两层：
 *
 *   1. multer 只设一道**硬上限** = 100MB（分档里最大的那个）。超过它的请求在
 *      busboy 那一层就被掐断，返回 413 VIDEO_OVERSIZED_MESSAGE。
 *   2. 字节落地之后，路由拿前 4KB 嗅探出真实 kind，再按 maxBytesFor(kind) 卡第二道：
 *      一张 9MB 的 PNG 会走到这里才被 413 OVERSIZED_MESSAGE（8MB 那句话）。
 *
 * 代价说清楚：一张 9MB 的图片会被**完整写到临时文件**之后才判超限，白写 9MB 磁盘。
 * 用内存存储时这个代价是 9MB 堆，现在是 9MB 磁盘 + 立刻删掉，而且上传接口本来就有
 * 每分钟 20 次的限流（usage-limit.js）兜着。没有更好的办法：要想早一步掐断，
 * 就只能相信客户端自报的类型，那等于把 #22 的口子重新开一遍。
 *
 * 另外为什么不用 memoryStorage 了：100MB × 并发 = OOM。落临时文件之后内存恒定，
 * 上传链路全程只有流缓冲，签名（SigV4 要整份 payload 的 sha256）改成流式算，
 * 一样是精确的，没有退化成 UNSIGNED-PAYLOAD。见 object-store.js 的 putStreamed。
 */
export const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_TMP_DIR }),
  limits: { fileSize: MAX_VIDEO_BYTES + 1 },
});
