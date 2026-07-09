-- Vira messenger — D1 schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- uuid
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,      -- PBKDF2-SHA256 hash
  password_salt TEXT NOT NULL,
  avatar_color TEXT DEFAULT '#B8D8D8', -- pastel accent for avatar
  created_at INTEGER NOT NULL,      -- unix ms
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,              -- uuid
  type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
  name TEXT,                        -- null for direct chats (derived from members)
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  joined_at INTEGER NOT NULL,
  last_read_message_id TEXT,        -- for unread counts
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (chat_id) REFERENCES chats(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,              -- uuid
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (chat_id) REFERENCES chats(id),
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
