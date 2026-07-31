-- Sessions become a real scope for request history rather than a label.
--
-- Nullable, and NULL means "unattributed": a request fired with no active
-- session, or one that predates this migration. Those rows appear in the
-- unscoped view and in no named session. Existing rows land as NULL
-- automatically, which is why no backfill and no synthetic "legacy"
-- session are needed.
--
-- ON DELETE SET NULL: permanently deleting a session (Settings > Archive)
-- must not destroy the requests fired in it — the user deleted a label,
-- not a request log. This clause is only enforceable because sqlx-sqlite
-- issues `PRAGMA foreign_keys = ON` by default; SQLite itself defaults it
-- OFF, in which case the ids would be left dangling instead.
--
-- SQLite permits a REFERENCES clause on an ADDed column only when its
-- default is NULL, which is exactly this case.
ALTER TABLE request_history
  ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;

-- Composite and ordered, because the scoped read is
-- `WHERE session_id = ? ORDER BY fired_at DESC LIMIT 50` — a bare
-- (session_id) index would filter but still force a sort.
CREATE INDEX idx_request_history_session_fired_at
  ON request_history (session_id, fired_at DESC);
