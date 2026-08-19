import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import {
  authenticate, hashPassword, isOnline, publicUser, signToken, TOKEN_DAYS, touch, verifyPassword,
} from '../auth.js';
import { putObject } from '../storage.js';
import { AI_NAME, providerOf, settings } from '../ai.js';
import { upload } from '../upload-middleware.js';
import { emitAll } from '../events.js';

export const router = Router();

// AI facts every member may see; the full configuration stays in /api/ai (admin only).
const aiPublicInfo = () => {
  const s = settings();
  return {
    name: AI_NAME,
    providerLabel: providerOf(s.provider).label,
    silentRead: !!s.silent_read,
    allowDm: !!s.allow_dm,
  };
};

router.post('/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = get('SELECT * FROM users WHERE lower(email) = ? AND role != ?', email, 'ai');
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '邮箱或密码不正确' });
  }
  touch(user.id);
  emitAll('presence', { userId: user.id, online: true });
  res.json({
    token: signToken(user),
    tokenDays: TOKEN_DAYS,
    user: publicUser({ ...user, last_seen_at: now() }),
    ai: aiPublicInfo(),
  });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user), ai: aiPublicInfo() });
});

// Heartbeat: keeps the 在线/离线 dot honest without a socket per tab.
router.post('/ping', authenticate, (req, res) => {
  res.json({ online: true, users: all('SELECT * FROM users').map(publicUser) });
});

router.patch('/me', authenticate, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '昵称不能为空' });
  run('UPDATE users SET name = ? WHERE id = ?', name, req.user.id);
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  emitAll('user-updated', { user: publicUser(user) });
  res.json({ user: publicUser(user) });
});

router.post('/me/avatar', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' });
  const { url } = await putObject({ buffer: req.file.buffer, filename: req.file.originalname, mime: req.file.mimetype });
  run('UPDATE users SET avatar_url = ? WHERE id = ?', url, req.user.id);
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  emitAll('user-updated', { user: publicUser(user) });
  res.json({ user: publicUser(user) });
});

router.post('/me/password', authenticate, (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (!verifyPassword(current, req.user.password_hash)) return res.status(400).json({ error: '当前密码不正确' });
  if (next.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  // auth_version +1：其他设备上改密码之前签发的 token 立刻失效，
  // 当前设备换发一张新 token，不至于把自己也踢下线。
  run(
    'UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?',
    hashPassword(next), req.user.id,
  );
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json({ ok: true, token: signToken(user), tokenDays: TOKEN_DAYS });
});

export { isOnline };
