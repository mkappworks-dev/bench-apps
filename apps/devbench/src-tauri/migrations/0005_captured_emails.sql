-- `session_id`/`request_id`'s ON DELETE SET NULL, like 0003 and 0004's own
-- foreign keys, is only enforceable because sqlx-sqlite issues
-- `PRAGMA foreign_keys = ON` by default.
CREATE TABLE captured_emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  request_id   TEXT REFERENCES request_history(id) ON DELETE SET NULL,
  captured_at  INTEGER NOT NULL,
  from_addr    TEXT NOT NULL,
  to_addrs     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  html_body    TEXT,
  text_body    TEXT,
  raw          TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL
);

CREATE INDEX idx_captured_emails_session ON captured_emails (session_id, captured_at DESC);
CREATE INDEX idx_captured_emails_request ON captured_emails (request_id);

CREATE TABLE captured_emails_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  evicted_through_id  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO captured_emails_state (id, evicted_through_id) VALUES (1, 0);
