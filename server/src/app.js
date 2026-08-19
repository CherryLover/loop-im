import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPLOAD_DIR } from './db.js';
import { authenticate } from './auth.js';
import { subscribe } from './events.js';
import { OVERSIZED_MESSAGE } from './upload-middleware.js';
import { router as authRoutes } from './routes/auth.js';
import { router as userRoutes } from './routes/users.js';
import { router as conversationRoutes } from './routes/conversations.js';
import { router as uploadRoutes } from './routes/uploads.js';
import { router as aiRoutes } from './routes/ai.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Builds the Express app. Seeding and listening are the caller's job (see index.js). */
export function createApp({ serveClient = true } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));

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
