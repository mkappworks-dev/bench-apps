-- One row per open tab instance. `session_id IS NULL` is the unnamed scratch
-- workspace shown when no session is selected — it behaves exactly like a
-- session's workspace (shell design spec, "Tab persistence").
--
-- ON DELETE CASCADE, unlike request_history's ON DELETE SET NULL
-- (0003_session_scoped_history.sql): a tab's pane/ordinal/state describe a
-- workspace layout that belongs entirely to one session. There is nothing
-- sensible to orphan it into once that session is gone — unlike a request
-- log entry, a dangling tab has no meaning on its own. Enforced because
-- sqlx-sqlite issues `PRAGMA foreign_keys = ON` by default.
CREATE TABLE tabs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  pane        TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  state       TEXT
);

-- The read path is always `WHERE session_id IS ? ORDER BY pane, ordinal`.
CREATE INDEX idx_tabs_session_pane_ordinal ON tabs (session_id, pane, ordinal);
