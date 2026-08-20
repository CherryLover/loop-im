PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  dept          TEXT NOT NULL DEFAULT '成员',
  role          TEXT NOT NULL DEFAULT 'member',   -- admin | member | ai
  password_hash TEXT,                             -- NULL for the AI account
  avatar_url    TEXT,
  auth_version  INTEGER NOT NULL DEFAULT 1,       -- 改密码时递增，之前签发的 token 立即失效
  last_seen_at  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 一次登录 = 一条会话（一台设备/一个浏览器）。主动退出时用它判断
-- 该账号是否还有别的设备在线，避免一处退出把别处也标成离线。
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_seen_at);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,                       -- group | dm | ai
  title      TEXT,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- 「用户 × 会话」这一维。除了成员关系本身，每个人对每个会话的个人偏好也挂在这里：
-- 置顶和免打扰都是「我」的设置，A 置顶某个群不会影响 B 看到的顺序。
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       INTEGER NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,     -- 我把它置顶了：只改会话列表的分组排序
  muted           INTEGER NOT NULL DEFAULT 0,     -- 我把它设为免打扰：只改「怎么提醒」，不改未读计数
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,                  -- Markdown
  mentions        TEXT NOT NULL DEFAULT '[]',     -- JSON array of user ids, 'all' for @全员
  ai_visible      INTEGER NOT NULL DEFAULT 1,     -- 发出时 AI 是否被允许读到这条消息
  kind            TEXT NOT NULL DEFAULT 'user',   -- user | system（成员变动等系统提示）
  reply_to        TEXT,                           -- 引用回复指向的原消息 id；不设外键，原消息没了要能降级显示
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, created_at);

-- 每个人在每个会话读到哪里。未读计数与已读回执共用这一张表：
-- 未读 = 该会话里比 last_read_at 更新、且不是自己发的消息条数。
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  filename   TEXT NOT NULL,
  url        TEXT NOT NULL,
  mime       TEXT,
  bytes      INTEGER,
  created_at INTEGER NOT NULL
);

-- Single-row table holding the system AI configuration.
CREATE TABLE IF NOT EXISTS ai_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  provider      TEXT NOT NULL DEFAULT 'gpt',
  api_key       TEXT NOT NULL DEFAULT '',
  silent_read   INTEGER NOT NULL DEFAULT 1,       -- read group context without being @-ed
  reply_at_all  INTEGER NOT NULL DEFAULT 0,       -- also reply on @全员
  allow_dm      INTEGER NOT NULL DEFAULT 1,       -- allow 1:1 chats with the AI
  updated_at    INTEGER NOT NULL
);

-- What the AI has learned about one person: habits & preferences, reused next time.
CREATE TABLE IF NOT EXISTS ai_profiles (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  scene       TEXT NOT NULL DEFAULT '群聊',
  summary     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  habits      TEXT NOT NULL DEFAULT '[]',         -- JSON array
  keys        TEXT NOT NULL DEFAULT '[]',         -- JSON array of key information points
  updated_at  INTEGER NOT NULL
);
