import { Router } from 'express';
import { authenticate } from '../auth.js';
import { run, now, uid } from '../db.js';
import { decodeUploadName, displayName, inspectUpload } from '../attachments.js';
import { driver, putObject } from '../storage.js';
import { upload } from '../upload-middleware.js';

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
  if (verdict.kind === 'rejected') return res.status(400).json({ error: verdict.error });

  const filename = displayName(decodeUploadName(req.file.originalname));
  const { url } = await putObject({ buffer: req.file.buffer, ext: verdict.ext, mime: verdict.mime });
  run(
    `INSERT INTO attachments (id, owner_id, filename, url, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    uid('a'), req.user.id, filename, url, verdict.mime, req.file.size, now(),
  );
  res.status(201).json({ url, filename, kind: verdict.kind, mime: verdict.mime, storage: driver });
});
