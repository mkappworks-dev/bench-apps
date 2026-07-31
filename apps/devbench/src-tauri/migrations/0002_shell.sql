-- Named investigations. Sessions are a pure organizational/history layer:
-- `kind` is an auto-inferred tag for scanning and search, never a gate on
-- which tools are visible.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- NULL means active; a timestamp means archived and restorable from
  -- Settings > Archive. Sessions are never hard-deleted by the sidebar.
  archived_at TEXT
);

CREATE INDEX idx_sessions_archived_at ON sessions (archived_at);

-- App-wide configuration. Key/value so a new setting is an INSERT rather than
-- a migration. Absent keys fall back to the constants in Rust.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- MCP servers the AI assistant may call during a chat. `args` is a JSON array.
-- No credentials here: an MCP server that needs a secret gets it from the
-- environment of the process the user configures, never from this table.
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
