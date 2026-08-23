import express from 'express';
import cors from 'cors';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate } from './auth.js';
import { subscribe } from './events.js';
import { VIDEO_OVERSIZED_MESSAGE } from './upload-middleware.js';
import { router as authRoutes } from './routes/auth.js';
import { router as userRoutes } from './routes/users.js';
import { router as conversationRoutes } from './routes/conversations.js';
import { router as uploadRoutes } from './routes/uploads.js';
import { router as uploadFileRoutes } from './routes/upload-files.js';
import { router as searchRoutes } from './routes/search.js';
import { router as aiRoutes } from './routes/ai.js';
import { logError } from './log.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 请求关联 id：一次请求里各处埋点都带上它，日志里才能把「这一次调用」串成一串。
 * 没有它的话，一条 auth.login.failed 和随后的 http.error 只能靠时间戳猜是不是同一件事，
 * 并发一高就彻底对不上了。
 *
 * 8 个十六进制字符：够一段时间内不撞车，又短到能让人从终端里一眼抄下来。
 * 同时回写到响应头 X-Request-Id —— 用户报障时把这一串念出来，就能直接定位到那几行日志。
 */
function requestId(req, res, next) {
  req.id = randomBytes(4).toString('hex');
  res.set('X-Request-Id', req.id);
  next();
}

/** Builds the Express app. Seeding and listening are the caller's job (see index.js). */
/**
 * 跨域策略。默认部署形态是后端直接托管 web/dist，前后端同源，压根不需要 CORS，
 * 所以生产环境默认不发跨域头；要把前端单独部署到别的域名时用 CORS_ORIGIN 显式放行。
 * 非生产环境保持放开，免得打断现有的本地开发流程。
 */
function corsPolicy() {
  const allowed = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length) return cors({ origin: allowed, credentials: true });
  if (process.env.NODE_ENV === 'production') return cors({ origin: false });
  return cors();
}

/**
 * `clientDist` 只为测试留的缝：默认就是 `web/dist`，生产上没人传它。
 * 和既有的 `serveClient` 同一个性质 —— 用例要验的是静态托管这段真实代码，
 * 而不是「构建产物碰巧在不在」。有了它，pwa-static.test.js 可以自己造一个
 * 临时 dist 目录，跑的是同一条 express.static + catch-all，不依赖 npm run build。
 */
export function createApp({ serveClient = true, clientDist } = {}) {
  const app = express();
  // 生产环境通常在 Nginx/Caddy 后面，要拿到真实来源 IP 才能按 IP 限流。
  // 默认关闭：开着而前面没有反代时，X-Forwarded-For 可以被随意伪造。
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use(requestId);
  app.use(corsPolicy());
  app.use(express.json({ limit: '1mb' }));
  // 上传目录和聊天系统同源，回源头必须自己钉死：图片按 image/* 内联，其余强制下载。
  // 少了这一步，一份 .html 附件就是一个同源、能读 localStorage 里 token 的页面（issue #22）。
  //
  // 这里不再是 express.static：对象可能在本地磁盘，也可能在只对内网开放的 MinIO 里，
  // 而且现在要先过一道「你是不是该附件所在会话的成员」。两件事都收在这个 router 里，
  // 安全头仍然是同一个 setUploadHeaders（见 routes/upload-files.js 顶部那段说明）。
  app.use('/uploads', uploadFileRoutes);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/stream', authenticate, (req, res) => subscribe(req.user.id, res));
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/conversations', conversationRoutes);
  app.use('/api/messages', searchRoutes);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/ai', aiRoutes);

  // Serve the built frontend when it exists, so `npm start` is enough in production.
  const dist = clientDist || join(here, '..', '..', 'web', 'dist');
  if (serveClient && existsSync(dist)) {
    const swPath = join(dist, 'sw.js');
    app.use(express.static(dist, {
      setHeaders: (res, filePath) => {
        // Service Worker 脚本永远不许被缓存住：它是所有后续更新的唯一入口。
        // 一旦被浏览器或中间层缓存住，用户就卡在一个再也换不掉的旧 SW 上 ——
        // 推送逻辑改了也推不下去，而且这种故障没有任何症状能指向缓存。
        //
        // 是 no-cache 不是 no-store：no-cache 的语义是「可以存，但每次都回源校验」，
        // 命中 304 时一个字节都不传。写成 no-store 会让每次启动都整份重下，
        // 平白多一次往返，换不来任何新鲜度。
        //
        // 只认 dist 根下那一个 sw.js —— 注册时 scope 是 '/'，只有它才是那个入口。
        // 其余资源不动：Vite 产物文件名带 hash，默认的 public, max-age=0 现状没问题。
        if (filePath === swPath) res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    // 末段带扩展名 = 在要一份文件，不是在走前端路由。SPA 的路径不带点。
    const LOOKS_LIKE_A_FILE = /\/[^/]*\.[^/]*$/;
    // catch-all 排在 express.static 后面，文件真的存在时轮不到它，
    // 所以下面这段只在**文件不存在**时才生效。
    //
    // 不加这道判断的话，缺了构建产物的 `GET /sw.js` 会拿到 200 + index.html，
    // 浏览器报的是「The script has an unsupported MIME type ('text/html')」——
    // 指向 MIME，真正的原因却是文件根本没生成。同理一份引用了已删除 chunk 的
    // 陈旧 index.html，会让 `/assets/index-<hash>.js` 也变成一份 HTML 冒充的 JS。
    // 200 的假货比 404 难查十倍，所以凡是「在要文件」的路径一律放行到 404，
    // 不只是 /sw.js 和 /manifest.webmanifest 这两个（它们同样落在这条规则里）。
    app.get(/^(?!\/api|\/uploads).*/, (req, res, next) => {
      if (LOOKS_LIKE_A_FILE.test(req.path)) return next();  // 交给 express 默认的 404
      res.sendFile(join(dist, 'index.html'));
    });
  }

  app.use((err, req, res, _next) => {
    // multer 超限只给英文的 File too large，这里统一翻成中文并按 413 返回。
    // 走到这一层的只有**硬上限**（分档里最大的那个，也就是视频的 100MB）：
    // 图片/普通文件那档 8MB 的判定要等嗅探出真实类型之后才做得了，在路由里，
    // 那条路自己返回 413 + OVERSIZED_MESSAGE。说明见 upload-middleware.js。
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: VIDEO_OVERSIZED_MESSAGE });
    const status = err.status || 500;
    // 只记 5xx：4xx 是调用方自己传错了参数，量大且没有排查价值，全记下来只会淹掉真正的故障。
    if (status >= 500) logError('http.error', err, { reqId: req.id, method: req.method, path: req.path, status });
    res.status(status).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}
