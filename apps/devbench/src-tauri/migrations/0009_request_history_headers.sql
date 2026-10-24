-- Widens request_history so it stores what was actually sent, not just the
-- response. JSON text columns match the existing `mcp_servers.args` idiom —
-- a header list isn't independently queried, only read/written whole.
ALTER TABLE request_history ADD COLUMN request_headers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request_history ADD COLUMN request_body TEXT;
ALTER TABLE request_history ADD COLUMN response_headers TEXT NOT NULL DEFAULT '[]';
