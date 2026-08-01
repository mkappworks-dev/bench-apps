# DevBench DB connections, query runner, and grid redesign — design

Three goals in one spec because they share one data model: (a) let the user
add/edit/store Postgres connections instead of one hardcoded dev connection,
(b) add a SQL query runner, (c) redesign the table browser and data grid. A
stored-connections registry is the foundation the other two sit on.

Reference mockup: `docs/mockups/devbench-db-connections.html` (interactive —
same tokens/chrome as `devbench-v2-shell.html`; drag the query console's
handle, edit a cell, preview an UPDATE, open the connections modal).

This is the "db" worktree in a larger multi-worktree effort (api/db/log/email
UI updates each in their own worktree, reconciled later in a dedicated
integration worktree per `devbench-v2-chrome`'s conventions). Scope here stops
at the DB tab; wiring this into that integration is out of scope for this plan.

## Motivation

The DB tab hardcodes one Postgres connection, duplicated verbatim in
`App.tsx:18-24`, `ApiTab.tsx:15-21`, and `DbTab.tsx:13-19`, with a comment at
`App.tsx:15-17` explicitly deferring a shared config module "until
multi-connection support exists." There is no connection registry, no
persistence (no `connections` table in either migration), and no pooling
reuse — every DB command builds a throwaway
`PgPoolOptions::new().max_connections(1)` pool and drops it
(`db.rs:29-33`, `db.rs:108-112`, `correlation.rs:145-151`), meaning the full
connection, plaintext password included, crosses the Tauri IPC boundary on
every single call.

There is no arbitrary-SQL command anywhere — `list_table_rows` is fixed at
`SELECT * FROM "table" LIMIT 200` (`db.rs:115`), and the only thing standing
between user input and a `format!()`-built query is `validate_identifier`, an
ASCII-alnum-plus-underscore allow-list (`db.rs:88-102`) that exists
specifically to make injection through *identifiers* structurally impossible.
A query runner has to add a second, deliberately different trust boundary
without weakening that one.

The grid itself (`DataGrid.tsx`, 32 lines) is a plain table: no
virtualization (despite `@tanstack/react-virtual` already being a project
dependency), no sort, no pagination past the hardcoded 200-row cap, no
type-aware rendering beyond a literal `"<unsupported type>"` marker
(`db.rs:75-82`), and no editing.

## What changes

| # | Change |
|---|---|
| 1 | `connections` table + Settings > Connections pane (list, add/edit **modal**, test, delete) |
| 2 | Connection identity becomes a stable `id` (UUID for new connections); `watched_tables` migrates off the derived `connection_key` |
| 3 | Passwords move to the OS keyring via the existing `SecretStore` trait; no plaintext connection ever crosses IPC again after save |
| 4 | Every DB-adjacent command takes a `connection_id: String` instead of a full `DbConnectInput` |
| 5 | A `ConnectionRegistry` caches one pool per connection id, replacing per-call throwaway pools |
| 6 | New query runner: a resizable **bottom drawer** in the DB tab (not a mode toggle) |
| 7 | **Nothing the query runner or an inline cell edit does is permanent until an explicit Commit** — every run previews in an open, uncommitted transaction first |
| 8 | Data grid: virtualized rows, server-side sort, paginated beyond 200, type-aware cells, copy actions, inline cell editing (single-column-PK tables only) |

## Architecture

### Connection storage & identity

New migration `0004_connections.sql`:

```sql
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
-- fixed, non-UUID id — nothing requires connection ids to be UUIDs, only
-- stable, and a fixed literal is what a plain SQL migration can express.
INSERT INTO connections (id, name, engine, host, port, database, username, sslmode, created_at, updated_at)
VALUES ('default', 'Local Dev', 'postgres', 'localhost', 5432, 'devbench_test', 'postgres', 'disable', datetime('now'), datetime('now'));

-- watched_tables moves from a derived connection_key string to a connection_id
-- FK. SQLite can't ALTER a PRIMARY KEY in place, so this recreates the table
-- (the same technique the session-scoping migration would have needed had it
-- touched a primary key instead of adding a nullable column).
CREATE TABLE watched_tables_new (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  table_name    TEXT NOT NULL,
  PRIMARY KEY (connection_id, table_name)
);
INSERT INTO watched_tables_new (connection_id, table_name)
SELECT 'default', table_name FROM watched_tables;
DROP TABLE watched_tables;
ALTER TABLE watched_tables_new RENAME TO watched_tables;
```

The backfill (`SELECT 'default', table_name FROM watched_tables`) is safe
*because* every existing install's `watched_tables` rows share exactly one
`connection_key` — the same hardcoded `DEV_CONNECTION` literal has been
duplicated across all three frontend files with no way to have ever watched a
table under a different connection. There is no prior install with a second,
divergent `connection_key` to migrate incorrectly. This is verified by
inspection (the literal is identical in `App.tsx`, `ApiTab.tsx`, `DbTab.tsx`
today), not by an automated test — there's no real divergent-key install to
construct a regression fixture from.

The `connections` row never stores a password. The seeded `'default'` row's
password can't be seeded by SQL (the keyring isn't SQL-reachable), so app
startup (in `main.rs`'s `setup`, after migrations run) does a one-time bridge:
if a `connections` row with id `'default'` exists and the keyring has no entry
yet for `db-connection:default`, seed it with today's hardcoded password
(`"postgres"`). This is not a new secret — it's the literal value already
shipping in three source files today — relocated once so upgrading users keep
a working setup without retyping anything. It never overwrites a password the
user has since changed (guarded by "keyring has no entry yet").

Passwords for every connection (seeded or user-created) live in the OS
keyring via the existing `SecretStore` trait (`secrets.rs`), the same pattern
`provider.rs` already uses for the AI API key: `secrets.set("db-connection:<id>",
password)`, and the frontend only ever learns a `has_password: bool`, never
the value — mirroring `ProviderStatus.has_key` (`provider.rs:10-17`) exactly.

New module `commands/connections.rs`:

```rust
pub struct ConnectionSummary {
    pub id: String, pub name: String, pub engine: String,
    pub host: String, pub port: u16, pub database: String, pub username: String,
    pub sslmode: String, pub has_password: bool,
}

pub struct ConnectionInput {
    pub name: String, pub engine: String,
    pub host: String, pub port: u16, pub database: String, pub username: String,
    pub sslmode: String, pub password: Option<String>,
}
```

`ConnectionInput` is the *only* place a plaintext password still crosses IPC
after this spec lands — it's the add/edit form's own submission (the user
just typed it) and `create_connection`/`update_connection`/`test_connection`
are its sole consumers. This is a deliberately narrower replacement for
today's `DbConnectInput`: the old type was threaded through every DB
operation (browsing, watching, correlated requests); `ConnectionInput` is
threaded through connection *management* only, and every other command
downstream of a saved connection takes a bare `connection_id` instead.

Commands: `list_connections`, `create_connection`, `update_connection`,
`delete_connection` (cascades `watched_tables` via `ON DELETE CASCADE`, clears
the keyring entry, invalidates any cached pool), `set_connection_password` /
`clear_connection_password` (mirroring `set_provider_api_key` /
`clear_provider_api_key`'s split, rather than folding the password into
`update_connection`), `test_connection` (an unsaved draft — the frontend still
holds the just-typed password in this one case, exactly like `ProviderPane`'s
`draftKey`, dropped from state the instant it's used), and
`test_saved_connection(id)` (resolves the stored password server-side for an
existing row's Test button, so a re-test never needs the frontend to hold it
again).

**Engine field, scoped narrowly:** `connections.engine` exists and the add/edit
form offers a picker, but only `postgres` is wired to anything — `sqlite` shows
as a disabled "reserved" option. None of this spec's three goals ask for a
second engine; adding the *column* now avoids an awkward later migration, but
actually executing against a second engine (own `list_tables`/`list_rows`/
query-runner/PK-detection implementations) is explicitly out of scope. Every
place today's code assumes Postgres syntax (`information_schema` queries,
`get_primary_key_column`'s constraint lookup) stays exactly as Postgres-only
as it is today.

**`sslmode`** (`disable` / `require` / `verify-full`) is a new field on
`connections`/`ConnectionInput`, threaded into `connection_string()` as a
query parameter — today's hardcoded connection string has no room for it at
all, and it's required by most hosted Postgres.

### `ConnectionRegistry`: one pool per connection, not one per call

```rust
pub struct ConnectionRegistry {
    pools: Mutex<HashMap<String, PgPool>>,
}
impl ConnectionRegistry {
    pub async fn pool_for(&self, connection_id: &str, db: &SqlitePool, secrets: &dyn SecretStore)
        -> Result<PgPool, String> { /* cache hit, or look up the row + keyring secret and connect */ }
    pub fn invalidate(&self, connection_id: &str) { /* drop the cached pool */ }
}
```

Managed as `Arc<ConnectionRegistry>` Tauri state (`main.rs`, alongside
`LogState`/`EmailState`/`CorrelationRegistry`). `update_connection`,
`set_connection_password`, and `delete_connection` all call `invalidate` so an
edited or removed connection never keeps serving a stale pool. Every existing
call site that built its own throwaway pool (`db.rs:29-33`, `db.rs:108-112`,
`correlation.rs:145-151`) resolves its pool through the registry instead.

### Every command takes a `connection_id`, not a `DbConnectInput`

This is the direct consequence of connections being *stored*: the frontend no
longer needs to hold host/port/username/password in memory or thread them
through every `invoke` call. `db_connect_and_list_tables`, `list_table_rows`,
`list_watched_tables`, `set_watched_table`, and `run_correlated_request` all
change their `connection: DbConnectInput` parameter to `connection_id: String`,
resolved server-side via `ConnectionRegistry`. `watched.rs`'s `connection_key()`
helper (`watched.rs:10-12`) is deleted outright — the id *is* the key now, and
it's stable across edits in a way the derived key never was (editing a
connection's host/port/username/database today would silently orphan its
watched-table rows; with a stable id it can't).

`src/lib/tauri.ts`'s wrapper functions update their signatures to match, and
the `DbConnectInput` frontend type is deleted entirely — after a connection is
saved, its credentials never re-enter JavaScript.

`App.tsx:15-24`, `ApiTab.tsx:15-21`, `DbTab.tsx:13-19` — the `DEV_CONNECTION`
constant and its "shared config module is out of scope" comment are deleted
from all three files. In their place, a new `activeConnectionId: string | null`
field on `useAppStore` (alongside `activeSessionId`) is the thing `ApiTab`'s
correlated-request call and `DbTab`'s browsing/query both read. This is a
today-only App-level singleton by necessity — the v2 shell branch
(`devbench-v2-chrome`) doesn't exist in mainline yet — but it's named here
explicitly as a fifth candidate for that branch's "three singletons must
become per-tab" migration (`dbFocusTable`, `emailFocusId`,
`activeLogSourceId`, and now `activeConnectionId`), so whoever lands that
branch next knows where to look.

### Query runner and the preview-before-commit model

The query runner is a free-form SQL box. The identifier allow-list
(`validate_identifier`) is *not* touched or extended to cover it — it keeps
guarding exactly what it guards today (identifiers this code itself
interpolates: table names in `list_table_rows`, `pk_col`/`table` in
`snapshot_table`). The query runner's SQL is different in kind: it's text the
user typed themselves, sent to Postgres verbatim, with nothing for this code
to sanitize — the same trust model as opening `psql` yourself. No
statement-type keyword detection (SELECT vs INSERT vs DROP) gates whether a
statement is *allowed to run* — that was one of the options considered and
rejected (keyword detection is unreliable across CTEs, comments, and
data-modifying `WITH`).

What replaced "should destructive statements need confirmation" is better than
a keyword-detection gate: **every** execution — read or write, no detection
needed — opens a real Postgres transaction, runs the single statement inside
it, and returns a preview. Nothing commits until the user explicitly clicks
Commit; Rollback (or a timeout) discards it. This satisfies the original
"confirmation before destructive statements" instinct without relying on
guessing which statements are destructive from their text — the database
itself decides, because nothing is final until the transaction says so.

**Two entry points, one mechanism.** Both the free-form runner and inline cell
edits funnel into the same primitive:

- `preview_query(connection_id, sql: String)` — the free-form path, no
  identifier validation (per above).
- `preview_cell_edit(connection_id, table, pk_column, pk_value, column, value)`
  — the structured path. `table`, `pk_column`, and `column` all go through
  `validate_identifier` exactly as `list_table_rows_impl` and `snapshot_table`
  already do (defense in depth even though these names come from schema
  metadata, not raw user text). Internally builds
  `UPDATE "table" SET "column" = $1 WHERE "pk_column" = $2`, with `$1`/`$2`
  bound as values — never interpolated — the same identifier-vs-value split
  every other query in this codebase already uses.

Both return the same shape: a `preview_id` plus either rows (a read-shaped
result) or an affected-row count (a write with nothing to show). Both are
finalized by the same `commit_preview(preview_id)` / `rollback_preview(preview_id)`
pair.

**Why every statement previews, including plain `SELECT`s:** distinguishing
"this needs a commit gate" from "this is just a read" would require exactly
the keyword-detection this spec already rejected as unreliable. Instead,
*nothing* auto-commits — a `SELECT`'s "Commit" click is a no-op formality (it
closes a transaction that made no changes), traded for zero reliance on
statement-type sniffing anywhere in the execution path. This is the same
posture `validate_identifier` already takes: no clever inference, just a
narrow, structural rule applied uniformly.

**Honest rows vs. rows-affected.** A write with no `RETURNING` clause returns
zero decoded rows — which must never be rendered the same as "a `SELECT` that
matched nothing." This is the same discipline `correlation.rs` already applies
(`None` vs `Some(vec![])` for unobserved-vs-empty) and `db.rs` already applies
(`NULL` vs `"<unsupported type>"` for absent-vs-undecodable) — extended here to
"0 rows returned" vs "N rows affected." Getting both numbers out of one
execution needs a result-stream API that surfaces the completion tag
separately from decoded rows (not a plain `fetch_all`, which discards it) —
left as an implementation-plan detail, not a design decision.

**Cell-edit diffs are real, not guessed.** The preview shows `old → new` where
`old` is the value already rendered in the grid (no re-fetch needed) and `new`
is what the user typed — but the UPDATE actually executes (inside the open,
uncommitted transaction) before that diff is shown, so a constraint violation,
trigger side effect, or a `WHERE` that unexpectedly matches zero or more than
one row surfaces at *preview* time, not as a surprise at commit time.

**Query-console diffs are not full before/after row diffs.** For the free-form
path there is no parsed `WHERE` clause to re-run as a "before" `SELECT` — doing
so would require parsing arbitrary user SQL, which this spec deliberately
does not do. The free-form preview shows exactly what the statement itself
returns (rows, or an affected-row count) — only the structured cell-edit path
gets a true `column: before → after` diff card, because only there is the
"before" value already known without needing to infer anything about the
statement's shape.

**Holding the preview open.** A Postgres transaction can't be held across two
separate async Tauri commands without somewhere to keep it. A
`PendingPreviewRegistry` (mirroring `CorrelationRegistry`'s shape in
`correlation_state.rs`) holds each open `Transaction<'static, Postgres>` keyed
by a `preview_id`, alongside an expiry timestamp. A background sweep — the
same pattern as `main.rs`'s existing log-polling task — rolls back and evicts
any preview whose expiry has passed, so walking away from an open preview
doesn't hold row locks on the user's real database indefinitely. (An app
restart is already safe without special handling: the in-memory registry and
its connections are gone, and Postgres rolls back a transaction whose
connection was simply dropped.)

**Known trade-off:** an open preview ties up one pooled connection until it's
resolved. `ConnectionRegistry`'s per-connection pool needs headroom beyond a
single connection so a browse/query on one tab isn't starved by a preview left
open on another (today's per-call pools are hardcoded to
`max_connections(1)`, which would deadlock the moment two DB operations on the
same connection overlap even by one preview) — the exact pool size is an
implementation-plan tuning detail, not a design decision.

**Single statement per run.** The runner accepts one SQL statement, not a
script — multi-statement input is out of scope. This was already a reasonable
cut before the preview model (predictable result shape); it's doubly justified
now, since a multi-statement preview has no single coherent diff to show.

### Table browser / data grid redesign

- **Virtualized rows** via `@tanstack/react-virtual`'s `useVirtualizer`
  (already a `package.json` dependency, unused today).
- **Server-side sort**: clicking a column header re-fetches with
  `ORDER BY "col" ASC/DESC`; the column name goes through `validate_identifier`
  before interpolation, same as every other backend-built identifier — sorting
  only the current page client-side would be meaningless once pagination means
  the grid never holds the whole table at once.
- **Pagination** replaces the hardcoded `LIMIT 200` with `LIMIT/OFFSET`,
  default page size ~100. No exact total row count is fetched (a `COUNT(*)` on
  a large table is exactly the kind of promise this codebase avoids making
  when it can't back it cheaply and honestly) — "Next" simply disables once a
  page returns fewer rows than the page size.
- **Type-aware rendering**: numbers right-aligned/tabular, booleans as small
  chips, `NULL` visually distinct from `"<unsupported type>"` (both already
  exist as separate concepts in `db.rs:75-82`; today's grid renders them
  identically as blank).
- **Copy actions**: cell / row (tab-separated) / row-as-JSON, via
  `navigator.clipboard`.
- **Inline cell editing**, gated on `pk_column !== null` — reuses
  `get_primary_key_column`'s existing "single-column PK only" rule
  (`correlation.rs:52-69`), relocated to a shared module since both
  correlation snapshotting and grid-edit-target resolution need it now. A
  table without a qualifying PK stays fully read-only in the grid, with a
  visible note explaining why (the same constraint the watch feature already
  surfaces, now also explaining edit availability). `list_table_rows`'s
  response grows a `pk_column: Option<String>` field so the frontend knows
  which cells are eligible without a second round trip.

### UI composition

**DB tab layout** (see the mockup): the schema-tree/rail header holds the
connection picker — a styled popup (glass, matching this app's existing
transient-overlay convention), replacing the plain `connection.database` text
label at `SchemaTree.tsx:34`. The **query console is a resizable bottom
drawer**, not a mode that replaces Browse — Browse keeps rendering the
selected table the entire time the console is open, so watching one table
while querying another (or the same one) is the ordinary case, not a
trade-off. Default closed, ~220px tall, drag range clamped to something like
120–560px; the visible drag affordance is a small centered grip, not a
bar spanning the whole panel. None of this height/state is persisted in this
spec (session-only) — persisting it is a natural fit for the v2 shell
branch's per-tab `state` once that lands, not before.

**Settings > Connections**: a list (name, `engine · host:port/database`,
status pill, Test/Edit/Delete) mirroring `McpPane.tsx`'s existing list
conventions, but add/edit is a **modal**, not an inline card like
`McpPane`'s "Add a server" section — the connection form has eight fields
against MCP's two, and edit needs to reuse the same surface pre-filled rather
than growing a second inline form. The modal is glass (`backdrop-filter: blur`),
matching this app's existing precedent for transient overlays (the New
Session picker, per `SettingsScreen.tsx`'s own comment distinguishing
"persistent → ghosty" from "transient → glass"). Editing an existing
connection never shows its stored password — only a "•••••••• (stored)"
placeholder, exactly like `ProviderPane`'s API key field.

## Testing

**Rust** (`cargo test`): `connections.rs` gets `InMemorySecretStore`-based
unit tests mirroring `provider.rs`'s (CRUD round-trips, `has_password` never
leaks the value, delete cascades `watched_tables` and clears the keyring
entry); the migration's backfill assumption is verified by inspection, not an
automated test (no real install has ever had a divergent `connection_key` to
build a regression fixture from); `ConnectionRegistry` pool-cache tests
(same id returns a cached pool; edit/delete invalidate it) against a real
local Postgres, matching this codebase's existing "requires a real local
Postgres" test convention; preview/commit/rollback lifecycle tests including
the timeout sweep; a dedicated test proving a bare `UPDATE` with no
`RETURNING` reports the correct affected-row count with an empty row set (not
confused with a `SELECT` matching nothing); `preview_cell_edit` tests
rejecting malicious identifiers (mirroring `watched.rs`'s existing malicious-
table-name test) and refusing to offer editing when no single-column PK
exists.

**Frontend** (`bun run test` from `apps/devbench`): a `ConnectionsPane` test
mirroring `McpPane.test.tsx`'s shape, plus modal-specific cases (edit
pre-fills real values, add starts blank, password field never renders a
stored value); `DataGrid` tests for type-aware rendering, sort-triggers-
refetch, pagination Prev/Next disabling, and the inline-edit-then-preview-
then-commit flow (mocking `preview_cell_edit`/`commit_preview`); `DbTab`
tests for the connection picker switching `activeConnectionId` and the query
console drawer (open/close, resize within its clamped range, preview → commit
and preview → rollback both correctly reflected in the UI).

## Out of scope

- Executing against a second engine (a `sqlite`-target connection) — the
  `engine` field and picker exist, nothing behind them does yet.
- Multi-statement SQL scripts in the query runner.
- Row insert/delete in the grid (cell edits only).
- Client-side search/filter or column show/hide in the grid.
- Persisting the query runner's SQL text, drawer height, or grid column
  widths — session-only for now; per-tab persistence is the v2 shell
  branch's concern once tabs exist.
- Query history / saved queries.
- Configurable preview-timeout duration (a fixed constant, not a Settings
  field).
- Any change to the v2 shell branch (`devbench-v2-chrome`) itself, or to the
  api/log/email UI worktrees — this spec is scoped to the DB tab only.
