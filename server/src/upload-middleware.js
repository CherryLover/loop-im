import multer from 'multer';

// 附件体积上限，前后端提示同一个数字。
export const MAX_UPLOAD_MB = 8;
export const OVERSIZED_MESSAGE = `文件大小不能超过 ${MAX_UPLOAD_MB}MB`;

// 这个 +1 不是笔误，别删：busboy 的 limits.fileSize 是「不得达到」而不是「不得超过」——
// 写入字节数一达到该值就判超限，所以填 8*1024*1024 时实际放行的最大值只有 8MB-1 字节，
// 正好 8MB 的图片会被拒。前端 checkSize 用的是严格大于（正好 8MB 放行），界面文案也写的
// 「不超过 8MB」，语义上都包含 8MB 这一档；填 +1 才能让三者对齐。见 issue #15。
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/**
 * 这里**故意没有** fileFilter。原来那句 `file.mimetype.startsWith('image/')` 看似是道防线，
 * 实际只信客户端自报的 Content-Type，谎报一下就过（issue #22），却又把 PDF/ZIP 这类正常
 * 附件挡在门外。真正的判定放到拿得到完整字节之后做：见 src/attachments.js 的 inspectUpload，
 * 由各条上传路由按用途分流（聊天附件收图片也收文件，头像只收图片）。
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES + 1 },
});
