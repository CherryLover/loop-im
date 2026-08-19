import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { get, run, now, uid } from './db.js';

// 代码是公开的，所以开发用的默认密钥只能在非生产环境使用：
// 生产环境必须显式提供 JWT_SECRET，否则任何人都能用已知的默认值伪造 token。
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('生产环境必须设置 JWT_SECRET（见 server/.env.example）');
}
const SECRET = process.env.JWT_SECRET || 'loop-im-dev-secret-change-me';
export const TOKEN_DAYS = 15;                 // "保持登录 15 天"
export const ONLINE_WINDOW_MS = 90 * 1000;    // a client that pinged within this window counts as online

export const signToken = (user, sessionId) =>
  jwt.sign({ sub: user.id, role: user.role, sid: sessionId }, SECRET, { expiresIn: `${TOKEN_DAYS}d` });

/** 新登录建一条会话；顺手清掉 token 早已过期的旧会话，免得表越滚越大。 */
export function createSession(userId) {
  run('DELETE FROM sessions WHERE created_at < ?', now() - TOKEN_DAYS * 24 * 60 * 60 * 1000);
  const id = uid('s');
  run('INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)', id, userId, now(), now());
  return id;
}

/** 主动退出：结束本次会话，返回该账号是否还有别的设备在线。 */
export function endSession(userId, sessionId) {
  if (sessionId) run('DELETE FROM sessions WHERE id = ? AND user_id = ?', sessionId, userId);
  const rest = get(
    'SELECT count(*) AS n FROM sessions WHERE user_id = ? AND last_seen_at > ?',
    userId, now() - ONLINE_WINDOW_MS,
  );
  return rest.n > 0;
}

export const hashPassword = (plain) => bcrypt.hashSync(plain, 10);
export const verifyPassword = (plain, hash) => !!hash && bcrypt.compareSync(plain, hash);

export function touch(userId, sessionId) {
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), userId);
  if (sessionId) run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), sessionId);
}

export const isOnline = (user) =>
  user.role === 'ai' || now() - (user.last_seen_at || 0) < ONLINE_WINDOW_MS;

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.query.token || null;
}

export function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: '未登录' });
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  const user = get('SELECT * FROM users WHERE id = ?', payload.sub);
  if (!user) return res.status(401).json({ error: '账号不存在' });
  // sid 指向本次登录的会话，主动退出后会话已删除，旧 token 不能再用。
  // 升级前签发的 token 没有 sid，仍然放行，避免升级后把所有人踢下线。
  if (payload.sid && !get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', payload.sid, user.id)) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
  req.user = user;
  req.sessionId = payload.sid || null;
  touch(user.id, req.sessionId);
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  dept: u.dept,
  role: u.role,
  avatarUrl: u.avatar_url || null,
  isAI: u.role === 'ai',
  online: isOnline(u),
});
