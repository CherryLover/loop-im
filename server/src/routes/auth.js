import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import {
  ACCOUNT_DISABLED, authenticate, createSession, endSession, hashPassword, isDisabled, isOnline,
  publicUser, signToken, tokenDaysFor, touch, verifyPassword,
} from '../auth.js';
import { AVATAR_NOT_IMAGE, inspectUpload } from '../attachments.js';
import { putObject } from '../storage.js';
import { AI_NAME, providerOf, settings } from '../ai.js';
import { upload } from '../upload-middleware.js';
import { emitAll } from '../events.js';
import { clearFailures, recordFailure, retryAfterMs } from '../rate-limit.js';

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
  // 只有显式传 false 才算"不保持登录"，老客户端不带这个字段时仍按 15 天签发。
  const remember = req.body?.remember !== false;

  // 按邮箱和来源 IP 两个维度限流：换 IP 撞同一账号会被前者挡住，
  // 单 IP 遍历不同账号会被后者挡住。只有失败才计数。
  const keys = [`email:${email}`, `ip:${req.ip}`];
  const wait = retryAfterMs(keys);
  if (wait > 0) {
    res.set('Retry-After', String(Math.ceil(wait / 1000)));
    return res.status(429).json({ error: `登录尝试过于频繁，请 ${Math.ceil(wait / 60000)} 分钟后再试` });
  }

  const user = get('SELECT * FROM users WHERE lower(email) = ? AND role != ?', email, 'ai');
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(keys);
    return res.status(401).json({ error: '邮箱或密码不正确' });
  }
  clearFailures(keys);
  // 停用的判定放在验完密码之后，两个理由：
  // 1. 提示要准确 —— 密码明明是对的却回「邮箱或密码不正确」，本人只会一遍遍重试，
  //    还会去找管理员重置密码，白折腾一圈。这里要明说是账号被停用了。
  // 2. 顺序反过来就成了账号探针 —— 不知道密码的人也能靠这条错误确认某个邮箱存在、
  //    而且已停用。放在密码之后，只有本来就持有正确凭据的人才看得到这句话。
  if (isDisabled(user)) return res.status(403).json({ error: ACCOUNT_DISABLED });
  const sessionId = createSession(user.id);
  touch(user.id, sessionId);
  emitAll('presence', { userId: user.id, online: true });
  res.json({
    token: signToken(user, { remember, sessionId }),
    tokenDays: tokenDaysFor(remember),
    user: publicUser({ ...user, last_seen_at: now() }),
    ai: aiPublicInfo(),
  });
});

// 主动退出：结束本次会话。该账号没有别的设备在线时立刻置为离线并广播，
// 不用再等 90 秒的心跳窗口过期（关掉页面、断网、休眠仍然走那个兜底）。
router.post('/logout', authenticate, (req, res) => {
  const stillOnline = endSession(req.user.id, req.sessionId);
  if (!stillOnline) {
    run('UPDATE users SET last_seen_at = 0 WHERE id = ?', req.user.id);
    emitAll('presence', { userId: req.user.id, online: false });
  }
  res.json({ ok: true, online: stillOnline });
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

// 头像只走图片通道：它会被渲染成 <img>，必须是按真实字节确认过的图片（见 issue #22）。
router.post('/me/avatar', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' });
  const verdict = inspectUpload(req.file.buffer, req.file.mimetype);
  if (verdict.kind !== 'image') {
    return res.status(400).json({ error: verdict.kind === 'rejected' ? verdict.error : AVATAR_NOT_IMAGE });
  }
  const { url } = await putObject({ buffer: req.file.buffer, ext: verdict.ext, mime: verdict.mime });
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
  // 换发时沿用这台设备原本的有效期档位（保持登录 15 天 / 仅本次会话 1 天）。
  const remember = req.tokenRemember !== false;
  res.json({
    ok: true,
    token: signToken(user, { remember, sessionId: req.sessionId }),
    tokenDays: tokenDaysFor(remember),
  });
});

export { isOnline };
