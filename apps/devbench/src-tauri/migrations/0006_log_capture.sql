-- Persisted source *config* only — no runtime state column. Live/error/
-- exited status is recomputed every time a source is (re-)added, including
-- on startup restore, so it can never be stale-loaded from disk.
CREATE TABLE log_sources (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- 'file' | 'command'
  path       TEXT,                 -- kind = 'file'
  program    TEXT,                 -- kind = 'command'
  args       TEXT,                 -- kind = 'command', JSON array
  cwd        TEXT,                 -- kind = 'command', optional
  created_at TEXT NOT NULL
);

-- `id` is the SAME id space LogState's in-memory buffers use, not a
-- separate SQLite-assigned identity, so a line's id means the same thing
-- whether it's read from the live buffer or from history.
--
-- Not cascade-deleted when a source is removed: removing a source stops
-- new capture, it doesn't erase that source's history from Search.
CREATE TABLE log_lines (
  id             INTEGER PRIMARY KEY,
  source_id      TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  timestamp      TEXT,
  level          TEXT,
  message        TEXT NOT NULL,
  raw            TEXT NOT NULL
);
CREATE INDEX idx_log_lines_source_id ON log_lines (source_id);
CREATE INDEX idx_log_lines_captured_at_ms ON log_lines (captured_at_ms);
