import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { get, run, now } from './db.js';

// 代码是公开的，所以开发用的默认密钥只能在非生产环境使用：
// 生产环境必须显式提供 JWT_SECRET，否则任何人都能用已知的默认值伪造 token。
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('生产环境必须设置 JWT_SECRET（见 server/.env.example）');
}
const SECRET = process.env.JWT_SECRET || 'loop-im-dev-secret-change-me';
export const TOKEN_DAYS = 15;                 // "保持登录 15 天"
export const ONLINE_WINDOW_MS = 90 * 1000;    // a client that pinged within this window counts as online

// ver 是账号当前的登录版本：改密码会让它 +1，于是之前发出去的 token 全部作废。
export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, ver: user.auth_version }, SECRET, { expiresIn: `${TOKEN_DAYS}d` });

export const hashPassword = (plain) => bcrypt.hashSync(plain, 10);
export const verifyPassword = (plain, hash) => !!hash && bcrypt.compareSync(plain, hash);

export function touch(userId) {
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), userId);
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
  // 没有版本号、版本号对不上（改过密码、或被伪造）的凭据一律当作已失效。
  if (payload.ver !== user.auth_version) {
    return res.status(401).json({ error: '密码已修改，请重新登录' });
  }
  req.user = user;
  touch(user.id);
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
