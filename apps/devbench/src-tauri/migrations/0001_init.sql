CREATE TABLE request_history (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  fired_at TEXT NOT NULL
);

CREATE TABLE watched_tables (
  connection_key TEXT NOT NULL,
  table_name TEXT NOT NULL,
  PRIMARY KEY (connection_key, table_name)
);
