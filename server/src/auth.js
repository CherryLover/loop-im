import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { get, run, now, uid } from './db.js';
import { logWarn } from './log.js';

// 代码是公开的，所以开发用的默认密钥只能在非生产环境使用：
// 生产环境必须显式提供 JWT_SECRET，否则任何人都能用已知的默认值伪造 token。
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('生产环境必须设置 JWT_SECRET（见 server/.env.example）');
}
const SECRET = process.env.JWT_SECRET || 'loop-im-dev-secret-change-me';
export const TOKEN_DAYS = 15;                 // "保持登录 15 天"
export const SESSION_TOKEN_DAYS = 1;          // 不保持登录时只发一天的会话凭据
export const ONLINE_WINDOW_MS = 90 * 1000;    // a client that pinged within this window counts as online

export const tokenDaysFor = (remember) => (remember ? TOKEN_DAYS : SESSION_TOKEN_DAYS);

/**
 * 一张登录凭据带三样东西：
 * - ver：账号的登录版本，改密码时 +1，让之前发出去的 token 全部作废
 * - sid：本次登录的会话，主动退出后会话被删除，这张 token 立刻失效
 * - 有效期：勾选「保持登录」15 天，否则只发一天的会话凭据
 */
export const signToken = (user, { remember = true, sessionId = null } = {}) =>
  jwt.sign(
    { sub: user.id, role: user.role, ver: user.auth_version, sid: sessionId },
    SECRET,
    { expiresIn: `${tokenDaysFor(remember)}d` },
  );

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

// 一次性密码的字母表：去掉 0/O/1/l/I 这些抄下来容易看错的字符，
// 管理员是要把它念给或抄给本人的，认错一个字符就等于白重置一次。
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const GENERATED_PASSWORD_LENGTH = 16;

/** 随机一次性密码。用 crypto 的均匀取样，不用 Math.random——这串就是账号的全部凭据。 */
export function generatePassword(length = GENERATED_PASSWORD_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

/**
 * 管理员重置他人密码：换掉哈希、auth_version +1（此前签发的 token 全部作废），
 * 再删掉该账号的全部会话，让所有设备立刻掉线——重置的意义就是夺回账号控制权。
 * 注意这跟本人改密码（routes/auth.js 的 /me/password）不同：那里要留住当前会话并换发
 * 新 token，所以不能共用这个函数。
 */
export function resetPasswordFor(userId, plain) {
  run(
    'UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?',
    hashPassword(plain), userId,
  );
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

/** 账号被停用时，所有入口统一这么说——不要跟「密码不对」混为一谈。 */
export const ACCOUNT_DISABLED = '账号已停用，请联系管理员';

export const isDisabled = (user) => !!user?.disabled_at;

/**
 * 停用账号：复用重置密码那一套「立刻夺回控制权」的手法（见 resetPasswordFor）——
 * auth_version +1 让此前签发的 token 全部作废，再删掉该账号的全部会话，
 * 于是所有设备当场掉线，不用等 token 自然过期。
 *
 * 除此之外还多两件事：
 * - 打上 disabled_at，让 authenticate / login 有一个独立的、跟密码无关的拒绝理由；
 *   光靠 auth_version 只能踢掉旧凭据，用正确的密码重新登录照样能进来。
 * - last_seen_at 归零，在线点当场灭掉，不用等 90 秒心跳窗口过期。
 *
 * 注意这里不动 password_hash：停用是可逆的，恢复之后原密码要照常能用。
 */
export function disableUser(userId) {
  run(
    'UPDATE users SET disabled_at = ?, auth_version = auth_version + 1, last_seen_at = 0 WHERE id = ?',
    now(), userId,
  );
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

/**
 * 恢复账号：只把 disabled_at 抹掉，其余一概不动。
 * 不需要再动 auth_version —— 停用时那一次 +1 已经把旧凭据全作废了，
 * 本人重新登录一次即可，密码、头像、群成员身份、聊天记录全都还是原来的。
 */
export function enableUser(userId) {
  run('UPDATE users SET disabled_at = NULL WHERE id = ?', userId);
}

export function touch(userId, sessionId) {
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), userId);
  if (sessionId) run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), sessionId);
}

// 停用的账号一律显示为离线：它连不上来，last_seen_at 也已经被 disableUser 归零，
// 这里再挡一道，免得哪天有别的路径顺手 touch 了它就又冒出一个在线点。
export const isOnline = (user) =>
  !isDisabled(user) && (user.role === 'ai' || now() - (user.last_seen_at || 0) < ONLINE_WINDOW_MS);

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.query.token || null;
}

/**
 * 凭据被拒时记一行，reason 说明是哪一道闸门拦的。
 *
 * 唯独不记「压根没带 token」：那是匿名请求，前端没登录时每次刷新都来一发，
 * 量大且什么也说明不了。这里要的是「拿着一张凭据却被拒」——过期、被改密码顶掉、
 * 会话已退出、账号被停用，这几种才是用户会来报障、而我们需要能解释的情况。
 */
const rejectAuth = (req, res, reason, message, userId = null) => {
  logWarn('auth.credential.rejected', { reqId: req.id, ip: req.ip, userId, reason, path: req.path });
  return res.status(401).json({ error: message });
};

export function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: '未登录' });
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return rejectAuth(req, res, 'token_invalid', '登录已过期，请重新登录');
  }
  const user = get('SELECT * FROM users WHERE id = ?', payload.sub);
  if (!user) return rejectAuth(req, res, 'user_gone', '账号不存在', payload.sub);
  // 账号停用挡在所有鉴权入口的最前面。这里是全站唯一的鉴权中间件（/api/stream 与
  // 每个 router 都 use 它），挡在这一层等于一次挡住已登录会话、SSE、上传、改密码……
  // 而不是只挡 /auth/login。
  //
  // 走到这一步说明 token 是本服务签发的（jwt.verify 已过），所以拿着它的人本来就
  // 持有过这个账号的凭据，明说「已停用」不算泄露，反倒省得他以为是网络抖动一直重试。
  //
  // 用 401 而不是 403：前端 request() 只在 401 时清本地凭据并把人送回登录页
  // （见 web/src/lib/api.ts），停用要的正是这个效果。放在 ver 校验之前，是为了让
  // disabled_at 成为一道独立于 token 新旧的闸门——即使哪天签发逻辑变了，这一条也照样拦。
  if (isDisabled(user)) return rejectAuth(req, res, 'account_disabled', ACCOUNT_DISABLED, user.id);
  // 版本号对不上的凭据一律失效（issue #2），但拒绝的理由要分开说（issue #16）：
  // - ver 不是整数（升级前签发的老 token 根本没有这个字段，也可能是 null / 字符串这类
  //   被篡改的值）：signToken 永远写入 users.auth_version 这个整数，所以拿不到整数就说明
  //   这张凭据不是本服务当前这版签发的，无法证明用户改过密码——只能说它过期了。
  // - ver 是整数但和当前版本对不上：这是本服务签发过的版本号，被一次改密码顶掉了，
  //   说「密码已修改」才是准确归因（比当前版本更高的整数只可能来自篡改，同样归到这一档，
  //   反正两条分支都是 401，不会因此放行）。
  if (!Number.isInteger(payload.ver)) {
    return rejectAuth(req, res, 'token_version_missing', '登录已过期，请重新登录', user.id);
  }
  if (payload.ver !== user.auth_version) {
    return rejectAuth(req, res, 'password_changed', '密码已修改，请重新登录', user.id);
  }
  // sid 指向本次登录的会话，主动退出后会话已删除，旧 token 不能再用。
  // 注意：升级前签发的 token 既没有 sid 也没有 ver，上面那道 ver 校验已经把它们挡掉了，
  // 也就是这次升级后所有人需要重新登录一次。
  if (payload.sid && !get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', payload.sid, user.id)) {
    return rejectAuth(req, res, 'session_ended', '登录已过期，请重新登录', user.id);
  }
  req.user = user;
  req.sessionId = payload.sid || null;
  // 记下这张凭据是「保持登录」还是「仅本次会话」，换发时沿用同一档有效期。
  req.tokenRemember = payload.exp - payload.iat > SESSION_TOKEN_DAYS * 24 * 3600;
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
  // 停用的人照常出现在名单、群成员和历史消息里（停用不是删除），只是打上这个标记，
  // 前端据此显示「已停用」，并把他从「建群 / 加成员」的可选名单里去掉。
  disabled: isDisabled(u),
});
