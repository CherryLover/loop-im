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
 *
 * ── Range（`<video>` 的硬需求）─────────────────────────────────────────
 * 视频要能拖进度条、要能在 Safari / iOS 上播，就必须支持 206。字节是**流**过去的，
 * 不再 `res.end(整个 buffer)`：100MB 的视频整份进堆，和上传那一侧是同一个毛病。
 *
 * Range 只对「按视频内联」的那一档处理，判据仍然是 attachments.js 那张表
 * （isInlineVideoKey，和 setUploadHeaders 用的是同一张）。图片和普通文件因此
 * **一个字节都没变**：不带 Range 的请求走的还是原来那条路，响应头逐字相同。
 * 这也是有意的取舍 —— 那两档最大只有 8MB，断点续传的价值约等于零，
 * 而「响应头和现在一模一样」是回归保护里明确要求的。
 */
import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { authenticate } from '../auth.js';
import { isInlineVideoKey, setUploadHeaders } from '../attachments.js';
import { isSafeKey } from '../object-store.js';
import { openObject } from '../storage.js';
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

  // 只有内联视频那一档才处理 Range —— 也只有那一档在响应里声明了 Accept-Ranges。
  // 别的类型即使客户端硬塞一个 Range 头进来，也照旧 200 + 完整内容，行为不变。
  const range = isInlineVideoKey(key) ? req.headers.range : undefined;
  const opened = await openObject(key, { range });
  // 有授权但对象没了（清理过、迁移漏了）：同样一句话，不区分。
  if (!opened) return res.status(DENIED.status).json({ error: DENIED.error });

  // ⚠️ 这一行就是 issue #22 的全部防线，位置在 send 之前，任何分支都不能绕过它。
  setUploadHeaders(res, key);
  // 私有内容不该被共享缓存留下来。改造前 express.static 给的是 `public, max-age=3600`，
  // 那时附件本来就是公开的；现在加了鉴权，缓存必须降级成「只准存在这个人的浏览器里」。
  res.setHeader('Cache-Control', 'private, max-age=3600');

  // 范围越界：416 + `Content-Range: bytes * /总长`。少了这条头播放器不知道该往哪儿要，
  // 会一直拿同一个坏 Range 重试。
  if (opened.status === 416) {
    res.setHeader('Content-Range', `bytes */${opened.totalSize ?? 0}`);
    return res.status(416).end();
  }

  if (opened.status === 206) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${opened.start}-${opened.end}/${opened.totalSize}`);
  }
  res.setHeader('Content-Length', String(opened.size));

  try {
    // 流式转发。pipeline 顺带管住两件事：客户端中途断开时销毁上游的流（否则
    // MinIO 那条连接会挂着），以及上游出错时不把半截响应当成功。
    await pipeline(opened.stream, res);
  } catch (err) {
    // 客户端自己走了不算故障，**更不能记日志**：播放器每拖一次进度条都会掐掉上一条
    // 连接（ERR_STREAM_PREMATURE_CLOSE），照记的话看一集视频就能刷出上百行警告，
    // 真正的故障会被淹掉。只有上游（磁盘 / MinIO）出问题才值得记。
    const clientGone = res.destroyed || req.destroyed;
    if (!clientGone) {
      // 头早就发出去了，这里已经没法改状态码，能做的只有断掉连接 + 留一行日志。
      // 只记 key 和错误，不记文件名、不记内容（见 log.js 的红线）。
      logWarn('upload.stream_failed', { userId: req.user.id, key, err: String(err?.message || err) });
    }
    res.destroy();
  }
});

export default router;
