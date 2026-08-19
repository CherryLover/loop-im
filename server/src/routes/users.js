import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import { authenticate, hashPassword, publicUser, requireAdmin } from '../auth.js';
import { emitAll } from '../events.js';
import { uid } from '../db.js';

export const router = Router();
router.use(authenticate);

// 系统内全部成员，无需加好友。
router.get('/', (req, res) => {
  res.json({ users: all('SELECT * FROM users ORDER BY role = ? DESC, created_at', 'ai').map(publicUser) });
});

// 管理员开通新成员账号。
router.post('/', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const dept = String(req.body?.dept || '').trim() || '成员';
  if (!name) return res.status(400).json({ error: '请填写姓名' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (get('SELECT 1 AS x FROM users WHERE lower(email) = ?', email)) {
    return res.status(409).json({ error: '该邮箱已开通' });
  }
  const initialPassword = String(req.body?.password || '').trim() || `loop-${Math.random().toString(36).slice(2, 8)}`;
  const id = uid('u');
  run(
    `INSERT INTO users (id, name, email, dept, role, password_hash, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, 'member', ?, 0, ?)`,
    id, name, email, dept, hashPassword(initialPassword), now(),
  );
  const user = publicUser(get('SELECT * FROM users WHERE id = ?', id));
  emitAll('user-created', { user });
  res.status(201).json({ user, initialPassword });
});
