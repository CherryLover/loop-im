/**
 * 附件回源。以前这里是一行 `express.static(UPLOAD_DIR, { setHeaders: setUploadHeaders })`。
 *
 * ── 为什么浏览器不直连 MinIO ────────────────────────────────────────────
 * issue #22 的**全部**防护都长在回源这一层：按扩展名白名单钉死 Content-Type、
 * 非白名单一律 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、
 * 外加一条 `default-src 'none'; sandbox` 的 CSP。
 *
 * 只要让浏览器直接去对象存储取文件（预签名 URL、公开桶、CDN 回源，随便哪种），
 * 这组头就全部消失 —— MinIO 只会按对象自己的 Content-Type 返回，一份存进去的 HTML
 * 会被当网页渲染，存储型 XSS 当场复活。所以架构上就堵死这条路：
 * MinIO 只在 Docker 内网监听，压根不对公网开放，浏览器连不到它。
 *
 *   浏览器 → GET /uploads/:key（带凭据）
 *          → Express 鉴权，从 minio:9000 取对象
 *          → Express 加上和改造前**逐字一样**的安全头
 *          → 转发给浏览器
 *
 * 安全策略仍然只有一处：src/attachments.js 的 setUploadHeaders，本文件原样调用它，
 * 一个字都不重写。逐条锁死这些头的用例在 test/uploads-proxy.test.js 与 test/issue-22.test.js。
 */
import { Router } from 'express';
import { authenticate } from '../auth.js';
import { setUploadHeaders } from '../attachments.js';
import { isSafeKey } from '../object-store.js';
import { getObject } from '../storage.js';
import { authorizeDownload, DENIED } from '../attachment-access.js';
import { logWarn } from '../log.js';

export const router = Router();

// 未登录 401 就在这里给出（authenticate 顺带把已停用账号也挡了，它返回的同样是 401）。
router.use(authenticate);

router.get('/:key', async (req, res) => {
  const { key } = req.params;
  // 形状不对的 key 连查都不用查。和「查无此附件」给同一个回复。
  if (!isSafeKey(key)) return res.status(DENIED.status).json({ error: DENIED.error });

  const verdict = authorizeDownload(key, req.user);
  if (!verdict.ok) {
    // 只记 id 和拒绝原因，不记文件名、不记正文（见 log.js 的红线）。
    logWarn('upload.download_denied', { userId: req.user.id, key, reason: verdict.reason });
    return res.status(DENIED.status).json({ error: DENIED.error });
  }

  const body = await getObject(key);
  // 有授权但对象没了（清理过、迁移漏了）：同样一句话，不区分。
  if (!body) return res.status(DENIED.status).json({ error: DENIED.error });

  // ⚠️ 这一行就是 issue #22 的全部防线，位置在 send 之前，任何分支都不能绕过它。
  setUploadHeaders(res, key);
  // 私有内容不该被共享缓存留下来。改造前 express.static 给的是 `public, max-age=3600`，
  // 那时附件本来就是公开的；现在加了鉴权，缓存必须降级成「只准存在这个人的浏览器里」。
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
});

export default router;
