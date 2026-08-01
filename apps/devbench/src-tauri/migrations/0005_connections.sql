CREATE TABLE connections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  engine      TEXT NOT NULL DEFAULT 'postgres',
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  database    TEXT NOT NULL,
  username    TEXT NOT NULL,
  sslmode     TEXT NOT NULL DEFAULT 'disable',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Preserves today's single hardcoded dev connection as a real row, under a
-- fixed, non-UUID id — a plain SQL migration can't call the app's UUID
-- generator, and nothing requires ids to be UUID-shaped, only stable.
INSERT INTO connections (id, name, engine, host, port, database, username, sslmode, created_at, updated_at)
VALUES ('default', 'Local Dev', 'postgres', 'localhost', 5432, 'devbench_test', 'postgres', 'disable', datetime('now'), datetime('now'));

-- watched_tables moves from a derived connection_key string to a connection_id
-- FK. SQLite can't ALTER a PRIMARY KEY in place, so this recreates the table.
-- The backfill (every existing row -> 'default') is safe because every real
-- install's watched_tables rows share exactly one connection_key today: the
-- same hardcoded DEV_CONNECTION literal duplicated across App.tsx, ApiTab.tsx,
-- and DbTab.tsx, with no way to have ever watched a table under a different
-- connection.
CREATE TABLE watched_tables_new (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  table_name    TEXT NOT NULL,
  PRIMARY KEY (connection_id, table_name)
);
INSERT INTO watched_tables_new (connection_id, table_name)
SELECT 'default', table_name FROM watched_tables;
DROP TABLE watched_tables;
ALTER TABLE watched_tables_new RENAME TO watched_tables;
