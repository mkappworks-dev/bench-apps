-- watched_tables gains the schema half of a table's identity. SQLite can't
-- ALTER a PRIMARY KEY in place, so this recreates the table exactly as 0006
-- did.
--
-- The backfill (every existing row -> 'public') is correct for effectively
-- every install: a table could only ever have been watched by bare name,
-- resolved against the connection's default search_path, which is
-- '"$user", public' on a stock Postgres. It is not provable — a user whose
-- role name matches an existing schema could have watched a non-public
-- table. The failure mode is benign: that watch stops matching and the user
-- re-watches it.
CREATE TABLE watched_tables_new (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  table_schema  TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  PRIMARY KEY (connection_id, table_schema, table_name)
);
INSERT INTO watched_tables_new (connection_id, table_schema, table_name)
SELECT connection_id, 'public', table_name FROM watched_tables;
DROP TABLE watched_tables;
ALTER TABLE watched_tables_new RENAME TO watched_tables;
