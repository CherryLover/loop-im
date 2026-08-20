import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPLOAD_DIR } from './db.js';
import { authenticate } from './auth.js';
import { subscribe } from './events.js';
import { setUploadHeaders } from './attachments.js';
import { OVERSIZED_MESSAGE } from './upload-middleware.js';
import { router as authRoutes } from './routes/auth.js';
import { router as userRoutes } from './routes/users.js';
import { router as conversationRoutes } from './routes/conversations.js';
import { router as uploadRoutes } from './routes/uploads.js';
import { router as aiRoutes } from './routes/ai.js';

const here = dirname(fileURLToPath(import.meta.url));

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

export function createApp({ serveClient = true } = {}) {
  const app = express();
  // 生产环境通常在 Nginx/Caddy 后面，要拿到真实来源 IP 才能按 IP 限流。
  // 默认关闭：开着而前面没有反代时，X-Forwarded-For 可以被随意伪造。
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use(corsPolicy());
  app.use(express.json({ limit: '1mb' }));
  // 上传目录和聊天系统同源，回源头必须自己钉死：图片按 image/* 内联，其余强制下载。
  // 少了这一步，一份 .html 附件就是一个同源、能读 localStorage 里 token 的页面（issue #22）。
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h', setHeaders: setUploadHeaders }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/stream', authenticate, (req, res) => subscribe(req.user.id, res));
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/conversations', conversationRoutes);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/ai', aiRoutes);

  // Serve the built frontend when it exists, so `npm start` is enough in production.
  const dist = join(here, '..', '..', 'web', 'dist');
  if (serveClient && existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api|\/uploads).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  app.use((err, _req, res, _next) => {
    if (process.env.NODE_ENV !== 'test') console.error(err);
    // multer 超限只给英文的 File too large，这里统一翻成中文并按 413 返回。
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: OVERSIZED_MESSAGE });
    res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}
