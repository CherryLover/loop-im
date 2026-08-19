import { Router } from 'express';
import { authenticate } from '../auth.js';
import { run, now, uid } from '../db.js';
import { driver, putObject } from '../storage.js';
import { upload } from '../upload-middleware.js';

export const router = Router();
router.use(authenticate);

// 图片作为附件：先上传到对象存储，再把返回的链接拼成 Markdown 图片发送。
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '只支持图片附件' });
  const { url } = await putObject({
    buffer: req.file.buffer,
    filename: req.file.originalname || 'image.png',
    mime: req.file.mimetype,
  });
  run(
    `INSERT INTO attachments (id, owner_id, filename, url, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    uid('a'), req.user.id, req.file.originalname || 'image.png', url, req.file.mimetype, req.file.size, now(),
  );
  res.status(201).json({ url, filename: req.file.originalname || 'image.png', storage: driver });
});
