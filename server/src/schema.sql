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
  disabled_at   INTEGER,                          -- 账号停用时刻；NULL = 正常。停用不删数据
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

-- 消息表情回应：谁给哪条消息点了哪个表情。
--
-- 唯一性（同一个人 × 同一条消息 × 同一个表情只有一行）故意不写成 PRIMARY KEY，
-- 而是 db.js 的 MIGRATIONS 里那条具名唯一索引：CREATE TABLE IF NOT EXISTS 对已经
-- 存在的表什么也不做，约束写在建表语句里的话，老库永远补不上它。
--
-- emoji 存原样的 UTF-8 文本（👍 是 4 字节，❤️ 还带变体选择符），SQLite 的 TEXT 默认
-- BINARY 比较，整串逐字节比，不会按字节截断；写入前由 reactions.js 的白名单归一。
-- message_id 上的 ON DELETE CASCADE 保证消息删掉时回应跟着走，不留孤儿。
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 「这个附件出现在哪个会话里」。附件的下载鉴权全靠它。
--
-- 为什么要单独一张表而不是往 attachments 上加一列 conversation_id：
-- 上传和发送是两步（Composer 选中文件的那一刻就传了），一个对象**可能**最终没被发送、
-- 也可能被同一个人转发进多个会话。一对多只能用关联表表达；加一列的话，
-- 转发到第二个会话时要么覆盖掉第一个（第一个群的人当场看不到图了），要么写不进去。
--
-- key 是对象 key（`/uploads/<key>` 里的那一段），不存完整 url：url 只是 key 的一层包装。
-- message_id 带 ON DELETE CASCADE，消息没了引用跟着走，孤儿清理才能真的把对象回收掉。
-- 唯一索引与回填见 db.js 的 MIGRATIONS。
CREATE TABLE IF NOT EXISTS attachment_refs (
  key             TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL
);

-- 迁移的一次性标记位。CREATE TABLE IF NOT EXISTS 挡不住「数据回填」这类迁移重复执行
-- （它不是加列，没有 PRAGMA table_info 可查），所以用这张表记「跑过了」。
CREATE TABLE IF NOT EXISTS schema_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 退役的 Aria 留下的两张表（ai_settings / ai_profiles）不再创建：新库用不上，
-- 老库里的那两张原样保留、不再读写（见 docs/hapi-Agent-接入方案.md §F）。
