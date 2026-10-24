CREATE TABLE saved_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '[]',
  body TEXT,
  body_type TEXT NOT NULL DEFAULT 'none',
  auth TEXT NOT NULL DEFAULT '{"type":"none"}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_saved_requests_session_updated
  ON saved_requests (session_id, updated_at DESC, id);
