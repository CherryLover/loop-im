import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import {
  authenticate, disableUser, enableUser, generatePassword, hashPassword, publicUser, requireAdmin,
  resetPasswordFor,
} from '../auth.js';
import { disconnect, emitAll } from '../events.js';
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

/**
 * 停用 / 恢复的共同前置校验。三条边界都在这里，两个接口共用一套说法。
 * 返回目标行；已经响应过就返回 null。
 */
function targetForStatusChange(req, res) {
  const target = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) {
    res.status(404).json({ error: '成员不存在' });
    return null;
  }
  // 管理员把自己停了就没人能再恢复了——这是个单向的死锁，必须在这里挡住。
  if (target.id === req.user.id) {
    res.status(400).json({ error: '不能停用自己的账号' });
    return null;
  }
  // Aria 本来就没有密码、登不了录，停用对它没有意义，只会让它从群里消失。
  if (target.role === 'ai') {
    res.status(400).json({ error: 'AI 账号不能停用' });
    return null;
  }
  return target;
}

/**
 * 停用账号：员工离职后不能再登录，但聊天记录、群成员身份、头像和名字全部留着。
 * 用的就是「管理员重置密码」那套立刻生效的手法（auth_version +1 且清空 sessions，
 * 见 auth.js 的 disableUser），所以他所有设备上的登录当场失效，不用等 token 过期。
 */
router.post('/:id/disable', requireAdmin, (req, res) => {
  const target = targetForStatusChange(req, res);
  if (!target) return;

  disableUser(target.id);
  // 已经建好的 SSE 连接不会再过一次 authenticate，得显式掐掉（见 events.js 的 disconnect）。
  disconnect(target.id);
  const user = publicUser(get('SELECT * FROM users WHERE id = ?', target.id));
  // 在线点当场灭掉；名单上的「已停用」标记也要立刻铺到所有人的界面上。
  emitAll('presence', { userId: target.id, online: false });
  emitAll('user-updated', { user });
  res.json({ user });
});

/** 恢复账号：抹掉停用标记，其余一概不动，本人用原密码重新登录即可。 */
router.post('/:id/enable', requireAdmin, (req, res) => {
  const target = targetForStatusChange(req, res);
  if (!target) return;

  enableUser(target.id);
  const user = publicUser(get('SELECT * FROM users WHERE id = ?', target.id));
  emitAll('user-updated', { user });
  res.json({ user });
});
