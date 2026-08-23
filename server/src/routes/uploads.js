import { Router } from 'express';
import { authenticate } from '../auth.js';
import { run, now, uid } from '../db.js';
import { decodeUploadName, displayName, inspectUpload } from '../attachments.js';
import { getDriver, putObjectFromFile } from '../storage.js';
import { maxBytesFor, oversizedMessageFor, sizeTierFor, upload } from '../upload-middleware.js';
import { discardTemp, readSniffHead } from '../upload-temp.js';
import { limitUsage } from '../usage-limit.js';
import { logEvent, logWarn } from '../log.js';

export const router = Router();
router.use(authenticate);

/**
 * 聊天附件。按真实字节分流（见 src/attachments.js）：
 *   kind=image —— PNG/JPEG/GIF/WebP，前端拼成 Markdown 图片，可以内联渲染；
 *   kind=video —— MP4/WebM，前端拼成 <video>，可以内联播放（回源支持 Range，见 upload-files.js）；
 *   kind=file  —— 其余任意文件，落成 .bin，前端拼成普通链接，只能下载。
 * 客户端自报的 Content-Type 和文件名都不参与安全判定，文件名只当显示名。
 *
 * 字节先落到临时文件（multer 的 diskStorage），全程不整份进内存；那份临时文件在
 * finally 里删掉，失败路径也走同一处。请求中途断线由 multer 自己清（见 upload-temp.js）。
 */
// 限流挂在 multer 前面：超额时连这一份都不必往磁盘上写。
router.post('/', limitUsage('upload'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择要发送的文件' });

  try {
    // 只读开头 4KB 做嗅探。100MB 的视频不会有一个字节多进内存。
    const verdict = inspectUpload(await readSniffHead(req.file.path), req.file.mimetype);

    // 分档的体积上限只能在这里卡：真实类型要嗅探过才知道（说明见 upload-middleware.js）。
    // multer 那一层只拦住了 100MB 这道硬上限。体积排在格式前面，理由见 sizeTierFor。
    const tier = sizeTierFor(verdict.kind, req.file.mimetype);
    if (req.file.size > maxBytesFor(tier)) {
      logWarn('upload.rejected', {
        userId: req.user.id, bytes: req.file.size, kind: tier, reason: 'oversized',
      });
      return res.status(413).json({ error: oversizedMessageFor(tier) });
    }

    // 日志只记「多大、什么类型、为什么被拒」，不记文件名、更不记文件内容（见 log.js 的红线）。
    if (verdict.kind === 'rejected') {
      logWarn('upload.rejected', {
        userId: req.user.id, bytes: req.file.size, declaredMime: req.file.mimetype, reason: verdict.error,
      });
      return res.status(400).json({ error: verdict.error });
    }

    const filename = displayName(decodeUploadName(req.file.originalname));
    const { url } = await putObjectFromFile({ path: req.file.path, ext: verdict.ext, mime: verdict.mime });
    run(
      `INSERT INTO attachments (id, owner_id, filename, url, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      uid('a'), req.user.id, filename, url, verdict.mime, req.file.size, now(),
    );
    const storage = getDriver();
    logEvent('upload.accepted', {
      userId: req.user.id, bytes: req.file.size, kind: verdict.kind, mime: verdict.mime, storage,
    });
    res.status(201).json({ url, filename, kind: verdict.kind, mime: verdict.mime, storage });
  } finally {
    // 成功、被拒、抛异常 —— 三种都从这里走一遍，临时文件不会留下。
    await discardTemp(req.file);
  }
});
