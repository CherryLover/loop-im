import { Router } from 'express';
import { authenticate } from '../auth.js';
import { run, now, uid } from '../db.js';
import { decodeUploadName, displayName, inspectUpload } from '../attachments.js';
import { getDriver, putObject } from '../storage.js';
import { upload } from '../upload-middleware.js';
import { logEvent, logWarn } from '../log.js';

export const router = Router();
router.use(authenticate);

/**
 * 聊天附件。按真实字节分流（见 src/attachments.js）：
 *   kind=image —— PNG/JPEG/GIF/WebP，前端拼成 Markdown 图片，可以内联渲染；
 *   kind=file  —— 其余任意文件，落成 .bin，前端拼成普通链接，只能下载。
 * 客户端自报的 Content-Type 和文件名都不参与安全判定，文件名只当显示名。
 */
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择要发送的文件' });

  const verdict = inspectUpload(req.file.buffer, req.file.mimetype);
  // 日志只记「多大、什么类型、为什么被拒」，不记文件名、更不记文件内容（见 log.js 的红线）。
  if (verdict.kind === 'rejected') {
    logWarn('upload.rejected', {
      userId: req.user.id, bytes: req.file.size, declaredMime: req.file.mimetype, reason: verdict.error,
    });
    return res.status(400).json({ error: verdict.error });
  }

  const filename = displayName(decodeUploadName(req.file.originalname));
  const { url } = await putObject({ buffer: req.file.buffer, ext: verdict.ext, mime: verdict.mime });
  run(
    `INSERT INTO attachments (id, owner_id, filename, url, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    uid('a'), req.user.id, filename, url, verdict.mime, req.file.size, now(),
  );
  const storage = getDriver();
  logEvent('upload.accepted', {
    userId: req.user.id, bytes: req.file.size, kind: verdict.kind, mime: verdict.mime, storage,
  });
  res.status(201).json({ url, filename, kind: verdict.kind, mime: verdict.mime, storage });
});
