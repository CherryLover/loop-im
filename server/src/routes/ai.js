import { Router } from 'express';
import { all, get } from '../db.js';
import { authenticate, requireAdmin } from '../auth.js';
import { AI_ID, PROVIDERS, isConfigured, providerOf, saveSettings, settings, testConnectivity } from '../ai.js';

export const router = Router();
router.use(authenticate, requireAdmin);

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const settingsPayload = () => {
  const s = settings();
  const p = providerOf(s.provider);
  return {
    provider: s.provider,
    hasApiKey: !!s.api_key,
    configured: isConfigured(s),
    providers: PROVIDERS.map(({ key, name, note, model }) => ({ key, name, note, model })),
    rules: { silentRead: !!s.silent_read, replyAtAll: !!s.reply_at_all, allowDm: !!s.allow_dm },
    statusLine: `${p.label} ${isConfigured(s) ? '已连接' : '未配置凭据（本地模拟回复）'} · 群聊静默读取${s.silent_read ? '开启' : '关闭'}`,
  };
};

router.get('/settings', (_req, res) => res.json(settingsPayload()));

router.put('/settings', (req, res) => {
  const body = req.body || {};
  saveSettings({
    provider: PROVIDERS.some((p) => p.key === body.provider) ? body.provider : undefined,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    silentRead: typeof body.silentRead === 'boolean' ? body.silentRead : undefined,
    replyAtAll: typeof body.replyAtAll === 'boolean' ? body.replyAtAll : undefined,
    allowDm: typeof body.allowDm === 'boolean' ? body.allowDm : undefined,
  });
  res.json(settingsPayload());
});

router.post('/test', async (_req, res) => res.json(await testConnectivity()));

// 「AI 管理」列表：今日被 @ 次数、关键信息点，以及 Aria 正在跟踪的对话对象。
router.get('/overview', (_req, res) => {
  const today = startOfToday();
  const mentioned = all('SELECT mentions FROM messages WHERE created_at >= ?', today)
    .map((r) => JSON.parse(r.mentions || '[]'));
  const atAria = mentioned.filter((m) => m.includes(AI_ID)).length;
  const atAll = mentioned.filter((m) => m.includes('all')).length;

  const rows = all(
    `SELECT p.*, u.name, u.avatar_url, u.role,
            (SELECT max(created_at) FROM messages WHERE sender_id = p.user_id) AS last_at
     FROM ai_profiles p JOIN users u ON u.id = p.user_id
     ORDER BY last_at DESC NULLS LAST`,
  ).map((r) => ({
    userId: r.user_id,
    name: r.name,
    avatarUrl: r.avatar_url || null,
    scene: r.scene,
    summary: r.summary,
    keys: JSON.parse(r.keys || '[]'),
    lastActiveAt: r.last_at || r.updated_at,
  }));

  res.json({
    ...settingsPayload(),
    stats: [
      { key: 'mentions', label: '今日被 @ 次数', value: String(atAria + atAll), note: `其中 @全员 ${atAll}` },
      {
        key: 'points', label: '关键信息点',
        value: String(rows.reduce((n, r) => n + r.keys.length, 0)),
        note: `来自 ${rows.length} 位成员`,
      },
    ],
    rows,
  });
});

// 二级页：先给 AI 推导出的偏好与习惯，再按需展开原始对话。
router.get('/profiles/:userId', (req, res) => {
  const row = get(
    `SELECT p.*, u.name, u.avatar_url FROM ai_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?`,
    req.params.userId,
  );
  if (!row) return res.status(404).json({ error: '暂无该成员的画像' });

  const raw = all(
    `SELECT m.body, m.created_at, u.name FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id IN (
       SELECT a.conversation_id FROM conversation_members a
       JOIN conversation_members b ON b.conversation_id = a.conversation_id AND b.user_id = ?
       WHERE a.user_id = ?
     ) AND m.sender_id IN (?, ?)
     ORDER BY m.created_at DESC LIMIT 20`,
    AI_ID, req.params.userId, req.params.userId, AI_ID,
  ).reverse();

  res.json({
    profile: {
      userId: row.user_id,
      name: row.name,
      avatarUrl: row.avatar_url || null,
      scene: row.scene,
      summary: row.summary,
      note: row.note,
      habits: JSON.parse(row.habits || '[]'),
      keys: JSON.parse(row.keys || '[]'),
      lastActiveAt: row.updated_at,
    },
    raw: raw.map((r) => ({ name: r.name, text: r.body, createdAt: r.created_at })),
  });
});
