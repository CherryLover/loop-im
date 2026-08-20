import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import { authenticate, generatePassword, hashPassword, publicUser, requireAdmin, resetPasswordFor } from '../auth.js';
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

/**
 * 管理员重置成员密码：这是忘了密码之后唯一的入口（本系统发不了邮件，没有邮箱找回）。
 * 新密码只在这次响应里出现一次，管理员抄给本人；服务端不留明文。
 */
router.post('/:id/reset-password', requireAdmin, (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).json({ error: '成员不存在' });
  // 自己的密码走 /auth/me/password，那条要验旧密码；从这里绕过去等于少一道校验。
  if (target.id === req.user.id) {
    return res.status(400).json({ error: '不能重置自己的密码，请在个人设置里修改' });
  }
  if (target.role === 'ai') return res.status(400).json({ error: 'AI 账号没有密码' });

  const password = generatePassword();
  resetPasswordFor(target.id, password);
  // 所有设备已被踢下线，在线点也跟着灭掉，不用等 90 秒心跳窗口过期。
  run('UPDATE users SET last_seen_at = 0 WHERE id = ?', target.id);
  emitAll('presence', { userId: target.id, online: false });
  res.json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', target.id)), password });
});
