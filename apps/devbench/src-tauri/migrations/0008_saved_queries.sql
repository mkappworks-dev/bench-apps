-- A saved query is DevBench's own state about a connection, not data inside
-- it, so it lives here rather than in the user's Postgres. Scoped to a
-- connection and cascading with it: a query naming that database's tables is
-- meaningless once the connection is gone.
CREATE TABLE saved_queries (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sql           TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- The rail lists one connection's queries on every render of the Queries
-- segment, and that is the only read shape this table has.
CREATE INDEX saved_queries_by_connection ON saved_queries (connection_id, created_at, id);
