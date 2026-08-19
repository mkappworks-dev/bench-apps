// Injected before load (Playwright addInitScript). Tauri's invoke throws in a
// plain browser, so the page needs one before any app code runs. Serves 260 rows
// and 12 columns so vertical paging, virtualization and horizontal scroll are
// all exercised, with `user_id` carrying a foreign-key target so the link icon
// and its popover are too.
(() => {
  const COLUMNS = [
    "id", "user_id", "status", "amount", "paid", "created_at",
    "notes", "region", "channel", "sku", "quantity", "reference",
  ];

  const ROWS = Array.from({ length: 260 }, (_, i) => [
    String(i + 1),
    `usr_${(i % 40) + 1}`,
    ["paid", "pending", "failed"][i % 3],
    String((i * 37) % 5000),
    i % 2 === 0 ? "true" : "false",
    "2026-08-02 10:15:00",
    i % 7 === 0 ? null : `note number ${i} with enough text to need truncating`,
    ["eu-west", "us-east", "ap-south"][i % 3],
    ["web", "ios", "android"][i % 3],
    `SKU-${1000 + i}`,
    String((i % 9) + 1),
    `ref-${i}-${"x".repeat(20)}`,
  ]);

  // Shaped so the insert panel has one of each field kind to draw: `id` is
  // database-assigned (read-only), `status` and `created_at` carry defaults
  // (placeholder, not required), `notes` is nullable, and everything else is
  // NOT NULL with no default (required).
  const DEFAULTS = { status: "'pending'::text", created_at: "now()" };

  const META = COLUMNS.map((name) => ({
    name,
    udt: name === "paid" ? "bool"
       : name === "amount" || name === "quantity" ? "int4"
       : name === "created_at" ? "timestamptz"
       : "text",
    nullable: name === "notes",
    default_expr: DEFAULTS[name] ?? null,
    is_identity: name === "id",
    references: name === "user_id" ? { schema: "public", table: "users", column: "id" } : null,
  }));

  const USERS_COLUMNS = ["id", "email", "status"];

  const HANDLERS = {
    get_startup_status: () => ({ db_error: null }),
    get_settings: () => ({
      theme: "dark", correlation_window_ms: 2000, smtp_port: 1025,
      provider: "anthropic", model: "claude-opus-5", active_session_id: null,
    }),
    list_sessions: () => [],
    list_archived_sessions: () => [],
    list_history: () => [],
    list_log_sources: () => [],
    list_emails: () => ({ emails: [], total: 0 }),
    smtp_status: () => ({ running: false, port: 1025, error: null }),
    get_provider_status: () => ({ configured: false, provider: "anthropic", model: "claude-opus-5" }),
    list_mcp_servers: () => [],
    list_tabs: () => [
      { id: "t1", session_id: null, kind: "db", pane: "left", ordinal: 0,
        state: JSON.stringify({ table: { schema: "public", name: "orders" } }) },
    ],
    list_connections: () => [
      { id: "c1", name: "Local Dev", engine: "postgres", host: "localhost", port: 5432,
        database: "devbench_test", username: "postgres", sslmode: "disable", has_password: true },
    ],
    db_connect_and_list_tables: () => [
      { schema: "public", name: "orders" },
      { schema: "public", name: "users" },
    ],
    list_watched_tables: () => [],
    list_table_rows: (args) => {
      const isUsers = args.table && args.table.name === "users";
      if (isUsers) {
        return {
          columns: USERS_COLUMNS,
          rows: [["usr_1", "usr_1@example.com", "active"]],
          pk_column: "id",
        };
      }
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      return { columns: COLUMNS, rows: ROWS.slice(offset, offset + limit), pk_column: "id" };
    },
    count_table_rows: (args) =>
      args.table && args.table.name === "users" ? 1 : ROWS.length,
    describe_columns: (args) =>
      args.table && args.table.name === "users"
        ? USERS_COLUMNS.map((name) => ({
            name, udt: "text", nullable: false, default_expr: null,
            is_identity: name === "id", references: null,
          }))
        : META,
    get_referenced_row: (args) => ({
      columns: USERS_COLUMNS,
      rows: [[args.value, `${args.value}@example.com`, "active"]],
      pk_column: "id",
    }),
    // Echoes success. The gate measures the UI around Apply, not the write —
    // a stub that reported a conflict would exercise the error path instead.
    apply_changes: (args) => ({ applied: (args.changes ?? []).length, conflict: null }),
  };

  window.__TAURI_INTERNALS__ = {
    // Anything unlisted resolves to null rather than throwing: an unstubbed
    // command must not take the page down and hide the thing being measured.
    invoke: (cmd, args) => Promise.resolve(HANDLERS[cmd] ? HANDLERS[cmd](args ?? {}) : null),
    transformCallback: (cb) => cb,
    convertFileSrc: (p) => p,
  };
})();
