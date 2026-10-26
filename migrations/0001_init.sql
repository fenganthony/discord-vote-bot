-- 伺服器設定
CREATE TABLE guild_config (
  guild_id      TEXT PRIMARY KEY,
  admin_role_id TEXT,              -- 投票管理員身分組（除了「管理伺服器」權限外，也可管理投票）
  check_role_id TEXT,              -- 9-1 預設檢查是否投票的身分組
  tag_role_id   TEXT,              -- 9-3/9-4 未投票者要被加入的標記身分組
  auto_tag      INTEGER NOT NULL DEFAULT 0, -- 截止時自動標記未投票者
  timezone      TEXT NOT NULL DEFAULT 'Asia/Taipei',
  sheet_id      TEXT               -- Google 試算表 ID
);

CREATE TABLE polls (
  id            TEXT PRIMARY KEY,  -- 6 碼短 ID
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  message_id    TEXT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  deadline_at   INTEGER NOT NULL,  -- epoch ms
  check_role_id TEXT,              -- 覆寫伺服器預設的檢查身分組
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER
);
CREATE INDEX idx_polls_guild ON polls (guild_id, status, created_at);
CREATE INDEX idx_polls_deadline ON polls (status, deadline_at);

CREATE TABLE poll_options (
  poll_id        TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  label          TEXT NOT NULL,
  emoji_id       TEXT,
  emoji_name     TEXT,
  emoji_animated INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL CHECK (kind IN ('class', 'leave')),
  PRIMARY KEY (poll_id, idx)
);

CREATE TABLE votes (
  poll_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  option_idx   INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  reason       TEXT,
  voted_at     INTEGER NOT NULL,   -- 第一次投票時間
  updated_at   INTEGER NOT NULL,   -- 最後改票時間
  PRIMARY KEY (poll_id, user_id)
);

-- 被 bot 加上標記身分組的人（補投或 /vote untag 時移除）
CREATE TABLE tagged (
  poll_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);

CREATE TABLE templates (
  guild_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  options_text TEXT NOT NULL,
  PRIMARY KEY (guild_id, name)
);

-- /vote create 到 Modal 送出之間的暫存（圖片、頻道等斜線指令參數）
CREATE TABLE pending (
  nonce      TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
