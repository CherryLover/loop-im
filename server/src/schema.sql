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

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,                       -- group | dm | ai
  title      TEXT,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,                  -- Markdown
  mentions        TEXT NOT NULL DEFAULT '[]',     -- JSON array of user ids, 'all' for @全员
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, created_at);

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
