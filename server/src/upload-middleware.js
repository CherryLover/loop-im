import multer from 'multer';

// 图片体积上限，前后端提示同一个数字。
export const MAX_UPLOAD_MB = 8;
export const OVERSIZED_MESSAGE = `图片大小不能超过 ${MAX_UPLOAD_MB}MB`;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});
