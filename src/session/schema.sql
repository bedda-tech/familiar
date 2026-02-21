CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT DEFAULT (datetime('now')),
  message_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  cost_usd REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
