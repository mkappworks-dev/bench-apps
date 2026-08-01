# DevBench DB Connections, Query Runner, and Grid Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one hardcoded dev Postgres connection with stored, user-managed connections; add a free-form SQL query runner; redesign the table browser/grid — with every write (query-runner or inline cell edit) previewed in an open transaction before an explicit Commit.

**Architecture:** A new `connections` table (stable `id`, no password) backs a `ConnectionRegistry` that caches one pool per connection, replacing today's per-call throwaway pools. Every DB-adjacent command switches from taking a full `DbConnectInput` to a bare `connection_id`. Passwords live in the OS keyring via the existing `SecretStore` trait. A new `PendingPreviewRegistry` holds an open `Transaction<'static, Postgres>` per in-flight preview (query-runner run or cell edit), finalized by a shared `commit_preview`/`rollback_preview` pair, with a background sweep auto-rolling-back anything abandoned past a timeout.

**Tech Stack:** Unchanged. sqlx 0.8 (SQLite + Postgres), Tauri v2, React + Zustand, Vitest, Bun, `@tanstack/react-virtual`.

## Global Constraints

- **Local Postgres required for the backend suite.** Verify with `PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d devbench_test -c 'select 1'` before starting.
- **`vitest run` does not typecheck.** `bun run build` (which runs `tsc`) is required before any frontend task is considered done — widening a TS interface breaks object literals in existing tests without failing `bun run test`.
- Every Tauri command follows the established split: a thin `#[tauri::command]` wrapper delegating to a plain `_impl` taking references, never `tauri::State`, directly.
- Tauri v2 converts camelCase JS argument keys to snake_case Rust parameters automatically (`connectionId` → `connection_id`).
- A failure to observe (or a write with nothing to show) is never rendered as "nothing happened" — extend the existing `None`-vs-`Some(vec![])` (`correlation.rs`) and `NULL`-vs-`"<unsupported type>"` (`db.rs`) discipline to "0 rows returned" vs "N rows affected."
- Identifiers built by this code (table/column names) are validated via `validate_identifier` before interpolation; values are always bound, never interpolated. The query runner's raw SQL text is the one deliberate exception — the user is its author, not this code.
- Visual system follows `DESIGN.md`: ghosty persistent chrome, glass transient overlays (`backdrop-filter: blur(22px) saturate(155%)`), `--radius-sm`/`--radius-lg`, `text-text-faint` for de-emphasised copy.
- Package manager is Bun exclusively.
- Reference spec: `docs/superpowers/specs/2026-07-31-devbench-db-connections-design.md`. Reference mockup: `docs/mockups/devbench-db-connections.html`.

## File Structure

```
apps/devbench/
  src-tauri/
    migrations/0004_connections.sql          # NEW
    src/
      connection_registry.rs                 # NEW: pool-per-connection cache
      preview_state.rs                       # NEW: PendingPreviewRegistry (open transactions)
      lib.rs                                  # MODIFIED: register new modules
      main.rs                                 # MODIFIED: manage new state, spawn sweep task, register commands
      commands/
        mod.rs                                # MODIFIED: register connections.rs, query.rs
        connections.rs                        # NEW: CRUD, password, test-connection commands
        query.rs                              # NEW: preview_query, preview_cell_edit, commit/rollback
        db.rs                                 # MODIFIED: connection_id, pk_column, sort/pagination, relocated get_primary_key_column
        watched.rs                            # MODIFIED: connection_id instead of derived connection_key
        correlation.rs                        # MODIFIED: connection_id, uses relocated get_primary_key_column
  src/
    lib/tauri.ts                              # MODIFIED: new types/wrappers, connection_id signatures
    store/useAppStore.ts                      # MODIFIED: activeConnectionId
    App.tsx                                   # MODIFIED: DEV_CONNECTION removed
    App.test.tsx                              # MODIFIED
    components/
      settings/
        ConnectionsPane.tsx                   # NEW
        ConnectionsPane.test.tsx               # NEW
        ConnectionModal.tsx                    # NEW
        SettingsScreen.tsx                     # MODIFIED: register Connections pane
        SettingsScreen.test.tsx                # MODIFIED
      db/
        DbTab.tsx                              # MODIFIED: connection picker, query console drawer, DEV_CONNECTION removed
        DbTab.test.tsx                          # MODIFIED
        SchemaTree.tsx                          # MODIFIED: connection prop shape
        SchemaTree.test.tsx                     # MODIFIED
        DataGrid.tsx                            # MODIFIED: virtualization, sort, pagination, type-aware cells, copy, inline edit
        DataGrid.test.tsx                       # MODIFIED
        QueryConsole.tsx                        # NEW: resizable drawer, preview/commit/rollback UI
        QueryConsole.test.tsx                   # NEW
      api/
        ApiTab.tsx                              # MODIFIED: DEV_CONNECTION removed, reads activeConnectionId
        ApiTab.test.tsx                         # MODIFIED
        RequestBuilder.tsx                      # MODIFIED: connection_id instead of DbConnectInput
        RequestBuilder.test.tsx                 # MODIFIED
```

---

## Task 1: Migration — `connections` table and `watched_tables` re-keying

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0004_connections.sql`
- Modify: `apps/devbench/src-tauri/src/commands/watched.rs` (full command migration to `connection_id`, in this same task so the build stays green)
- Test: inline `#[cfg(test)]` module in `watched.rs`

**Interfaces:**
- Produces: `connections` table (`id, name, engine, host, port, database, username, sslmode, created_at, updated_at`), seeded with one `'default'` row. `watched_tables(connection_id, table_name)` replacing `watched_tables(connection_key, table_name)`.
  `list_watched_tables_impl(pool: &SqlitePool, connection_id: &str) -> Result<Vec<String>, String>` and `set_watched_table_impl(pool: &SqlitePool, connection_id: &str, table: &str, watched: bool) -> Result<(), String>`, plus tauri commands `list_watched_tables(connection_id: String)` / `set_watched_table(connection_id: String, table: String, watched: bool)`.
- Consumed by: Task 2 (`connections.rs` reads/writes the `connections` table), Task 5 (`db.rs`), Task 7 (`correlation.rs`) — both call the new `list_watched_tables_impl`/`set_watched_table_impl` signatures.

The migration breaks `watched.rs`'s existing SQL (it queries a `connection_key` column that no longer exists) the moment it lands, so the full command rewrite has to land in the same commit — there is no working intermediate state between "old schema, old code" and "new schema, new code."

- [ ] **Step 1: Write the migration**

`apps/devbench/src-tauri/migrations/0004_connections.sql`:
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
```

- [ ] **Step 2: Replace `watched.rs` entirely with the failing-test-first version**

Replace the whole contents of `apps/devbench/src-tauri/src/commands/watched.rs`:

```rust
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::commands::db::validate_identifier;
use crate::local_db::LocalDb;

pub async fn list_watched_tables_impl(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT table_name FROM watched_tables WHERE connection_id = ? ORDER BY table_name")
        .bind(connection_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to list watched tables: {e}"))?;
    Ok(rows.iter().map(|r| r.get::<String, _>("table_name")).collect())
}

pub async fn set_watched_table_impl(
    pool: &SqlitePool,
    connection_id: &str,
    table: &str,
    watched: bool,
) -> Result<(), String> {
    // The same validation the snapshot path uses. A stored table name is
    // interpolated into SQL later; rejecting it here means a bad value can
    // never be persisted in the first place.
    validate_identifier(table)?;
    if watched {
        sqlx::query("INSERT OR IGNORE INTO watched_tables (connection_id, table_name) VALUES (?, ?)")
            .bind(connection_id)
            .bind(table)
            .execute(pool)
            .await
            .map_err(|e| format!("failed to watch {table}: {e}"))?;
    } else {
        sqlx::query("DELETE FROM watched_tables WHERE connection_id = ? AND table_name = ?")
            .bind(connection_id)
            .bind(table)
            .execute(pool)
            .await
            .map_err(|e| format!("failed to unwatch {table}: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_watched_tables(
    db: State<'_, LocalDb>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    list_watched_tables_impl(&db.pool, &connection_id).await
}

#[tauri::command]
pub async fn set_watched_table(
    db: State<'_, LocalDb>,
    connection_id: String,
    table: String,
    watched: bool,
) -> Result<(), String> {
    set_watched_table_impl(&db.pool, &connection_id, &table, watched).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn the_default_connection_is_seeded_by_migration() {
        let (_dir, db) = db().await;
        let row = sqlx::query("SELECT name, host, port, database, username FROM connections WHERE id = 'default'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("name"), "Local Dev");
        assert_eq!(row.get::<String, _>("host"), "localhost");
        assert_eq!(row.get::<i64, _>("port"), 5432);
        assert_eq!(row.get::<String, _>("database"), "devbench_test");
        assert_eq!(row.get::<String, _>("username"), "postgres");
    }

    #[tokio::test]
    async fn watching_a_table_survives_a_reconnect() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, "default").await.unwrap(), vec!["orders"]);
    }

    #[tokio::test]
    async fn unwatching_removes_the_row() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", "orders", false).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, "default").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn watching_the_same_table_twice_is_idempotent() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, "default").await.unwrap().len(), 1);
    }

    // watched_tables.connection_id is a foreign key into connections(id) now,
    // so a second row has to actually exist there to prove scoping — unlike
    // before, when "shop" and "staging" were just two arbitrary strings.
    #[tokio::test]
    async fn watch_state_is_scoped_per_connection() {
        let (_dir, db) = db().await;
        sqlx::query(
            "INSERT INTO connections (id, name, engine, host, port, database, username, sslmode, created_at, updated_at) \
             VALUES ('staging', 'Staging', 'postgres', 'staging-db.internal', 5432, 'app', 'app_ro', 'require', datetime('now'), datetime('now'))",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, "staging").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_malicious_table_name_is_rejected_before_it_can_be_persisted() {
        let (_dir, db) = db().await;
        let result =
            set_watched_table_impl(&db.pool, "default", "orders; DROP TABLE users; --", true).await;
        assert!(result.is_err());
        assert!(list_watched_tables_impl(&db.pool, "default").await.unwrap().is_empty());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib watched::`
Expected: FAIL to compile — no `connections` table exists yet (the migration from Step 1 isn't applied until this test run creates a fresh `LocalDb`, at which point it fails because Step 1's SQL hasn't been created yet if these steps are done out of order; done in the order written, this instead fails because `watched_tables` still has `connection_key`, not `connection_id`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib watched::`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/migrations apps/devbench/src-tauri/src/commands/watched.rs
git commit -m "feat(devbench): add connections table, re-key watched_tables by connection_id"
```

---

## Task 2: `connections.rs` — CRUD, password storage, and the default-password bridge

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/connections.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs` (register `pub mod connections;`)
- Modify: `apps/devbench/src-tauri/src/main.rs` (register 6 new commands, seed the default password once at startup)
- Test: inline `#[cfg(test)]` module in `connections.rs`

**Interfaces:**
- Consumes: Task 1's `connections` table; `crate::secrets::SecretStore` (existing trait).
- Produces:
  - `ConnectionSummary { id, name, engine, host, port, database, username, sslmode, has_password }`
  - `ConnectionInput { name, engine, host, port, database, username, sslmode, password: Option<String> }`
  - `list_connections_impl(pool, secrets) -> Result<Vec<ConnectionSummary>, String>`
  - `create_connection_impl(pool, secrets, input: ConnectionInput) -> Result<ConnectionSummary, String>`
  - `update_connection_impl(pool, secrets, id: &str, input: ConnectionInput) -> Result<ConnectionSummary, String>`
  - `delete_connection_impl(pool, secrets, id: &str) -> Result<(), String>`
  - `set_connection_password_impl(secrets, id: &str, password: &str) -> Result<(), String>`
  - `clear_connection_password_impl(secrets, id: &str) -> Result<(), String>`
  - `seed_default_connection_password_if_missing(pool, secrets) -> Result<(), String>`
  - Tauri commands: `list_connections`, `create_connection`, `update_connection`, `delete_connection`, `set_connection_password`, `clear_connection_password`.
- Consumed by: Task 3 (`ConnectionRegistry` reads a connection's row + password to build a pool), Task 4 (`test_connection`/`test_saved_connection`), Task 10 (`ConnectionsPane`).

`update_connection_impl`/`delete_connection_impl` deliberately do **not** know about pool caching — Task 3 adds a `registry: State<'_, Arc<ConnectionRegistry>>` parameter to the `update_connection`/`delete_connection` **tauri commands** (not the `_impl` functions) once `ConnectionRegistry` exists, calling `.invalidate(id)` after a successful update/delete. This file's `_impl` functions stay plain `pool`/`secrets` references throughout, matching this codebase's established convention.

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src-tauri/src/commands/connections.rs`:

```rust
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::secrets::SecretStore;

fn secret_account(connection_id: &str) -> String {
    format!("db-connection:{connection_id}")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub sslmode: String,
    pub has_password: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionInput {
    pub name: String,
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub sslmode: String,
    pub password: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_db::LocalDb;
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    fn input(name: &str) -> ConnectionInput {
        ConnectionInput {
            name: name.to_string(),
            engine: "postgres".to_string(),
            host: "staging-db.internal".to_string(),
            port: 5432,
            database: "app".to_string(),
            username: "app_ro".to_string(),
            sslmode: "require".to_string(),
            password: Some("s3cret".to_string()),
        }
    }

    #[tokio::test]
    async fn the_seeded_default_connection_is_listed_with_no_password_yet() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let connections = list_connections_impl(&db.pool, &secrets).await.unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "default");
        assert_eq!(connections[0].name, "Local Dev");
        assert!(!connections[0].has_password);
    }

    #[tokio::test]
    async fn creating_a_connection_stores_metadata_and_the_password_separately() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, input("Staging")).await.unwrap();

        assert_eq!(created.name, "Staging");
        assert!(created.has_password);
        assert_eq!(secrets.get(&secret_account(&created.id)).unwrap().as_deref(), Some("s3cret"));

        // The serialized summary must never carry the secret anywhere.
        let json = serde_json::to_string(&created).unwrap();
        assert!(!json.contains("s3cret"));
    }

    #[tokio::test]
    async fn updating_a_connection_leaves_its_password_untouched() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, input("Staging")).await.unwrap();

        let mut edited = input("Staging (renamed)");
        edited.password = None;
        update_connection_impl(&db.pool, &secrets, &created.id, edited).await.unwrap();

        let connections = list_connections_impl(&db.pool, &secrets).await.unwrap();
        let updated = connections.iter().find(|c| c.id == created.id).unwrap();
        assert_eq!(updated.name, "Staging (renamed)");
        assert!(updated.has_password, "update_connection must not touch the stored password");
        assert_eq!(secrets.get(&secret_account(&created.id)).unwrap().as_deref(), Some("s3cret"));
    }

    #[tokio::test]
    async fn deleting_a_connection_clears_its_password_and_cascades_watched_tables() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, input("Staging")).await.unwrap();
        sqlx::query("INSERT INTO watched_tables (connection_id, table_name) VALUES (?, 'orders')")
            .bind(&created.id)
            .execute(&db.pool)
            .await
            .unwrap();

        delete_connection_impl(&db.pool, &secrets, &created.id).await.unwrap();

        assert_eq!(secrets.get(&secret_account(&created.id)).unwrap(), None);
        let remaining = sqlx::query("SELECT COUNT(*) as n FROM watched_tables WHERE connection_id = ?")
            .bind(&created.id)
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get::<i64, _>("n");
        assert_eq!(remaining, 0, "deleting a connection must cascade its watched_tables rows");
    }

    #[tokio::test]
    async fn set_and_clear_password_round_trip_without_ever_exposing_the_value_in_the_summary() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let mut draft = input("Staging");
        draft.password = None;
        let created = create_connection_impl(&db.pool, &secrets, draft).await.unwrap();
        assert!(!created.has_password);

        set_connection_password_impl(&secrets, &created.id, "new-pw").await.unwrap();
        let connections = list_connections_impl(&db.pool, &secrets).await.unwrap();
        assert!(connections.iter().find(|c| c.id == created.id).unwrap().has_password);

        clear_connection_password_impl(&secrets, &created.id).await.unwrap();
        let connections = list_connections_impl(&db.pool, &secrets).await.unwrap();
        assert!(!connections.iter().find(|c| c.id == created.id).unwrap().has_password);
    }

    #[tokio::test]
    async fn a_blank_password_is_rejected_rather_than_silently_stored() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, input("Staging")).await.unwrap();
        assert!(set_connection_password_impl(&secrets, &created.id, "   ").await.is_err());
    }

    #[tokio::test]
    async fn seeding_the_default_password_is_skipped_once_a_password_already_exists() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        secrets.set(&secret_account("default"), "user-changed-this").unwrap();

        seed_default_connection_password_if_missing(&db.pool, &secrets).await.unwrap();

        assert_eq!(
            secrets.get(&secret_account("default")).unwrap().as_deref(),
            Some("user-changed-this"),
            "must never overwrite a password the user has since changed"
        );
    }

    #[tokio::test]
    async fn seeding_the_default_password_sets_it_when_absent() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();

        seed_default_connection_password_if_missing(&db.pool, &secrets).await.unwrap();

        assert_eq!(secrets.get(&secret_account("default")).unwrap().as_deref(), Some("postgres"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib connections::`
Expected: FAIL to compile — none of `list_connections_impl`, `create_connection_impl`, `update_connection_impl`, `delete_connection_impl`, `set_connection_password_impl`, `clear_connection_password_impl`, `seed_default_connection_password_if_missing` exist yet.

- [ ] **Step 3: Implement the CRUD, password, and seed functions**

Add above the `#[cfg(test)]` block in `apps/devbench/src-tauri/src/commands/connections.rs`:

```rust
pub async fn list_connections_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<Vec<ConnectionSummary>, String> {
    let rows = sqlx::query(
        "SELECT id, name, engine, host, port, database, username, sslmode FROM connections ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to list connections: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        let has_password = secrets.get(&secret_account(&id))?.is_some();
        out.push(ConnectionSummary {
            id,
            name: row.get("name"),
            engine: row.get("engine"),
            host: row.get("host"),
            port: row.get::<i64, _>("port") as u16,
            database: row.get("database"),
            username: row.get("username"),
            sslmode: row.get("sslmode"),
            has_password,
        });
    }
    Ok(out)
}

pub async fn create_connection_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO connections (id, name, engine, host, port, database, username, sslmode, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.engine)
    .bind(&input.host)
    .bind(input.port as i64)
    .bind(&input.database)
    .bind(&input.username)
    .bind(&input.sslmode)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to create connection: {e}"))?;

    // Blank means "no password" (e.g. local trust/peer auth) — a legitimate
    // real-world case, not an error the way a blank AI provider key is.
    if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
        secrets.set(&secret_account(&id), password)?;
    }

    Ok(ConnectionSummary {
        has_password: secrets.get(&secret_account(&id))?.is_some(),
        id,
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        database: input.database,
        username: input.username,
        sslmode: input.sslmode,
    })
}

pub async fn update_connection_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    id: &str,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    let result = sqlx::query(
        "UPDATE connections SET name = ?, engine = ?, host = ?, port = ?, database = ?, username = ?, sslmode = ?, updated_at = datetime('now') \
         WHERE id = ?",
    )
    .bind(&input.name)
    .bind(&input.engine)
    .bind(&input.host)
    .bind(input.port as i64)
    .bind(&input.database)
    .bind(&input.username)
    .bind(&input.sslmode)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to update connection: {e}"))?;

    if result.rows_affected() == 0 {
        return Err(format!("no connection with id {id}"));
    }

    Ok(ConnectionSummary {
        has_password: secrets.get(&secret_account(id))?.is_some(),
        id: id.to_string(),
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        database: input.database,
        username: input.username,
        sslmode: input.sslmode,
    })
}

pub async fn delete_connection_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    id: &str,
) -> Result<(), String> {
    // watched_tables rows cascade automatically (ON DELETE CASCADE, migration 0004).
    sqlx::query("DELETE FROM connections WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to delete connection: {e}"))?;
    secrets.clear(&secret_account(id))
}

pub async fn set_connection_password_impl(
    secrets: &dyn SecretStore,
    id: &str,
    password: &str,
) -> Result<(), String> {
    let password = password.trim();
    if password.is_empty() {
        return Err("a password cannot be blank — use Clear password to remove it".to_string());
    }
    secrets.set(&secret_account(id), password)
}

pub async fn clear_connection_password_impl(secrets: &dyn SecretStore, id: &str) -> Result<(), String> {
    secrets.clear(&secret_account(id))
}

/// One-time bridge for upgrading installs: migration 0004 seeds the
/// 'default' connection row with today's hardcoded values, but its password
/// can't be seeded by SQL (the keyring isn't SQL-reachable). Called once from
/// main.rs's setup, after migrations run. Never overwrites a password the
/// user has since changed.
pub async fn seed_default_connection_password_if_missing(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<(), String> {
    let exists = sqlx::query("SELECT id FROM connections WHERE id = 'default'")
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("failed to check for the default connection: {e}"))?;
    if exists.is_none() {
        return Ok(());
    }
    if secrets.get(&secret_account("default"))?.is_some() {
        return Ok(());
    }
    // Not a new secret — the literal value already shipping today in
    // App.tsx/ApiTab.tsx/DbTab.tsx's DEV_CONNECTION, relocated once.
    secrets.set(&secret_account("default"), "postgres")
}

#[tauri::command]
pub async fn list_connections(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
) -> Result<Vec<ConnectionSummary>, String> {
    list_connections_impl(&db.pool, secrets.as_ref()).await
}

#[tauri::command]
pub async fn create_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    create_connection_impl(&db.pool, secrets.as_ref(), input).await
}

#[tauri::command]
pub async fn update_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    id: String,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    update_connection_impl(&db.pool, secrets.as_ref(), &id, input).await
}

#[tauri::command]
pub async fn delete_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    id: String,
) -> Result<(), String> {
    delete_connection_impl(&db.pool, secrets.as_ref(), &id).await
}

#[tauri::command]
pub async fn set_connection_password(
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    id: String,
    password: String,
) -> Result<(), String> {
    set_connection_password_impl(secrets.as_ref(), &id, &password).await
}

#[tauri::command]
pub async fn clear_connection_password(
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    id: String,
) -> Result<(), String> {
    clear_connection_password_impl(secrets.as_ref(), &id).await
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib connections::`
Expected: PASS (9 tests)

- [ ] **Step 5: Register the module and the new commands**

In `apps/devbench/src-tauri/src/commands/mod.rs`, add:
```rust
pub mod connections;
```

In `apps/devbench/src-tauri/src/main.rs`, add to the `tauri::generate_handler![...]` list (after `commands::watched::set_watched_table,`):
```rust
            commands::connections::list_connections,
            commands::connections::create_connection,
            commands::connections::update_connection,
            commands::connections::delete_connection,
            commands::connections::set_connection_password,
            commands::connections::clear_connection_password,
```

Wire the one-time seed into startup — in `main.rs`'s `setup`, inside the existing `tauri::async_runtime::block_on(async move { ... })` block that creates `db`, add the seed call right before the block's final `(db, port)`:

```rust
            let secrets_for_seed = devbench::secrets::KeyringSecretStore;
            if let Err(e) = devbench::commands::connections::seed_default_connection_password_if_missing(
                &db.pool,
                &secrets_for_seed,
            )
            .await
            {
                eprintln!("failed to seed default connection password: {e}");
            }
```

- [ ] **Step 6: Full backend check**

Run: `cd apps/devbench/src-tauri && cargo build`
Expected: PASS (proves `main.rs` still compiles with the new commands registered)

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/connections.rs apps/devbench/src-tauri/src/commands/mod.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): add connection CRUD, keyring-backed passwords, default-password bridge"
```

---

## Task 3: `ConnectionRegistry` — one pool per connection, not one per call

**Files:**
- Create: `apps/devbench/src-tauri/src/connection_registry.rs`
- Modify: `apps/devbench/src-tauri/src/lib.rs` (register the module)
- Modify: `apps/devbench/src-tauri/src/main.rs` (manage it as state; wire `invalidate` into `update_connection`/`delete_connection`)
- Modify: `apps/devbench/src-tauri/src/commands/connections.rs` (thread the registry into the two command wrappers)
- Test: inline `#[cfg(test)]` module in `connection_registry.rs`

**Interfaces:**
- Consumes: Task 2's `connections` table shape and `SecretStore`.
- Produces: `ConnectionRegistry::new() -> Self`, `async fn pool_for(&self, connection_id: &str, db: &SqlitePool, secrets: &dyn SecretStore) -> Result<PgPool, String>`, `fn invalidate(&self, connection_id: &str)`.
- Consumed by: Task 4 (`test_saved_connection`), Task 5 (`db.rs`), Task 7 (`correlation.rs`), Task 8 (`preview_state.rs`).

This file builds its own Postgres connection string inline from the row's plain fields, rather than reusing `db.rs`'s existing `connection_string(&DbConnectInput)`. That function still takes the old, soon-to-be-deleted `DbConnectInput` type — Task 5 replaces it with a plain-fields signature (`host, port, database, username, password: Option<&str>, sslmode`) and this file's inline version is deleted in favor of calling it, once it exists. Two short-lived, nearly-identical `format!` calls for one task's gap beats coupling this task's order to `db.rs`'s full migration.

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src-tauri/src/connection_registry.rs`:

```rust
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row, SqlitePool};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::secrets::SecretStore;

pub struct ConnectionRegistry {
    pools: Mutex<HashMap<String, PgPool>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self { pools: Mutex::new(HashMap::new()) }
    }

    pub fn invalidate(&self, connection_id: &str) {
        if let Ok(mut pools) = self.pools.lock() {
            pools.remove(connection_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::{create_connection_impl, ConnectionInput};
    use crate::local_db::LocalDb;
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    fn local_dev_input() -> ConnectionInput {
        ConnectionInput {
            name: "Test".to_string(),
            engine: "postgres".to_string(),
            host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
            port: 5432,
            database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            sslmode: "disable".to_string(),
            password: Some(std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into())),
        }
    }

    #[tokio::test]
    async fn a_pool_is_cached_and_reused_for_the_same_connection_id() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();

        registry
            .pool_for(&created.id, &db.pool, &secrets)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup");

        // Corrupt the stored password. A cache hit must not reconnect (and
        // therefore must not notice); a cache miss would fail here.
        secrets.set(&format!("db-connection:{}", created.id), "definitely-wrong").unwrap();
        registry
            .pool_for(&created.id, &db.pool, &secrets)
            .await
            .expect("a cached pool must not reconnect with the now-corrupted stored password");
    }

    #[tokio::test]
    async fn invalidate_forces_a_reconnect_on_the_next_call() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();

        registry.pool_for(&created.id, &db.pool, &secrets).await.expect("requires a real local Postgres");
        secrets.set(&format!("db-connection:{}", created.id), "definitely-wrong").unwrap();
        registry.invalidate(&created.id);

        let result = registry.pool_for(&created.id, &db.pool, &secrets).await;
        assert!(result.is_err(), "invalidate must force a reconnect, which fails with the corrupted password");
    }

    #[tokio::test]
    async fn an_unknown_connection_id_is_a_clear_error() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let registry = ConnectionRegistry::new();

        let result = registry.pool_for("does-not-exist", &db.pool, &secrets).await;
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib connection_registry::`
Expected: FAIL to compile — `pool_for` does not exist.

- [ ] **Step 3: Implement `pool_for`**

Insert `pool_for` as a new method inside the existing `impl ConnectionRegistry { ... }` block, before its closing `}` (i.e. right after `invalidate`). The snippet below includes that closing `}` and then a new top-level function, `postgres_connection_string`, placed immediately after the `impl` block ends — the two are siblings, not nested:

```rust
    pub async fn pool_for(
        &self,
        connection_id: &str,
        db: &SqlitePool,
        secrets: &dyn SecretStore,
    ) -> Result<PgPool, String> {
        if let Some(pool) = self
            .pools
            .lock()
            .map_err(|_| "connection registry poisoned".to_string())?
            .get(connection_id)
        {
            return Ok(pool.clone());
        }

        let row = sqlx::query(
            "SELECT host, port, database, username, sslmode FROM connections WHERE id = ?",
        )
        .bind(connection_id)
        .fetch_optional(db)
        .await
        .map_err(|e| format!("failed to look up connection {connection_id}: {e}"))?
        .ok_or_else(|| format!("no connection with id {connection_id}"))?;

        let host: String = row.get("host");
        let port: i64 = row.get("port");
        let database: String = row.get("database");
        let username: String = row.get("username");
        let sslmode: String = row.get("sslmode");
        let password = secrets.get(&format!("db-connection:{connection_id}"))?;

        let connection_string = postgres_connection_string(&host, port as u16, &database, &username, password.as_deref(), &sslmode);

        // A modest pool per connection, not the throwaway max_connections(1)
        // this codebase used everywhere before: browsing, the query console,
        // and a held-open preview transaction can all be in flight on the
        // same connection at once now.
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&connection_string)
            .await
            .map_err(|e| format!("connection failed: {e}"))?;

        self.pools
            .lock()
            .map_err(|_| "connection registry poisoned".to_string())?
            .insert(connection_id.to_string(), pool.clone());
        Ok(pool)
    }
}

/// The one place a Postgres connection string gets built anywhere in this
/// codebase — `ConnectionRegistry::pool_for` and (Task 4) `test_connection`/
/// `test_saved_connection` both call this rather than each formatting their
/// own. `password: None` (or empty) omits the credential segment entirely,
/// for local trust/peer-auth setups that have no password at all.
pub fn postgres_connection_string(
    host: &str,
    port: u16,
    database: &str,
    username: &str,
    password: Option<&str>,
    sslmode: &str,
) -> String {
    match password.filter(|p| !p.is_empty()) {
        Some(password) => format!("postgres://{username}:{password}@{host}:{port}/{database}?sslmode={sslmode}"),
        None => format!("postgres://{username}@{host}:{port}/{database}?sslmode={sslmode}"),
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib connection_registry::`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the module and manage it as Tauri state**

In `apps/devbench/src-tauri/src/lib.rs`, add:
```rust
pub mod connection_registry;
```

In `apps/devbench/src-tauri/src/main.rs`, inside `setup`, add (near where `CorrelationRegistry` is managed):
```rust
            app.manage(std::sync::Arc::new(devbench::connection_registry::ConnectionRegistry::new()));
```

- [ ] **Step 6: Wire `invalidate` into `update_connection`/`delete_connection`**

In `apps/devbench/src-tauri/src/commands/connections.rs`, change the two command signatures to accept the registry and call `invalidate` after a successful write:

```rust
#[tauri::command]
pub async fn update_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: tauri::State<'_, std::sync::Arc<crate::connection_registry::ConnectionRegistry>>,
    id: String,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    let summary = update_connection_impl(&db.pool, secrets.as_ref(), &id, input).await?;
    registry.invalidate(&id);
    Ok(summary)
}

#[tauri::command]
pub async fn delete_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: tauri::State<'_, std::sync::Arc<crate::connection_registry::ConnectionRegistry>>,
    id: String,
) -> Result<(), String> {
    delete_connection_impl(&db.pool, secrets.as_ref(), &id).await?;
    registry.invalidate(&id);
    Ok(())
}
```

- [ ] **Step 7: Full backend check**

Run: `cd apps/devbench/src-tauri && cargo build && cargo test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/devbench/src-tauri/src/connection_registry.rs apps/devbench/src-tauri/src/lib.rs apps/devbench/src-tauri/src/main.rs apps/devbench/src-tauri/src/commands/connections.rs
git commit -m "feat(devbench): cache one Postgres pool per connection instead of reconnecting per call"
```

---

## Task 4: `test_connection` and `test_saved_connection`

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/connections.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs` (register 2 new commands)
- Test: inline `#[cfg(test)]` module in `connections.rs`

**Interfaces:**
- Consumes: `connection_registry::postgres_connection_string` (Task 3).
- Produces: `test_connection_impl(input: &ConnectionInput) -> Result<(), String>`, `test_saved_connection_impl(pool, secrets, id: &str) -> Result<(), String>`, tauri commands `test_connection(input: ConnectionInput)` / `test_saved_connection(id: String)`.
- Consumed by: Task 10 (`ConnectionsPane`'s Test buttons — both the add/edit form's draft and an existing row).

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `apps/devbench/src-tauri/src/commands/connections.rs`:

```rust
    fn real_local_postgres_input() -> ConnectionInput {
        ConnectionInput {
            name: "Test".to_string(),
            engine: "postgres".to_string(),
            host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
            port: 5432,
            database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            sslmode: "disable".to_string(),
            password: Some(std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into())),
        }
    }

    #[tokio::test]
    async fn test_connection_succeeds_against_a_real_local_postgres() {
        let result = test_connection_impl(&real_local_postgres_input()).await;
        assert!(result.is_ok(), "requires a real local Postgres — see CONTRIBUTING for setup: {result:?}");
    }

    #[tokio::test]
    async fn test_connection_reports_a_clear_error_for_a_wrong_password() {
        let mut input = real_local_postgres_input();
        input.password = Some("definitely-wrong".to_string());
        let result = test_connection_impl(&input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_saved_connection_resolves_the_stored_row_and_password() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, real_local_postgres_input()).await.unwrap();

        let result = test_saved_connection_impl(&db.pool, &secrets, &created.id).await;
        assert!(result.is_ok(), "requires a real local Postgres — see CONTRIBUTING for setup: {result:?}");
    }

    #[tokio::test]
    async fn test_saved_connection_fails_clearly_for_an_unknown_id() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let result = test_saved_connection_impl(&db.pool, &secrets, "does-not-exist").await;
        assert!(result.is_err());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib connections::test_connection connections::test_saved_connection`
Expected: FAIL to compile — `test_connection_impl` and `test_saved_connection_impl` don't exist.

- [ ] **Step 3: Implement**

Add to `apps/devbench/src-tauri/src/commands/connections.rs` (above the `#[cfg(test)]` block), and add `use crate::connection_registry::postgres_connection_string;` and `use sqlx::postgres::PgPoolOptions;` to the file's imports:

```rust
pub async fn test_connection_impl(input: &ConnectionInput) -> Result<(), String> {
    let connection_string = postgres_connection_string(
        &input.host,
        input.port,
        &input.database,
        &input.username,
        input.password.as_deref(),
        &input.sslmode,
    );
    // A throwaway, uncached connect — this is a one-off validation, not
    // something worth caching in ConnectionRegistry.
    PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string)
        .await
        .map_err(|e| format!("connection failed: {e}"))?;
    Ok(())
}

pub async fn test_saved_connection_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    id: &str,
) -> Result<(), String> {
    let row = sqlx::query("SELECT host, port, database, username, sslmode FROM connections WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("failed to look up connection {id}: {e}"))?
        .ok_or_else(|| format!("no connection with id {id}"))?;

    let input = ConnectionInput {
        name: String::new(),
        engine: "postgres".to_string(),
        host: row.get("host"),
        port: row.get::<i64, _>("port") as u16,
        database: row.get("database"),
        username: row.get("username"),
        sslmode: row.get("sslmode"),
        password: secrets.get(&secret_account(id))?,
    };
    test_connection_impl(&input).await
}

#[tauri::command]
pub async fn test_connection(input: ConnectionInput) -> Result<(), String> {
    test_connection_impl(&input).await
}

#[tauri::command]
pub async fn test_saved_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    id: String,
) -> Result<(), String> {
    test_saved_connection_impl(&db.pool, secrets.as_ref(), &id).await
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib connections::`
Expected: PASS (13 tests)

- [ ] **Step 5: Register the two new commands**

In `apps/devbench/src-tauri/src/main.rs`, add to `tauri::generate_handler![...]`:
```rust
            commands::connections::test_connection,
            commands::connections::test_saved_connection,
```

- [ ] **Step 6: Full backend check**

Run: `cd apps/devbench/src-tauri && cargo build && cargo test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/connections.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): add test_connection and test_saved_connection commands"
```

---

## Task 5: `db.rs` and `correlation.rs` — `connection_id`, sort/pagination, `pk_column`, relocated `get_primary_key_column`

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/db.rs`
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`
- Test: rewritten `#[cfg(test)]` modules in both files

**Interfaces:**
- Consumes: Task 3's `ConnectionRegistry::pool_for` and `postgres_connection_string`.
- Produces:
  - `DbConnectInput` and the old `connection_string(&DbConnectInput)` — **deleted**.
  - `TableRows { columns: Vec<String>, rows: Vec<Vec<Option<String>>>, pk_column: Option<String> }` (adds `pk_column`).
  - `list_tables_impl(pool: &PgPool) -> Result<Vec<TableInfo>, String>`
  - `list_table_rows_impl(pool: &PgPool, table: &str, order_by: Option<(&str, bool)>, limit: i64, offset: i64) -> Result<TableRows, String>`
  - `get_primary_key_column(pool: &PgPool, table: &str) -> Result<String, String>` — **relocated from `correlation.rs` to `db.rs`**, same signature and same error strings (`"no single-column primary key"`, `"composite primary key"`).
  - Tauri commands `db_connect_and_list_tables(connection_id: String)`, `list_table_rows(connection_id: String, table: String, order_by_column: Option<String>, order_by_desc: Option<bool>, limit: i64, offset: i64)`, and `run_correlated_request(connection_id: String, ...)` (was `connection: DbConnectInput`).
  - `run_correlated_request_impl(request, pool: Option<Pool<Postgres>>, watched_tables, logs)` and `run_correlated_request_impl_with_registry(..., pool: Option<Pool<Postgres>>, ...)` — both take an already-resolved (or already-failed-to-resolve) pool instead of connecting themselves, since pool resolution now lives in `ConnectionRegistry`.
- Consumed by: Task 9 (frontend `lib/tauri.ts`), Task 11 (grid pagination/sort/`pk_column`).

`db.rs` and `correlation.rs` land in one task because `correlation.rs` imports `DbConnectInput`, `connection_string`, and (its own copy of) `get_primary_key_column` directly from `db.rs` — the moment `db.rs`'s rewrite lands, `correlation.rs` fails to compile. There is no smaller intermediate step between "both files on the old shape" and "both files on the new shape"; splitting them across two tasks would mean deliberately committing a broken build in between.

- [ ] **Step 1: Write the failing tests**

Replace `apps/devbench/src-tauri/src/commands/db.rs`'s entire `#[cfg(test)] mod tests` block with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> PgPool {
        let host = std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into());
        let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into());
        let username = std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into());
        let password = std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into());
        let connection_string = crate::connection_registry::postgres_connection_string(
            &host, 5432, &database, &username, Some(&password), "disable",
        );
        sqlx::postgres::PgPoolOptions::new()
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }

    #[tokio::test]
    async fn lists_the_public_orders_table() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS orders_for_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE orders_for_test (id serial PRIMARY KEY)").execute(&pool).await.unwrap();

        let tables = list_tables_impl(&pool).await.unwrap();
        assert!(tables.iter().any(|t| t.name == "orders_for_test" && t.schema == "public"));

        sqlx::query("DROP TABLE orders_for_test").execute(&pool).await.unwrap();
    }

    #[test]
    fn rejects_sql_injection_with_drop_table() {
        let malicious = "orders; DROP TABLE users; --";
        let result = validate_identifier(malicious);
        assert!(result.is_err(), "should reject SQL injection attempt");
        assert!(result.unwrap_err().contains("invalid characters"));
    }

    #[test]
    fn rejects_sql_injection_with_quote_escape() {
        let malicious = "orders\" WHERE 1=1; --";
        let result = validate_identifier(malicious);
        assert!(result.is_err(), "should reject quote-escape injection attempt");
        assert!(result.unwrap_err().contains("invalid characters"));
    }

    #[test]
    fn rejects_empty_table_name() {
        let result = validate_identifier("");
        assert!(result.is_err(), "should reject empty table name");
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn rejects_table_name_exceeding_max_length() {
        let long_name = "a".repeat(64);
        let result = validate_identifier(&long_name);
        assert!(result.is_err(), "should reject table name exceeding 63 characters");
        assert!(result.unwrap_err().contains("exceeds maximum"));
    }

    #[test]
    fn accepts_valid_lowercase_table_name() {
        assert!(validate_identifier("orders").is_ok());
    }

    #[test]
    fn accepts_valid_table_name_with_underscore() {
        assert!(validate_identifier("orders_for_test").is_ok());
    }

    #[test]
    fn accepts_valid_table_name_with_numbers() {
        assert!(validate_identifier("table123").is_ok());
    }

    #[test]
    fn accepts_valid_mixed_case_table_name() {
        assert!(validate_identifier("OrdersTable").is_ok());
    }

    #[test]
    fn rejects_special_characters() {
        let test_cases = vec![
            ("users;", "semicolon"), ("users--", "dash"), ("users/**/", "comment"),
            ("users OR 1=1", "space and keyword"), ("users'test", "single quote"),
            ("users\"test", "double quote"), ("users,test", "comma"), ("users.test", "dot"),
            ("users(test)", "parentheses"),
        ];
        for (input, desc) in test_cases {
            assert!(validate_identifier(input).is_err(), "should reject {} in table name", desc);
        }
    }

    #[tokio::test]
    async fn list_table_rows_rejects_malicious_table_name() {
        let pool = test_pool().await;
        let result = list_table_rows_impl(&pool, "orders; DROP TABLE users; --", None, 200, 0).await;
        assert!(result.is_err(), "should reject malicious table name before executing query");
    }

    #[tokio::test]
    async fn list_table_rows_works_with_valid_table_name() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS test_rows_table").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE test_rows_table (id serial PRIMARY KEY, name text)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO test_rows_table (name) VALUES ('test_row_1')").execute(&pool).await.unwrap();

        let result = list_table_rows_impl(&pool, "test_rows_table", None, 200, 0).await;
        assert!(result.is_ok(), "should successfully list rows from valid table");

        let table_rows = result.unwrap();
        assert!(!table_rows.columns.is_empty(), "should have columns");
        assert_eq!(table_rows.columns[0], "id", "first column should be id");
        assert_eq!(table_rows.pk_column.as_deref(), Some("id"));

        sqlx::query("DROP TABLE test_rows_table").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn a_table_with_no_qualifying_primary_key_reports_pk_column_none() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS no_pk_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE no_pk_test (a int, b int)").execute(&pool).await.unwrap();

        let result = list_table_rows_impl(&pool, "no_pk_test", None, 200, 0).await.unwrap();
        assert_eq!(result.pk_column, None, "no single-column PK means not editable, not an error");

        sqlx::query("DROP TABLE no_pk_test").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn sort_and_pagination_are_applied() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS sort_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE sort_test (id serial PRIMARY KEY, n int)").execute(&pool).await.unwrap();
        for n in [3, 1, 2] {
            sqlx::query("INSERT INTO sort_test (n) VALUES ($1)").bind(n).execute(&pool).await.unwrap();
        }

        let asc = list_table_rows_impl(&pool, "sort_test", Some(("n", false)), 200, 0).await.unwrap();
        let n_col = asc.columns.iter().position(|c| c == "n").unwrap();
        let values: Vec<_> = asc.rows.iter().map(|r| r[n_col].clone()).collect();
        assert_eq!(values, vec![Some("1".to_string()), Some("2".to_string()), Some("3".to_string())]);

        let paged = list_table_rows_impl(&pool, "sort_test", Some(("n", false)), 1, 1).await.unwrap();
        assert_eq!(paged.rows.len(), 1, "LIMIT 1 must return exactly one row");
        assert_eq!(paged.rows[0][n_col], Some("2".to_string()), "OFFSET 1 must skip the first sorted row");

        sqlx::query("DROP TABLE sort_test").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn sort_column_rejects_a_malicious_identifier() {
        let pool = test_pool().await;
        let result =
            list_table_rows_impl(&pool, "orders", Some(("n; DROP TABLE users; --", false)), 200, 0).await;
        assert!(result.is_err(), "a malicious ORDER BY column must be rejected exactly like a malicious table name");
    }

    #[tokio::test]
    async fn unsupported_column_types_render_distinctly_from_genuine_null() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS unsupported_type_test").execute(&pool).await.unwrap();
        // `amount` is NUMERIC, which this codebase doesn't decode (no bigdecimal/
        // rust_decimal feature enabled) — it's a real, non-null value that must NOT
        // render the same as `notes`, which is a genuine SQL NULL.
        sqlx::query("CREATE TABLE unsupported_type_test (id serial PRIMARY KEY, amount numeric, notes text)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO unsupported_type_test (amount, notes) VALUES (42.50, NULL)")
            .execute(&pool).await.unwrap();

        let result = list_table_rows_impl(&pool, "unsupported_type_test", None, 200, 0).await.unwrap();
        assert_eq!(result.columns, vec!["id", "amount", "notes"]);
        assert_eq!(result.rows[0][1], Some("<unsupported type>".to_string()));
        assert_eq!(result.rows[0][2], None, "a genuine NULL must still render as None");

        sqlx::query("DROP TABLE unsupported_type_test").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn timestamptz_and_date_columns_render_as_strings() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS datetime_type_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE datetime_type_test (id serial PRIMARY KEY, created_at timestamptz, birth_date date)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO datetime_type_test (created_at, birth_date) VALUES ('2025-07-30 12:34:56+00:00', '2025-07-30')")
            .execute(&pool).await.unwrap();

        let result = list_table_rows_impl(&pool, "datetime_type_test", None, 200, 0).await.unwrap();
        assert_eq!(result.columns, vec!["id", "created_at", "birth_date"]);
        assert!(result.rows[0][1].is_some());
        assert_ne!(result.rows[0][1], Some("<unsupported type>".to_string()));
        assert!(result.rows[0][2].is_some());
        assert_ne!(result.rows[0][2], Some("<unsupported type>".to_string()));

        sqlx::query("DROP TABLE datetime_type_test").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn primary_key_lookup_finds_a_single_column_key() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS pk_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE pk_test (id serial PRIMARY KEY)").execute(&pool).await.unwrap();
        assert_eq!(get_primary_key_column(&pool, "pk_test").await.unwrap(), "id");
        sqlx::query("DROP TABLE pk_test").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn primary_key_lookup_rejects_composite_keys() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS composite_pk_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE composite_pk_test (a int, b int, PRIMARY KEY (a, b))").execute(&pool).await.unwrap();
        let result = get_primary_key_column(&pool, "composite_pk_test").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("composite primary key"));
        sqlx::query("DROP TABLE composite_pk_test").execute(&pool).await.unwrap();
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib db::`
Expected: FAIL to compile — `TableRows` has no `pk_column` field, `list_table_rows_impl`/`list_tables_impl` still take `&DbConnectInput`, `get_primary_key_column` doesn't exist in this file yet.

- [ ] **Step 3: Rewrite the implementation**

Replace `apps/devbench/src-tauri/src/commands/db.rs`'s entire body above the test module with:

```rust
use serde::Serialize;
use sqlx::{Column, PgPool, Row};
use tauri::State;

use crate::connection_registry::ConnectionRegistry;
use crate::local_db::LocalDb;
use crate::secrets::SecretStore;

#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
}

pub async fn list_tables_impl(pool: &PgPool) -> Result<Vec<TableInfo>, String> {
    let rows = sqlx::query(
        "SELECT table_schema, table_name FROM information_schema.tables \
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
         ORDER BY table_schema, table_name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("query failed: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| TableInfo { schema: r.get("table_schema"), name: r.get("table_name") })
        .collect())
}

#[tauri::command]
pub async fn db_connect_and_list_tables(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
) -> Result<Vec<TableInfo>, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    list_tables_impl(&pool).await
}

#[derive(Debug, Serialize)]
pub struct TableRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// `Some(column)` when the table has exactly one primary-key column —
    /// the same rule `get_primary_key_column` already enforces for watching.
    /// `None` means the grid renders this table read-only.
    pub pk_column: Option<String>,
}

fn cell_to_string(row: &sqlx::postgres::PgRow, index: usize) -> Option<String> {
    use sqlx::Row as _;
    if let Ok(v) = row.try_get::<Option<String>, _>(index) { return v; }
    if let Ok(v) = row.try_get::<Option<i64>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<i32>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<f64>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<bool>, _>(index) { return v.map(|b| b.to_string()); }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(index) { return v.map(|d| d.to_string()); }
    if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(index) { return v.map(|d| d.to_string()); }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(index) { return v.map(|d| d.to_string()); }
    if let Ok(v) = row.try_get::<Option<uuid::Uuid>, _>(index) { return v.map(|u| u.to_string()); }
    Some("<unsupported type>".to_string())
}

/// Validates that a table or column identifier is a legitimate Postgres
/// identifier. Allows only ASCII alphanumeric characters and underscores.
pub(crate) fn validate_identifier(identifier: &str) -> Result<(), String> {
    if identifier.is_empty() {
        return Err("table name cannot be empty".to_string());
    }
    if identifier.len() > 63 {
        return Err("table name exceeds maximum Postgres identifier length (63)".to_string());
    }
    if !identifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!(
            "table name contains invalid characters; only alphanumeric and underscore allowed: {}",
            identifier
        ));
    }
    Ok(())
}

/// Relocated from correlation.rs — both correlation snapshotting and grid
/// edit-target resolution need "does this table have exactly one PK column"
/// now. Same signature, same error strings.
pub async fn get_primary_key_column(pool: &PgPool, table: &str) -> Result<String, String> {
    let rows = sqlx::query(
        "SELECT kcu.column_name FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name \
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to look up primary key for {table}: {e}"))?;

    match rows.len() {
        0 => Err(format!("table {table} has no single-column primary key — not watchable")),
        1 => Ok(rows[0].get::<String, _>("column_name")),
        _ => Err(format!("table {table} has a composite primary key — not watchable")),
    }
}

pub async fn list_table_rows_impl(
    pool: &PgPool,
    table: &str,
    order_by: Option<(&str, bool)>,
    limit: i64,
    offset: i64,
) -> Result<TableRows, String> {
    validate_identifier(table)?;
    if let Some((column, _)) = order_by {
        validate_identifier(column)?;
    }

    // No single-column PK is a normal, common case (junction tables,
    // append-only logs) — not an error. It just means this table's grid
    // renders read-only.
    let pk_column = get_primary_key_column(pool, table).await.ok();

    let mut sql = format!("SELECT * FROM \"{table}\"");
    if let Some((column, descending)) = order_by {
        sql.push_str(&format!(" ORDER BY \"{column}\" {}", if descending { "DESC" } else { "ASC" }));
    }
    // limit/offset are i64, not user-supplied text — nothing to inject.
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

    let rows = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("query failed: {e}"))?;

    let columns: Vec<String> = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();

    let out_rows = rows
        .iter()
        .map(|row| (0..columns.len()).map(|i| cell_to_string(row, i)).collect())
        .collect();

    Ok(TableRows { columns, rows: out_rows, pk_column })
}

// The argument list IS the IPC surface — see run_correlated_request's
// identical rationale in correlation.rs.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn list_table_rows(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
    table: String,
    order_by_column: Option<String>,
    order_by_desc: Option<bool>,
    limit: i64,
    offset: i64,
) -> Result<TableRows, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    let order_by = order_by_column
        .as_deref()
        .map(|column| (column, order_by_desc.unwrap_or(false)));
    list_table_rows_impl(&pool, &table, order_by, limit, offset).await
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib db::`
Expected: PASS (19 tests)

- [ ] **Step 5: Rewrite `correlation.rs`'s imports and implementation**

Replace the import block at the top of `apps/devbench/src-tauri/src/commands/correlation.rs`:

```rust
use serde::Serialize;
use sqlx::{Pool, Postgres, Row};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use super::db::{get_primary_key_column, validate_identifier};
use super::history::{save_history_entry_impl, HistoryEntryInput};
use super::request::{fire_request_impl, FireRequestInput, FireRequestOutput};
use crate::connection_registry::ConnectionRegistry;
use crate::local_db::LocalDb;
use crate::secrets::SecretStore;
```

Delete the `get_primary_key_column` function from this file entirely (it now lives in, and is imported from, `db.rs`) — `RowSnapshot`, `TableDiff`, `diff_table_snapshots`, and `snapshot_table` are untouched.

`snapshot_all`'s body is unchanged (it already calls `get_primary_key_column(pool, table)` unqualified, which now resolves via the import instead of a local definition).

Replace `run_correlated_request_impl` and `run_correlated_request_impl_with_registry`:

```rust
pub async fn run_correlated_request_impl(
    request: FireRequestInput,
    pool: Option<Pool<Postgres>>,
    watched_tables: Vec<String>,
    logs: &crate::log_state::LogState,
) -> Result<CorrelationResult, String> {
    // Everything DB-related is fallible-but-not-fatal. Only a failure to fire
    // the request itself fails the command, because without a response there
    // is nothing to correlate against. Resolving the pool itself (including a
    // failed connection) now happens one layer up, in the tauri command —
    // this function just receives `None` when that failed.
    let before = match &pool {
        Some(p) => snapshot_all(p, &watched_tables).await.map_err(Some),
        None => Err(Some("connection failed".to_string())),
    };

    let _ = logs; // used from Task 6 onward

    let response = fire_request_impl(request).await?;

    let (table_diffs, db_error) = match (pool, before) {
        (Some(p), Ok(snapshots)) => match diff_all(&p, snapshots).await {
            Ok(diffs) => (Some(diffs), None),
            Err(e) => (None, Some(e)),
        },
        (_, Err(e)) => (None, e),
        (None, Ok(_)) => (None, Some("connection failed".to_string())),
    };

    Ok(CorrelationResult { correlation_id: String::new(), response, table_diffs, db_error })
}
```

```rust
pub async fn run_correlated_request_impl_with_registry(
    request: FireRequestInput,
    pool: Option<Pool<Postgres>>,
    watched_tables: Vec<String>,
    logs: &LogState,
    emails: &EmailState,
    registry: &CorrelationRegistry,
    now_ms: i64,
    window_ms: i64,
) -> Result<CorrelationResult, String> {
    let from_log_id = logs.next_line_id().saturating_sub(1);
    let from_email_id = emails.store().lock().map(|s| s.next_id().saturating_sub(1)).unwrap_or(0);

    let request_started_at = std::time::Instant::now();
    let mut result = run_correlated_request_impl(request, pool, watched_tables, logs).await?;
    let elapsed_ms = request_started_at.elapsed().as_millis() as i64;

    result.correlation_id = registry.open(from_log_id, from_email_id, now_ms + elapsed_ms + window_ms);
    Ok(result)
}
```

Replace the `run_correlated_request` tauri command:

```rust
// The argument list IS the IPC surface: State injections plus the request
// payload. Collapsing it into a params struct would change the shape the
// frontend has to invoke with, for no gain on this side.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_correlated_request(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    connection_registry: State<'_, Arc<ConnectionRegistry>>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    correlation_registry: State<'_, Arc<CorrelationRegistry>>,
    request: FireRequestInput,
    connection_id: String,
    watched_tables: Vec<String>,
    session_id: Option<String>,
) -> Result<CorrelationResult, String> {
    // A pool that fails to resolve degrades to None rather than failing the
    // whole command — identical fallback behaviour to the pre-registry code,
    // which caught its own connect() failure with .ok() below this line.
    let pool = connection_registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await.ok();
    let method = request.method.clone();
    let url = request.url.clone();
    let window_ms = crate::commands::settings::get_settings_impl(&db.pool)
        .await
        .map(|s| s.correlation_window_ms)
        .unwrap_or(DEFAULT_CORRELATION_WINDOW_MS);
    let result = run_correlated_request_impl_with_registry(
        request,
        pool,
        watched_tables,
        &logs,
        &emails,
        &correlation_registry,
        chrono::Utc::now().timestamp_millis(),
        window_ms,
    )
    .await?;
    save_correlation_history(&db.pool, &method, &url, &result.response, session_id.as_deref()).await;
    Ok(result)
}
```

- [ ] **Step 6: Rewrite `correlation.rs`'s tests**

Replace the `fn test_connection() -> DbConnectInput { ... }` helper near the top of the `#[cfg(test)] mod tests` block with:

```rust
    async fn test_pool() -> Pool<Postgres> {
        let host = std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into());
        let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into());
        let username = std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into());
        let password = std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into());
        let connection_string = crate::connection_registry::postgres_connection_string(
            &host, 5432, &database, &username, Some(&password), "disable",
        );
        sqlx::postgres::PgPoolOptions::new()
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }
```

Delete the `rejects_composite_primary_keys` test entirely — it tested `get_primary_key_column` directly, which moved to `db.rs` and is now covered there by `primary_key_lookup_rejects_composite_keys`.

Every remaining test that builds a `let conn = test_connection();` and then separately does
`PgPoolOptions::new().connect(&connection_string(&conn)).await.expect(...)` for its own
`CREATE TABLE`/`INSERT` setup now needs only one pool, built once via `test_pool()`, reused for
both setup and the call into `run_correlated_request_impl`/`run_correlated_request_impl_with_registry`
(passing `Some(pool.clone())` where the old code passed `conn`). Worked in full for the most
involved case, `run_correlated_request_reports_only_tables_that_actually_changed`:

```rust
    #[tokio::test]
    async fn run_correlated_request_reports_only_tables_that_actually_changed() {
        let pool = test_pool().await;

        sqlx::query("DROP TABLE IF EXISTS orders_e2e").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS untouched_e2e").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE orders_e2e (id serial PRIMARY KEY, status text)")
            .execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE untouched_e2e (id serial PRIMARY KEY)")
            .execute(&pool).await.unwrap();

        let mut server = mockito::Server::new_async().await;
        let insert_pool = pool.clone();
        let mock = server
            .mock("POST", "/orders")
            .with_status(201)
            .with_body_from_request(move |_request| {
                let insert_pool = insert_pool.clone();
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("failed to build throwaway runtime for synchronized insert");
                    rt.block_on(async {
                        sqlx::query("INSERT INTO orders_e2e (status) VALUES ('pending')")
                            .execute(&insert_pool)
                            .await
                            .unwrap();
                    });
                })
                .join()
                .expect("insert thread panicked");
                br#"{"id":1}"#.to_vec()
            })
            .create_async()
            .await;

        let result = run_correlated_request_impl(
            FireRequestInput {
                method: "POST".to_string(),
                url: format!("{}/orders", server.url()),
                body: None,
            },
            Some(pool.clone()),
            vec!["orders_e2e".to_string(), "untouched_e2e".to_string()],
            &crate::log_state::LogState::new(),
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(result.response.status_code, 201);
        let diffs = result.table_diffs.expect("diffs should be present");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].table, "orders_e2e");
        assert_eq!(diffs[0].inserted, 1);

        sqlx::query("DROP TABLE orders_e2e").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE untouched_e2e").execute(&pool).await.unwrap();
    }
```

(This drops the original's separate `insert_conn_str`/reconnect-inside-the-mock-closure step —
the closure now clones the already-open `pool` instead of reconnecting via `connection_string`,
since `connection_string(&DbConnectInput)` no longer exists. The mockito-runtime-thread reasoning
in the original's comment still applies unchanged and does not need to be re-justified.)

Apply the exact same two substitutions to every other test in this file:
1. `let conn = test_connection(); let pool = PgPoolOptions::new()...connect(&connection_string(&conn))...expect(...)` → `let pool = test_pool().await;`
2. Any call passing `conn` as the second argument to `run_correlated_request_impl(...)` or
   `run_correlated_request_impl_with_registry(...)` → pass `Some(pool.clone())` instead.

This applies to: `snapshot_and_diff_detects_a_real_update`, `a_db_failure_still_returns_the_response_and_reports_unable_to_verify` (this one has no real pool at all today — `conn` is passed but never separately connected; it becomes `None` in place of `Some(pool.clone())`, since the test's entire point is proving a failed/absent connection doesn't fail the command), `a_successful_diff_reports_an_empty_vec_not_a_null`, `a_correlation_window_captures_mail_sent_during_the_request`, `collecting_a_window_with_no_log_source_reports_not_observed_rather_than_zero` (also `None`, same reasoning as the DB-failure test), `full_correlated_request_flow_persists_a_history_entry` (also `None` — this test only exercises the HTTP+history path), `a_slow_request_does_not_shrink_its_own_correlation_window`, `mail_sent_before_the_request_is_not_attributed_to_it`, `a_stopped_catcher_reports_emails_as_not_observed_rather_than_zero`, `the_window_length_comes_from_the_caller_not_a_hardcoded_constant`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib correlation::`
Expected: PASS

- [ ] **Step 8: Full backend check**

Run: `cd apps/devbench/src-tauri && cargo build && cargo test`
Expected: PASS, entire suite green.

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/db.rs apps/devbench/src-tauri/src/commands/correlation.rs
git commit -m "feat(devbench): db.rs and correlation.rs take connection_id; add sort/pagination/pk_column; relocate get_primary_key_column"
```

---

## Task 6: `PendingPreviewRegistry` — hold an open transaction until Commit or timeout

**Files:**
- Create: `apps/devbench/src-tauri/src/preview_state.rs`
- Modify: `apps/devbench/src-tauri/src/lib.rs` (register the module)
- Modify: `apps/devbench/src-tauri/src/main.rs` (manage as state, spawn the sweep task)
- Test: inline `#[cfg(test)]` module in `preview_state.rs`

**Interfaces:**
- Produces: `PREVIEW_TIMEOUT_MS: i64` constant, `PendingPreviewRegistry::new() -> Self`, `fn hold(&self, tx: Transaction<'static, Postgres>, now_ms: i64, ttl_ms: i64) -> String` (returns a `preview_id`), `fn take(&self, preview_id: &str) -> Option<PendingPreview>` (removes and returns; a second call for the same id returns `None`), `async fn sweep_expired(&self, now_ms: i64)`.
- Consumed by: Task 7 (`query.rs`'s `preview_query`/`preview_cell_edit` call `hold`; `commit_preview`/`rollback_preview` call `take`).

Nothing here talks to `ConnectionRegistry` or any specific connection — this registry only knows how to hold a transaction it's handed and give it back once, or roll it back if forgotten. That separation is what makes it reusable for both the free-form query runner and cell edits without either knowing about the other.

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src-tauri/src/preview_state.rs`:

```rust
use sqlx::{Postgres, Row, Transaction};
use std::collections::HashMap;
use std::sync::Mutex;

/// How long an unresolved preview survives before the background sweep rolls
/// it back. Not user-configurable — a fixed constant, not a Settings field.
pub const PREVIEW_TIMEOUT_MS: i64 = 120_000;

pub struct PendingPreview {
    pub transaction: Transaction<'static, Postgres>,
    expires_at_ms: i64,
}

#[derive(Default)]
pub struct PendingPreviewRegistry {
    previews: Mutex<HashMap<String, PendingPreview>>,
}

impl PendingPreviewRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn hold(&self, transaction: Transaction<'static, Postgres>, now_ms: i64, ttl_ms: i64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        if let Ok(mut previews) = self.previews.lock() {
            previews.insert(id.clone(), PendingPreview { transaction, expires_at_ms: now_ms + ttl_ms });
        }
        id
    }

    pub fn take(&self, preview_id: &str) -> Option<PendingPreview> {
        self.previews.lock().ok()?.remove(preview_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> sqlx::PgPool {
        let host = std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into());
        let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into());
        let username = std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into());
        let password = std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into());
        let connection_string = crate::connection_registry::postgres_connection_string(
            &host, 5432, &database, &username, Some(&password), "disable",
        );
        sqlx::postgres::PgPoolOptions::new()
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }

    #[tokio::test]
    async fn a_preview_can_be_taken_once_and_only_once() {
        let pool = test_pool().await;
        let tx = pool.begin().await.unwrap();
        let registry = PendingPreviewRegistry::new();
        let id = registry.hold(tx, 0, PREVIEW_TIMEOUT_MS);

        assert!(registry.take(&id).is_some());
        assert!(registry.take(&id).is_none(), "a preview must not be resolvable twice");
    }

    #[tokio::test]
    async fn sweeping_before_expiry_leaves_the_preview_untouched() {
        let pool = test_pool().await;
        let tx = pool.begin().await.unwrap();
        let registry = PendingPreviewRegistry::new();
        let id = registry.hold(tx, 0, 60_000);

        registry.sweep_expired(30_000).await;
        assert!(registry.take(&id).is_some(), "an unexpired preview must survive a sweep");
    }

    #[tokio::test]
    async fn sweeping_after_expiry_rolls_back_and_evicts() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS sweep_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE sweep_test (id serial PRIMARY KEY)").execute(&pool).await.unwrap();

        let mut tx = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO sweep_test DEFAULT VALUES").execute(&mut *tx).await.unwrap();

        let registry = PendingPreviewRegistry::new();
        let id = registry.hold(tx, 0, 1_000);

        registry.sweep_expired(2_000).await;

        assert!(registry.take(&id).is_none(), "an expired preview must be evicted");

        let count: i64 = sqlx::query("SELECT COUNT(*) as n FROM sweep_test")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(count, 0, "the sweep must have rolled back the insert, not just dropped the handle");

        sqlx::query("DROP TABLE sweep_test").execute(&pool).await.unwrap();
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib preview_state::`
Expected: FAIL to compile — `sweep_expired` does not exist.

- [ ] **Step 3: Implement `sweep_expired`**

Add to the `impl PendingPreviewRegistry` block, before its closing `}`:

```rust
    /// Rolls back and evicts every preview whose expiry has passed. Called
    /// periodically by a background task (main.rs) — the only thing standing
    /// between an abandoned preview and a row lock held forever on the user's
    /// real database.
    pub async fn sweep_expired(&self, now_ms: i64) {
        let expired: Vec<PendingPreview> = {
            let mut previews = match self.previews.lock() {
                Ok(p) => p,
                Err(_) => return,
            };
            let expired_ids: Vec<String> = previews
                .iter()
                .filter(|(_, p)| p.expires_at_ms <= now_ms)
                .map(|(id, _)| id.clone())
                .collect();
            expired_ids.into_iter().filter_map(|id| previews.remove(&id)).collect()
        };
        for preview in expired {
            let _ = preview.transaction.rollback().await;
        }
    }
```

(The lock is held only long enough to collect ids and remove entries — never across an `.await` — so a slow rollback on one preview can't block every other command that touches this registry.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib preview_state::`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the module, manage it as state, spawn the sweep task**

In `apps/devbench/src-tauri/src/lib.rs`, add:
```rust
pub mod preview_state;
```

In `apps/devbench/src-tauri/src/main.rs`, add near the top (alongside `LOG_POLL_INTERVAL_MS`):
```rust
/// How often the preview sweep checks for expired transactions. 8x finer
/// than PREVIEW_TIMEOUT_MS, so an abandoned preview is never held much
/// longer than the timeout itself implies.
const PREVIEW_SWEEP_INTERVAL_MS: u64 = 15_000;
```

In `setup`, near where `logs` is created and its poll task spawned, add:
```rust
            let preview_registry = std::sync::Arc::new(devbench::preview_state::PendingPreviewRegistry::new());
            app.manage(std::sync::Arc::clone(&preview_registry));
            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_millis(PREVIEW_SWEEP_INTERVAL_MS));
                loop {
                    ticker.tick().await;
                    let now_ms = chrono::Utc::now().timestamp_millis();
                    preview_registry.sweep_expired(now_ms).await;
                }
            });
```

- [ ] **Step 6: Full backend check**

Run: `cd apps/devbench/src-tauri && cargo build && cargo test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src-tauri/src/preview_state.rs apps/devbench/src-tauri/src/lib.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): add PendingPreviewRegistry with a background expiry sweep"
```

---

## Task 7: `query.rs` — `preview_query`, `preview_cell_edit`, `commit_preview`, `rollback_preview`

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/query.rs`
- Modify: `apps/devbench/src-tauri/src/commands/db.rs` (`cell_to_string` becomes `pub(crate)` so this file can reuse it)
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs` (register `pub mod query;`)
- Modify: `apps/devbench/src-tauri/src/main.rs` (register 4 new commands)
- Test: inline `#[cfg(test)]` module in `query.rs`

**Interfaces:**
- Consumes: `ConnectionRegistry::pool_for` (Task 3), `PendingPreviewRegistry::hold`/`take` (Task 6), `validate_identifier`/`cell_to_string` (`db.rs`).
- Produces:
  - `QueryPreview { preview_id: String, columns: Vec<String>, rows: Vec<Vec<Option<String>>>, rows_affected: Option<u64> }`
  - `preview_query_impl(registry, previews, db, secrets, connection_id: &str, sql: &str, now_ms: i64) -> Result<QueryPreview, String>`
  - `preview_cell_edit_impl(registry, previews, db, secrets, connection_id: &str, table: &str, pk_column: &str, pk_value: &str, column: &str, value: Option<&str>, now_ms: i64) -> Result<QueryPreview, String>`
  - `commit_preview_impl(previews, preview_id: &str) -> Result<(), String>`
  - `rollback_preview_impl(previews, preview_id: &str) -> Result<(), String>`
  - Tauri commands `preview_query`, `preview_cell_edit`, `commit_preview`, `rollback_preview`.
- Consumed by: Task 12 (inline cell editing UI), Task 13 (query console drawer UI).

`rows_affected: Some(n)` with empty `rows` means a write completed with nothing to show — never rendered the same as a `SELECT` matching zero rows (`rows_affected: None`, `rows: []`). This is `correlation.rs`'s `None`-vs-`Some(vec![])` discipline and `db.rs`'s `NULL`-vs-`"<unsupported type>"` discipline, extended to a third case here.

- [ ] **Step 1: Make `cell_to_string` reusable**

In `apps/devbench/src-tauri/src/commands/db.rs`, change:
```rust
fn cell_to_string(row: &sqlx::postgres::PgRow, index: usize) -> Option<String> {
```
to:
```rust
pub(crate) fn cell_to_string(row: &sqlx::postgres::PgRow, index: usize) -> Option<String> {
```

- [ ] **Step 2: Write the failing tests**

Create `apps/devbench/src-tauri/src/commands/query.rs`:

```rust
use futures::TryStreamExt;
use serde::Serialize;
use sqlx::{Column, Either, Row};
use std::sync::Arc;
use tauri::State;

use crate::commands::db::{cell_to_string, validate_identifier};
use crate::connection_registry::ConnectionRegistry;
use crate::local_db::LocalDb;
use crate::preview_state::{PendingPreviewRegistry, PREVIEW_TIMEOUT_MS};
use crate::secrets::SecretStore;

#[derive(Debug, Serialize, PartialEq)]
pub struct QueryPreview {
    pub preview_id: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// `Some(n)` = a write that returned no rows of its own; `None` = a
    /// read-shaped result (rows, however many, is the whole story).
    pub rows_affected: Option<u64>,
}

/// The one place this codebase distinguishes "0 rows returned" from "N rows
/// affected" for an arbitrary single statement. Plain `fetch_all` can't make
/// this distinction — it silently discards the completion tag whenever any
/// rows come back, and reports nothing useful when none do.
async fn execute_with_honest_result(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, Option<u64>), String> {
    let mut rows: Vec<sqlx::postgres::PgRow> = Vec::new();
    let mut rows_affected: u64 = 0;
    {
        let mut stream = sqlx::query(sql).fetch_many(&mut **tx);
        while let Some(item) = stream.try_next().await.map_err(|e| format!("query failed: {e}"))? {
            match item {
                Either::Left(result) => rows_affected = result.rows_affected(),
                Either::Right(row) => rows.push(row),
            }
        }
    }

    if rows.is_empty() {
        Ok((Vec::new(), Vec::new(), Some(rows_affected)))
    } else {
        let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
        let out_rows = rows
            .iter()
            .map(|row| (0..columns.len()).map(|i| cell_to_string(row, i)).collect())
            .collect();
        Ok((columns, out_rows, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::{create_connection_impl, ConnectionInput};
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    fn local_dev_input() -> ConnectionInput {
        ConnectionInput {
            name: "Test".to_string(),
            engine: "postgres".to_string(),
            host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
            port: 5432,
            database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            sslmode: "disable".to_string(),
            password: Some(std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into())),
        }
    }

    async fn raw_pool() -> sqlx::PgPool {
        let input = local_dev_input();
        let connection_string = crate::connection_registry::postgres_connection_string(
            &input.host, input.port, &input.database, &input.username, input.password.as_deref(), &input.sslmode,
        );
        sqlx::postgres::PgPoolOptions::new()
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }

    #[tokio::test]
    async fn a_select_preview_returns_rows_with_no_affected_count() {
        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(&registry, &previews, &sqlite.pool, &secrets, &created.id, "SELECT 1 as n", 0)
            .await
            .unwrap();

        assert_eq!(preview.columns, vec!["n"]);
        assert_eq!(preview.rows.len(), 1);
        assert_eq!(preview.rows_affected, None);

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();
    }

    #[tokio::test]
    async fn a_write_preview_is_not_visible_until_commit() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS preview_write_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE preview_write_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO preview_write_test (status) VALUES ('pending')").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "UPDATE preview_write_test SET status = 'shipped' WHERE id = 1", 0,
        ).await.unwrap();

        assert_eq!(preview.rows, Vec::<Vec<Option<String>>>::new(), "a write with no RETURNING returns no rows");
        assert_eq!(preview.rows_affected, Some(1), "must report the honest affected-row count, not a false 0");

        let still_pending: String = sqlx::query("SELECT status FROM preview_write_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(still_pending, "pending", "an uncommitted preview must not be visible to another connection");

        commit_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let now_shipped: String = sqlx::query("SELECT status FROM preview_write_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(now_shipped, "shipped");

        sqlx::query("DROP TABLE preview_write_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn rollback_preview_discards_the_write() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS preview_rollback_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE preview_rollback_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO preview_rollback_test (status) VALUES ('pending')").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "UPDATE preview_rollback_test SET status = 'shipped' WHERE id = 1", 0,
        ).await.unwrap();

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let still_pending: String = sqlx::query("SELECT status FROM preview_rollback_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(still_pending, "pending");

        sqlx::query("DROP TABLE preview_rollback_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn committing_or_rolling_back_an_unknown_preview_id_is_a_clear_error() {
        let previews = PendingPreviewRegistry::new();
        assert!(commit_preview_impl(&previews, "not-a-real-id").await.is_err());
        assert!(rollback_preview_impl(&previews, "not-a-real-id").await.is_err());
    }

    #[tokio::test]
    async fn preview_cell_edit_rejects_malicious_identifiers() {
        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let result = preview_cell_edit_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "orders; DROP TABLE users; --", "id", "1", "status", Some("shipped"), 0,
        ).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn preview_cell_edit_updates_exactly_the_matched_row() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS cell_edit_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE cell_edit_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO cell_edit_test (status) VALUES ('pending')").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_cell_edit_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "cell_edit_test", "id", "1", "status", Some("shipped"), 0,
        ).await.unwrap();
        assert_eq!(preview.rows_affected, Some(1));

        commit_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let status: String = sqlx::query("SELECT status FROM cell_edit_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(status, "shipped");

        sqlx::query("DROP TABLE cell_edit_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn preview_cell_edit_errors_when_the_primary_key_value_matches_no_row() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS cell_edit_no_match_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE cell_edit_no_match_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let result = preview_cell_edit_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "cell_edit_no_match_test", "id", "999", "status", Some("shipped"), 0,
        ).await;
        assert!(result.is_err(), "a PK value matching no row must error rather than silently no-op");

        sqlx::query("DROP TABLE cell_edit_no_match_test").execute(&raw).await.unwrap();
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib query::`
Expected: FAIL to compile — none of `preview_query_impl`, `preview_cell_edit_impl`, `commit_preview_impl`, `rollback_preview_impl` exist yet.

- [ ] **Step 4: Implement the four `_impl` functions and their commands**

Add above the `#[cfg(test)]` block:

```rust
pub async fn preview_query_impl(
    registry: &ConnectionRegistry,
    previews: &PendingPreviewRegistry,
    db: &sqlx::SqlitePool,
    secrets: &dyn SecretStore,
    connection_id: &str,
    sql: &str,
    now_ms: i64,
) -> Result<QueryPreview, String> {
    let pool = registry.pool_for(connection_id, db, secrets).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;
    let (columns, rows, rows_affected) = execute_with_honest_result(&mut tx, sql).await?;
    let preview_id = previews.hold(tx, now_ms, PREVIEW_TIMEOUT_MS);
    Ok(QueryPreview { preview_id, columns, rows, rows_affected })
}

#[allow(clippy::too_many_arguments)]
pub async fn preview_cell_edit_impl(
    registry: &ConnectionRegistry,
    previews: &PendingPreviewRegistry,
    db: &sqlx::SqlitePool,
    secrets: &dyn SecretStore,
    connection_id: &str,
    table: &str,
    pk_column: &str,
    pk_value: &str,
    column: &str,
    value: Option<&str>,
    now_ms: i64,
) -> Result<QueryPreview, String> {
    validate_identifier(table)?;
    validate_identifier(pk_column)?;
    validate_identifier(column)?;

    let pool = registry.pool_for(connection_id, db, secrets).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;

    let sql = format!("UPDATE \"{table}\" SET \"{column}\" = $1 WHERE \"{pk_column}\" = $2");
    let result = sqlx::query(&sql)
        .bind(value)
        .bind(pk_value)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("update failed: {e}"))?;

    if result.rows_affected() != 1 {
        // A PK match of zero or more than one row means something is wrong
        // with the assumption this edit was built on — not something to
        // preview and let the user paper over.
        let _ = tx.rollback().await;
        return Err(format!(
            "expected to match exactly 1 row by {pk_column} = {pk_value}, matched {}",
            result.rows_affected()
        ));
    }

    let preview_id = previews.hold(tx, now_ms, PREVIEW_TIMEOUT_MS);
    Ok(QueryPreview { preview_id, columns: vec![], rows: vec![], rows_affected: Some(1) })
}

pub async fn commit_preview_impl(previews: &PendingPreviewRegistry, preview_id: &str) -> Result<(), String> {
    let preview = previews.take(preview_id).ok_or_else(|| format!("no open preview with id {preview_id}"))?;
    preview.transaction.commit().await.map_err(|e| format!("commit failed: {e}"))
}

pub async fn rollback_preview_impl(previews: &PendingPreviewRegistry, preview_id: &str) -> Result<(), String> {
    let preview = previews.take(preview_id).ok_or_else(|| format!("no open preview with id {preview_id}"))?;
    preview.transaction.rollback().await.map_err(|e| format!("rollback failed: {e}"))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn preview_query(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    registry: State<'_, Arc<ConnectionRegistry>>,
    previews: State<'_, Arc<PendingPreviewRegistry>>,
    connection_id: String,
    sql: String,
) -> Result<QueryPreview, String> {
    preview_query_impl(&registry, &previews, &db.pool, secrets.as_ref(), &connection_id, &sql, chrono::Utc::now().timestamp_millis()).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn preview_cell_edit(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    registry: State<'_, Arc<ConnectionRegistry>>,
    previews: State<'_, Arc<PendingPreviewRegistry>>,
    connection_id: String,
    table: String,
    pk_column: String,
    pk_value: String,
    column: String,
    value: Option<String>,
) -> Result<QueryPreview, String> {
    preview_cell_edit_impl(
        &registry, &previews, &db.pool, secrets.as_ref(), &connection_id,
        &table, &pk_column, &pk_value, &column, value.as_deref(),
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}

#[tauri::command]
pub async fn commit_preview(previews: State<'_, Arc<PendingPreviewRegistry>>, preview_id: String) -> Result<(), String> {
    commit_preview_impl(&previews, &preview_id).await
}

#[tauri::command]
pub async fn rollback_preview(previews: State<'_, Arc<PendingPreviewRegistry>>, preview_id: String) -> Result<(), String> {
    rollback_preview_impl(&previews, &preview_id).await
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib query::`
Expected: PASS (8 tests)

- [ ] **Step 6: Register the module and the new commands**

In `apps/devbench/src-tauri/src/commands/mod.rs`, add:
```rust
pub mod query;
```

In `apps/devbench/src-tauri/src/main.rs`, add to `tauri::generate_handler![...]`:
```rust
            commands::query::preview_query,
            commands::query::preview_cell_edit,
            commands::query::commit_preview,
            commands::query::rollback_preview,
```

- [ ] **Step 7: Full backend check**

Run: `cd apps/devbench/src-tauri && cargo build && cargo test`
Expected: PASS, entire backend suite green. This is the last backend task — every Rust command the frontend tasks need now exists.

- [ ] **Step 8: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/query.rs apps/devbench/src-tauri/src/commands/db.rs apps/devbench/src-tauri/src/commands/mod.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): add preview/commit/rollback query runner and cell-edit commands"
```

---

## Task 8: Frontend — connection types/wrappers, `ConnectionsPane`, and its add/edit modal

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Create: `apps/devbench/src/components/settings/ConnectionsPane.tsx`
- Create: `apps/devbench/src/components/settings/ConnectionModal.tsx`
- Create: `apps/devbench/src/components/settings/ConnectionsPane.test.tsx`
- Modify: `apps/devbench/src/components/settings/SettingsScreen.tsx`
- Modify: `apps/devbench/src/components/settings/SettingsScreen.test.tsx`

**Interfaces:**
- Consumes: Task 2/4's `list_connections`/`create_connection`/`update_connection`/`delete_connection`/`set_connection_password`/`test_connection`/`test_saved_connection` commands.
- Produces: `ConnectionSummary`, `ConnectionInput` TS types; `invokeListConnections`, `invokeCreateConnection`, `invokeUpdateConnection`, `invokeDeleteConnection`, `invokeSetConnectionPassword`, `invokeClearConnectionPassword`, `invokeTestConnection`, `invokeTestSavedConnection`; `<ConnectionsPane />`, `<ConnectionModal existing={ConnectionSummary | null} onClose onSaved />`.
- Consumed by: Task 9 (`DbTab`'s connection picker reads `invokeListConnections`).

This codebase has no test file for `lib/tauri.ts` itself — its wrapper functions are thin `invoke()` pass-throughs with no logic of their own, exercised indirectly through the components that call them. `ConnectionsPane.test.tsx` is that exercise for everything added here.

- [ ] **Step 1: Add types and wrapper functions**

In `apps/devbench/src/lib/tauri.ts`, add:

```ts
export interface ConnectionSummary {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
  has_password: boolean;
}

export interface ConnectionInput {
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
  password?: string | null;
}

export function invokeListConnections(): Promise<ConnectionSummary[]> {
  return invoke("list_connections");
}

export function invokeCreateConnection(input: ConnectionInput): Promise<ConnectionSummary> {
  return invoke("create_connection", { input });
}

export function invokeUpdateConnection(id: string, input: ConnectionInput): Promise<ConnectionSummary> {
  return invoke("update_connection", { id, input });
}

export function invokeDeleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

export function invokeSetConnectionPassword(id: string, password: string): Promise<void> {
  return invoke("set_connection_password", { id, password });
}

export function invokeClearConnectionPassword(id: string): Promise<void> {
  return invoke("clear_connection_password", { id });
}

export function invokeTestConnection(input: ConnectionInput): Promise<void> {
  return invoke("test_connection", { input });
}

export function invokeTestSavedConnection(id: string): Promise<void> {
  return invoke("test_saved_connection", { id });
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/devbench/src/components/settings/ConnectionsPane.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConnectionsPane } from "./ConnectionsPane";
import * as tauriLib from "../../lib/tauri";
import type { ConnectionSummary } from "../../lib/tauri";

function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: "c1",
    name: "Local Dev",
    engine: "postgres",
    host: "localhost",
    port: 5432,
    database: "devbench_test",
    username: "postgres",
    sslmode: "disable",
    has_password: true,
    ...overrides,
  };
}

describe("ConnectionsPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists saved connections", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    render(<ConnectionsPane />);
    await waitFor(() => expect(screen.getByText("Local Dev")).toBeInTheDocument());
    expect(screen.getByText(/localhost:5432\/devbench_test/)).toBeInTheDocument();
  });

  it("opens a blank modal when Add connection is clicked", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("+ Add connection"));
    fireEvent.click(screen.getByText("+ Add connection"));
    expect(await screen.findByText("Add a connection")).toBeInTheDocument();
  });

  it("opens an edit modal pre-filled with the connection's real values", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([
      connection({ name: "Staging", host: "staging-db.internal" }),
    ]);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Staging"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Staging" }));
    expect(await screen.findByText("Edit connection — Staging")).toBeInTheDocument();
    expect(screen.getByDisplayValue("staging-db.internal")).toBeInTheDocument();
  });

  it("never renders a stored password's value", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local Dev" }));
    const passwordInput = (await screen.findByPlaceholderText("•••••••• (stored)")) as HTMLInputElement;
    expect(passwordInput.value).toBe("");
  });

  it("deletes a connection", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    const del = vi.spyOn(tauriLib, "invokeDeleteConnection").mockResolvedValue(undefined);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Local Dev" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("c1"));
  });

  it("creates a connection from the add modal without ever calling set_connection_password for a fresh create", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    const create = vi.spyOn(tauriLib, "invokeCreateConnection").mockResolvedValue(connection());
    const setPassword = vi.spyOn(tauriLib, "invokeSetConnectionPassword").mockResolvedValue(undefined);

    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("+ Add connection"));
    fireEvent.click(screen.getByText("+ Add connection"));

    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Staging" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "staging-db.internal" } });
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "app" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "app_ro" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Staging" })));
    expect(setPassword).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test -- ConnectionsPane`
Expected: FAIL — `ConnectionsPane` does not exist.

- [ ] **Step 4: Implement `ConnectionModal`**

Create `apps/devbench/src/components/settings/ConnectionModal.tsx`:

```tsx
import { useState } from "react";
import {
  invokeCreateConnection,
  invokeUpdateConnection,
  invokeSetConnectionPassword,
  invokeTestConnection,
  type ConnectionInput,
  type ConnectionSummary,
} from "../../lib/tauri";

const inputClass = "rounded-sm border border-border bg-bg px-2.5 py-2 text-sm font-normal normal-case text-text";
const labelClass = "flex flex-col gap-1 text-xs font-bold uppercase text-text-faint";

export function ConnectionModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: ConnectionSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ConnectionInput>({
    name: existing?.name ?? "",
    engine: existing?.engine ?? "postgres",
    host: existing?.host ?? "",
    port: existing?.port ?? 5432,
    database: existing?.database ?? "",
    username: existing?.username ?? "",
    sslmode: existing?.sslmode ?? "disable",
    password: "",
  });
  const [testResult, setTestResult] = useState<"idle" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function field<K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function test() {
    setTestResult("idle");
    try {
      await invokeTestConnection(form);
      setTestResult("ok");
    } catch {
      setTestResult("error");
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        await invokeUpdateConnection(existing.id, { ...form, password: undefined });
        // A blank password field on an edit means "leave it alone" — only a
        // password the user actually typed gets written.
        if (form.password) {
          await invokeSetConnectionPassword(existing.id, form.password);
        }
      } else {
        await invokeCreateConnection(form);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45"
      onClick={onClose}
    >
      <div
        className="w-140 max-w-[calc(100vw-40px)] max-h-[calc(100vh-80px)] overflow-y-auto rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] shadow-lg backdrop-blur-[22px] backdrop-saturate-[1.55]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-sm font-bold text-text">
            {existing ? `Edit connection — ${existing.name}` : "Add a connection"}
          </h3>
          <button onClick={onClose} aria-label="Close" className="text-text-faint hover:text-text">
            ✕
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 p-4">
          <label className={labelClass}>
            Name
            <input value={form.name} onChange={(e) => field("name", e.target.value)} className={inputClass} />
          </label>
          <label className={labelClass}>
            Engine
            <select value={form.engine} onChange={(e) => field("engine", e.target.value)} className={inputClass}>
              <option value="postgres">postgres</option>
              <option value="sqlite" disabled>sqlite (reserved — not yet supported)</option>
            </select>
          </label>
          <label className={labelClass}>
            Host
            <input value={form.host} onChange={(e) => field("host", e.target.value)} className={inputClass} />
          </label>
          <label className={labelClass}>
            Port
            <input
              type="number"
              value={form.port}
              onChange={(e) => field("port", Number(e.target.value))}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Database
            <input value={form.database} onChange={(e) => field("database", e.target.value)} className={inputClass} />
          </label>
          <label className={labelClass}>
            Username
            <input value={form.username} onChange={(e) => field("username", e.target.value)} className={inputClass} />
          </label>
          <label className={labelClass}>
            Password
            <input
              type="password"
              autoComplete="off"
              value={form.password ?? ""}
              onChange={(e) => field("password", e.target.value)}
              placeholder={existing?.has_password ? "•••••••• (stored)" : "Enter a password"}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            SSL mode
            <select value={form.sslmode} onChange={(e) => field("sslmode", e.target.value)} className={inputClass}>
              <option value="disable">disable</option>
              <option value="require">require</option>
              <option value="verify-full">verify-full</option>
            </select>
          </label>
        </div>
        <div className="px-4 text-xs text-text-faint">
          Password is written to your OS keychain only when Save succeeds; a failed test never touches storage.
        </div>
        {testResult !== "idle" ? (
          <div className={`mx-4 mt-2 text-xs ${testResult === "ok" ? "text-success" : "text-danger"}`}>
            {testResult === "ok" ? "Connected successfully." : "Could not connect."}
          </div>
        ) : null}
        {error ? <div className="mx-4 mt-2 text-xs text-danger">{error}</div> : null}
        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          <button onClick={() => void test()} className="rounded-sm border border-border px-3 py-2 text-sm text-text-muted">
            Test connection
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-sm px-3 py-2 text-sm text-text-muted hover:bg-surface-2">
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="rounded-sm bg-accent px-3 py-2 text-sm font-bold text-accent-on disabled:opacity-50"
            >
              Save connection
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `ConnectionsPane`**

Create `apps/devbench/src/components/settings/ConnectionsPane.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  invokeListConnections,
  invokeDeleteConnection,
  invokeTestSavedConnection,
  type ConnectionSummary,
} from "../../lib/tauri";
import { ConnectionModal } from "./ConnectionModal";

type ModalState = { mode: "add" } | { mode: "edit"; connection: ConnectionSummary } | null;

export function ConnectionsPane() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [statuses, setStatuses] = useState<Record<string, "ok" | "error">>({});
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const refresh = useCallback(async () => {
    try {
      setConnections(await invokeListConnections());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function test(id: string) {
    try {
      await invokeTestSavedConnection(id);
      setStatuses((prev) => ({ ...prev, [id]: "ok" }));
    } catch {
      setStatuses((prev) => ({ ...prev, [id]: "error" }));
    }
  }

  async function remove(id: string) {
    await invokeDeleteConnection(id).catch(() => {});
    await refresh();
  }

  return (
    <div className="max-w-160">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-text">Connections</h2>
          <p className="mt-1 text-sm text-text-muted">
            Databases DevBench can browse, query, and watch. Passwords are stored in your OS keychain, never here.
          </p>
        </div>
        <button
          onClick={() => setModal({ mode: "add" })}
          className="shrink-0 rounded-sm bg-accent px-3 py-2 text-sm font-bold text-accent-on"
        >
          + Add connection
        </button>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        {connections.length === 0 ? (
          <div className="rounded-lg border border-border p-4 text-sm text-text-faint">
            No connections configured. Add one to browse and query a database.
          </div>
        ) : (
          connections.map((c) => (
            <div key={c.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text">{c.name}</div>
                  <div className="truncate font-mono text-xs text-text-muted">
                    {c.engine} · {c.host}:{c.port}/{c.database}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {statuses[c.id] ? (
                    <span
                      className={`rounded-sm px-2 py-0.5 text-[11px] font-semibold ${
                        statuses[c.id] === "ok" ? "bg-success-bg text-success" : "bg-danger-bg text-danger"
                      }`}
                    >
                      {statuses[c.id] === "ok" ? "Connected" : "Error"}
                    </span>
                  ) : null}
                  <button
                    aria-label={`Test ${c.name}`}
                    onClick={() => void test(c.id)}
                    className="rounded-sm px-2 py-1 text-xs text-text-muted hover:bg-surface-2"
                  >
                    Test
                  </button>
                  <button
                    aria-label={`Edit ${c.name}`}
                    onClick={() => setModal({ mode: "edit", connection: c })}
                    className="rounded-sm px-2 py-1 text-xs text-text-muted hover:bg-surface-2"
                  >
                    Edit
                  </button>
                  <button
                    aria-label={`Delete ${c.name}`}
                    onClick={() => void remove(c.id)}
                    className="rounded-sm px-2 py-1 text-xs text-text-faint hover:bg-surface-2 hover:text-text"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      {error ? <div className="mt-2 text-xs text-danger">{error}</div> : null}

      {modal ? (
        <ConnectionModal
          existing={modal.mode === "edit" ? modal.connection : null}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test -- ConnectionsPane`
Expected: PASS (6 tests)

- [ ] **Step 7: Register the pane in Settings**

In `apps/devbench/src/components/settings/SettingsScreen.tsx`, add the import, add `"connections"` to `PaneId` and to the `PANES` array (after `"provider"`, matching the spec's nav order), and add its `<Tabs.Panel>`:

```tsx
import { ConnectionsPane } from "./ConnectionsPane";
```
```tsx
type PaneId = "general" | "provider" | "connections" | "mcp" | "archive";
```
```tsx
const PANES: { id: PaneId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "provider", label: "Provider" },
  { id: "connections", label: "Connections" },
  { id: "mcp", label: "MCP" },
  { id: "archive", label: "Archive" },
];
```
```tsx
          <Tabs.Panel value="connections" className="p-6">
            <ConnectionsPane />
          </Tabs.Panel>
```
(placed after the `"provider"` panel, before `"mcp"`)

In `apps/devbench/src/components/settings/SettingsScreen.test.tsx`, find the assertion(s) that enumerate the settings nav items (e.g. a list of expected labels or a count of `Tabs.Tab` entries) and add `"Connections"` in the same position as the `PANES` array above. Run Step 8 to discover the exact assertion text if it isn't obvious from a read-through.

- [ ] **Step 8: Full frontend check**

Run: `cd apps/devbench && bun run test`
Expected: PASS

Run: `cd apps/devbench && bun run build`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/components/settings
git commit -m "feat(devbench): add ConnectionsPane with a modal add/edit form"
```

---

## Task 9: Frontend — `activeConnectionId`, `DEV_CONNECTION` removal, `SchemaTree`/`DbTab`/`ApiTab` wiring

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts` (existing wrapper signatures: `connection_id` instead of `DbConnectInput`; `DbConnectInput` type deleted)
- Modify: `apps/devbench/src/store/useAppStore.ts` (`activeConnectionId`)
- Modify: `apps/devbench/src/App.tsx`, `apps/devbench/src/App.test.tsx`
- Modify: `apps/devbench/src/components/api/ApiTab.tsx`, `ApiTab.test.tsx`
- Modify: `apps/devbench/src/components/api/RequestBuilder.tsx`, `RequestBuilder.test.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`, `DbTab.test.tsx`
- Modify: `apps/devbench/src/components/db/SchemaTree.tsx`, `SchemaTree.test.tsx`

**Interfaces:**
- Consumes: Task 5's `list_table_rows`/`db_connect_and_list_tables`/`run_correlated_request` (now `connection_id`-based), Task 1's `list_watched_tables`/`set_watched_table` (now `connection_id`-based), Task 8's `invokeListConnections`.
- Produces: `activeConnectionId: string | null` + `setActiveConnectionId` on `useAppStore`; `<SchemaTree connectionId onConnectionChange />`; `<DbTab />` and `<ApiTab />` no longer take any connection prop from a hardcoded constant.
- Consumed by: Task 11 (grid pagination/sort reads `activeConnectionId` via `DbTab`), Task 12/13 (cell editing and the query console both need `activeConnectionId`).

`TableRows.pk_column` (added in Task 5) is threaded through here but not rendered yet — Task 11 is what makes the grid actually use it.

- [ ] **Step 1: Update `lib/tauri.ts`'s existing wrappers and delete `DbConnectInput`**

In `apps/devbench/src/lib/tauri.ts`, delete the `DbConnectInput` interface entirely, then replace the five affected wrappers:

```ts
export interface TableRows {
  columns: string[];
  rows: (string | null)[][];
  pk_column: string | null;
}

export function invokeDbConnectAndListTables(connectionId: string): Promise<TableInfo[]> {
  return invoke("db_connect_and_list_tables", { connectionId });
}

export function invokeListTableRows(
  connectionId: string,
  table: string,
  options?: { orderByColumn?: string | null; orderByDesc?: boolean; limit?: number; offset?: number },
): Promise<TableRows> {
  return invoke("list_table_rows", {
    connectionId,
    table,
    orderByColumn: options?.orderByColumn ?? null,
    orderByDesc: options?.orderByDesc ?? false,
    limit: options?.limit ?? 100,
    offset: options?.offset ?? 0,
  });
}

export function invokeListWatchedTables(connectionId: string): Promise<string[]> {
  return invoke("list_watched_tables", { connectionId });
}

export function invokeSetWatchedTable(connectionId: string, table: string, watched: boolean): Promise<void> {
  return invoke("set_watched_table", { connectionId, table, watched });
}

export function invokeRunCorrelatedRequest(args: {
  request: FireRequestInput;
  connectionId: string;
  watchedTables: string[];
  sessionId?: string | null;
}): Promise<CorrelationResult> {
  return invoke("run_correlated_request", {
    request: args.request,
    connectionId: args.connectionId,
    watchedTables: args.watchedTables,
    sessionId: args.sessionId ?? null,
  });
}
```

(Leave `TableInfo`, `FireRequestInput`, `CorrelationResult` exactly as they are — only the five functions above and the `TableRows`/`DbConnectInput` types change.)

- [ ] **Step 2: Add `activeConnectionId` to the store**

In `apps/devbench/src/store/useAppStore.ts`, add a field and setter with the exact same shape as the existing `activeSessionId`/`setActiveSessionId` pair:

```ts
  activeConnectionId: string | null;
  setActiveConnectionId: (id: string | null) => void;
```
and in the store's creator body:
```ts
  activeConnectionId: null,
  setActiveConnectionId: (id) => set({ activeConnectionId: id }),
```

- [ ] **Step 3: Write the failing tests**

Replace `apps/devbench/src/components/db/SchemaTree.test.tsx` entirely:

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SchemaTree } from "./SchemaTree";
import * as tauriLib from "../../lib/tauri";

describe("SchemaTree", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists tables for the given connection", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);

    render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
  });

  it("shows saved connections in the picker and reports a change", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([
      { id: "c1", name: "Local Dev", engine: "postgres", host: "localhost", port: 5432, database: "devbench_test", username: "postgres", sslmode: "disable", has_password: true },
      { id: "c2", name: "Staging", engine: "postgres", host: "staging-db.internal", port: 5432, database: "app", username: "app_ro", sslmode: "require", has_password: true },
    ]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    const onConnectionChange = vi.fn();

    render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={onConnectionChange}
      />,
    );

    const picker = await screen.findByLabelText("Connection");
    await waitFor(() => expect(screen.getByText("Staging")).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: "c2" } });

    expect(onConnectionChange).toHaveBeenCalledWith("c2");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test -- SchemaTree`
Expected: FAIL — `SchemaTree` still takes a `connection: DbConnectInput` prop and renders no picker.

- [ ] **Step 5: Rewrite `SchemaTree.tsx`**

Replace `apps/devbench/src/components/db/SchemaTree.tsx` entirely:

```tsx
import { useEffect, useState } from "react";
import {
  invokeDbConnectAndListTables,
  invokeListConnections,
  type ConnectionSummary,
  type TableInfo,
} from "../../lib/tauri";

export function SchemaTree({
  connectionId,
  watchedTables,
  onToggleWatch,
  onSelectTable,
  onConnectionChange,
}: {
  connectionId: string | null;
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  onSelectTable: (table: string) => void;
  onConnectionChange: (connectionId: string) => void;
}) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invokeListConnections().then(setConnections).catch(() => setConnections([]));
  }, []);

  useEffect(() => {
    if (!connectionId) return;
    setError(null);
    invokeDbConnectAndListTables(connectionId)
      .then(setTables)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [connectionId]);

  function select(name: string) {
    setSelected(name);
    onSelectTable(name);
  }

  return (
    <aside className="w-50 min-w-50 border-r border-border">
      <div className="border-b border-border p-2">
        <select
          aria-label="Connection"
          value={connectionId ?? ""}
          onChange={(e) => onConnectionChange(e.target.value)}
          className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-xs font-bold text-text"
        >
          {connections.length === 0 ? <option value="">No connections</option> : null}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <div className="rounded-lg m-1.5 border border-border bg-danger-bg p-2.5 text-xs text-danger">
          {error}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 p-1.5">
          {tables.map((t) => (
            <div
              key={`${t.schema}.${t.name}`}
              className={`flex items-center gap-1.5 rounded-sm p-1.5 ${
                selected === t.name ? "bg-surface-2 text-text" : "text-text-muted"
              }`}
            >
              <button
                type="button"
                aria-label={`watch ${t.name}`}
                aria-pressed={watchedTables.has(t.name)}
                onClick={() => onToggleWatch(t.name)}
                className={`h-2.5 w-2.5 flex-shrink-0 rounded-full border ${
                  watchedTables.has(t.name) ? "border-text bg-text" : "border-text-faint"
                }`}
              />
              <button
                type="button"
                aria-label={`Browse ${t.name}`}
                aria-current={selected === t.name}
                onClick={() => select(t.name)}
                className="flex-1 truncate text-left"
              >
                {t.name}
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test -- SchemaTree`
Expected: PASS (2 tests)

- [ ] **Step 7: Rewrite `DbTab.tsx`**

Replace `apps/devbench/src/components/db/DbTab.tsx` entirely:

```tsx
import { useEffect, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid } from "./DataGrid";
import { invokeListTableRows, invokeListWatchedTables, invokeSetWatchedTable, type TableRows } from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

export function DbTab({
  watchedTables,
  onToggleWatch,
  focusTable,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  focusTable: string | null;
}) {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  async function handleSelectTable(table: string) {
    if (!activeConnectionId) return;
    setError(null);
    try {
      const rows = await invokeListTableRows(activeConnectionId, table);
      setTableRows(rows);
    } catch (err) {
      setTableRows(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (focusTable) void handleSelectTable(focusTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTable]);

  // Watch state is scoped per connection now, not just per app. Re-hydrating
  // whenever activeConnectionId changes keeps it in sync with the picker.
  useEffect(() => {
    if (!activeConnectionId) return;
    invokeListWatchedTables(activeConnectionId)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [activeConnectionId, setWatchedTables]);

  async function handleToggleWatch(table: string) {
    if (!activeConnectionId) return;
    const nextWatched = !watchedTables.has(table);
    onToggleWatch(table);
    try {
      await invokeSetWatchedTable(activeConnectionId, table, nextWatched);
    } catch {
      onToggleWatch(table);
    }
  }

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connectionId={activeConnectionId}
        watchedTables={watchedTables}
        onToggleWatch={handleToggleWatch}
        onSelectTable={handleSelectTable}
        onConnectionChange={setActiveConnectionId}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {error ? (
          <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
        ) : tableRows ? (
          <DataGrid columns={tableRows.columns} rows={tableRows.rows} />
        ) : null}
      </div>
    </div>
  );
}
```

Update `apps/devbench/src/components/db/DbTab.test.tsx`: every mock/assertion referencing `DEV_CONNECTION`, a `connection` prop, or the old `invokeListTableRows(connection, table)`/`invokeListWatchedTables(connection)`/`invokeSetWatchedTable(connection, ...)` call shapes now uses a plain connection id string (e.g. `"c1"`) in their place, and `useAppStore.getState().setActiveConnectionId("c1")` replaces whatever previously stood in for "the active connection" in test setup. Mirror the existing tests' structure exactly — only the connection representation changes, not what's being asserted.

- [ ] **Step 8: Update `App.tsx`**

In `apps/devbench/src/App.tsx`, delete the `DEV_CONNECTION` constant and its comment (`App.tsx:15-24`), and replace the watched-tables hydration effect:

```tsx
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
```

```tsx
  // Establishes which connection is active on launch — the natural single-
  // connection case (today, just the seeded 'default' row) resolves to
  // whichever connection list_connections returns first.
  useEffect(() => {
    invokeListConnections()
      .then((connections) => {
        if (connections.length > 0) setActiveConnectionId(connections[0].id);
      })
      .catch(() => {});
  }, [setActiveConnectionId]);

  // Watch state lives in SQLite, keyed by connection. Re-running this
  // whenever activeConnectionId changes (not just once on mount) keeps
  // ApiTab's correlation watch set in sync with whichever connection is
  // selected, including switches made later from the DB tab's picker.
  useEffect(() => {
    if (!activeConnectionId) return;
    invokeListWatchedTables(activeConnectionId)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [activeConnectionId, setWatchedTables]);
```

Add `invokeListConnections` to the existing `lib/tauri` import list. Remove the now-unused `DbConnectInput` import if it was only used for `DEV_CONNECTION`'s type annotation.

Update `apps/devbench/src/App.test.tsx`: wherever a test mocked `invokeListWatchedTables` expecting it to be called with the old `DEV_CONNECTION` object, add a mock for `invokeListConnections` resolving to `[{ id: "c1", name: "Local Dev", ... }]` (full `ConnectionSummary` shape) so the new mount effect has something to resolve, and change the `invokeListWatchedTables` assertion to expect `"c1"` instead of the old connection object.

- [ ] **Step 9: Update `ApiTab.tsx` and `RequestBuilder.tsx`**

In `apps/devbench/src/components/api/ApiTab.tsx`, delete the `DEV_CONNECTION` constant, add:
```tsx
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
```
and change the `<RequestBuilder connection={DEV_CONNECTION} .../>` prop to:
```tsx
        <RequestBuilder
          connectionId={activeConnectionId}
          watchedTables={watchedTables}
          sessionId={activeSessionId}
          onSendStart={handleSendStart}
          onResult={handleResult}
          onError={handleError}
        />
```

In `apps/devbench/src/components/api/RequestBuilder.tsx`, replace the `connection: DbConnectInput` prop with `connectionId: string | null`, and change the invoke call:
```tsx
      const result = await invokeRunCorrelatedRequest({
        request: { method, url, body: undefined },
        connectionId,
        watchedTables: Array.from(watchedTables),
        sessionId,
      });
```
Guard the Send action so it's a no-op (rather than sending `connectionId: null` to the backend) when nothing is selected yet:
```tsx
  async function send() {
    if (!connectionId) return;
    // ...existing body...
```

Update `apps/devbench/src/components/api/ApiTab.test.tsx` and `RequestBuilder.test.tsx`: replace every `connection={...}`/`connection:` object literal with a plain connection id string (e.g. `"c1"`), and every `expect(tauriLib.invokeRunCorrelatedRequest).toHaveBeenCalledWith({ request: ..., connection: ..., watchedTables: ..., sessionId: ... })` assertion's `connection: ...` key with `connectionId: "c1"`.

- [ ] **Step 10: Run the full frontend suite**

Run: `cd apps/devbench && bun run test`
Expected: PASS

Run: `cd apps/devbench && bun run build`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/store/useAppStore.ts apps/devbench/src/App.tsx apps/devbench/src/App.test.tsx apps/devbench/src/components/api apps/devbench/src/components/db/SchemaTree.tsx apps/devbench/src/components/db/SchemaTree.test.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): wire activeConnectionId through DbTab/ApiTab, remove DEV_CONNECTION"
```

---

## Task 10: `DataGrid` redesign — virtualization, sort, pagination, type-aware cells, copy

**Files:**
- Modify: `apps/devbench/src/components/db/DataGrid.tsx`
- Modify: `apps/devbench/src/components/db/DataGrid.test.tsx`

**Interfaces:**
- Produces: `DataGridProps { columns, rows, sortColumn?, sortDescending?, onSort?, hasNextPage?, hasPrevPage?, onPrevPage?, onNextPage?, renderCell?: (rowIndex, columnIndex, value) => ReactNode }`.
- Consumed by: Task 11 (wires real sort/pagination against `list_table_rows`), Task 12 (`renderCell` is the seam inline editing hooks into — no fork of this component needed).

This task is self-contained and props-driven: it doesn't touch `DbTab`, `activeConnectionId`, or any backend call. Everything is verified with mock `columns`/`rows` data.

**Scope note carried over from the design doc:** per-cell copy is satisfied by ordinary text selection (cell content is plain selectable text, not an interactive control unless `renderCell` makes it one) — no dedicated per-cell copy affordance is built here, only row-level "copy as TSV" / "copy as JSON."

Row virtualization uses CSS Grid (`display: grid` with a `gridTemplateColumns` shared between the header and every virtual row), not `<table>` layout — a `<table>`/`<tbody>` re-flows its column widths independently per absolutely-positioned `<tr>`, which desyncs column alignment between rows the moment they're virtualized. Grid sidesteps that: one `gridTemplateColumns` string, applied identically everywhere, is the only thing establishing column widths.

- [ ] **Step 1: Write the failing tests**

Replace `apps/devbench/src/components/db/DataGrid.test.tsx` entirely:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DataGrid } from "./DataGrid";

beforeEach(() => {
  vi.restoreAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("DataGrid", () => {
  it("renders columns and row values", () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("renders NULL distinctly from an empty string", () => {
    render(<DataGrid columns={["notes"]} rows={[[null]]} />);
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("renders the unsupported-type marker distinctly", () => {
    render(<DataGrid columns={["amount"]} rows={[["<unsupported type>"]]} />);
    expect(screen.getByText("<unsupported type>")).toBeInTheDocument();
  });

  it("calls onSort with the clicked column", () => {
    const onSort = vi.fn();
    render(<DataGrid columns={["id", "status"]} rows={[]} onSort={onSort} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
    expect(onSort).toHaveBeenCalledWith("status");
  });

  it("shows the sort direction indicator on the active column", () => {
    render(<DataGrid columns={["id"]} rows={[]} sortColumn="id" sortDescending={false} />);
    expect(screen.getByText("▲")).toBeInTheDocument();
  });

  it("disables Prev on the first page and Next when there is no next page", () => {
    render(<DataGrid columns={["id"]} rows={[]} hasPrevPage={false} hasNextPage={false} />);
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("calls onNextPage when Next is enabled and clicked", () => {
    const onNextPage = vi.fn();
    render(<DataGrid columns={["id"]} rows={[]} hasNextPage onNextPage={onNextPage} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNextPage).toHaveBeenCalled();
  });

  it("copies a row as tab-separated values", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy row as tab-separated values" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("1\tpending");
  });

  it("copies a row as JSON", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy row as JSON" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify({ id: "1", status: "pending" }));
  });

  it("lets a consumer override cell rendering (the seam Task 12 uses for inline editing)", () => {
    render(
      <DataGrid
        columns={["status"]}
        rows={[["pending"]]}
        renderCell={(_r, _c, value) => <span data-testid="custom-cell">{value}-custom</span>}
      />,
    );
    expect(screen.getByTestId("custom-cell")).toHaveTextContent("pending-custom");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test -- DataGrid`
Expected: FAIL — the current `DataGrid` takes only `columns`/`rows`, has no sort/pagination/copy affordances.

If this step's failures instead include `ReferenceError: ResizeObserver is not defined` once Step 3's implementation is in place: `@tanstack/react-virtual` requires it, and jsdom does not implement it. Add to whatever file this project already uses for global test setup (check `apps/devbench/vite.config.ts`'s `test.setupFiles` for the exact path — likely `src/test-setup.ts` or similar):
```ts
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error -- jsdom has no ResizeObserver; @tanstack/react-virtual needs one to exist.
global.ResizeObserver ??= ResizeObserverMock;
```
If no setup file is configured yet, add one and register it via `test.setupFiles` in `vite.config.ts`.

- [ ] **Step 3: Implement the redesigned `DataGrid`**

Replace `apps/devbench/src/components/db/DataGrid.tsx` entirely:

```tsx
import { useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const ROW_HEIGHT_PX = 33;

export interface DataGridProps {
  columns: string[];
  rows: (string | null)[][];
  sortColumn?: string | null;
  sortDescending?: boolean;
  onSort?: (column: string) => void;
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
  onPrevPage?: () => void;
  onNextPage?: () => void;
  /** Overrides how a cell renders — Task 12's editable-cell UI plugs in here. */
  renderCell?: (rowIndex: number, columnIndex: number, value: string | null) => ReactNode;
}

function cellDisplay(value: string | null): { text: string; className: string } {
  if (value === null) return { text: "NULL", className: "italic text-text-faint" };
  if (value === "<unsupported type>") return { text: value, className: "italic text-warning" };
  if (value === "true" || value === "false") return { text: value, className: "" };
  if (/^-?\d+(\.\d+)?$/.test(value)) return { text: value, className: "text-right tabular-nums" };
  return { text: value, className: "" };
}

function rowAsTsv(row: (string | null)[]): string {
  return row.map((v) => v ?? "").join("\t");
}

function rowAsJson(columns: string[], row: (string | null)[]): string {
  const obj: Record<string, string | null> = {};
  columns.forEach((col, i) => {
    obj[col] = row[i] ?? null;
  });
  return JSON.stringify(obj);
}

export function DataGrid({
  columns,
  rows,
  sortColumn = null,
  sortDescending = false,
  onSort,
  hasNextPage = false,
  hasPrevPage = false,
  onPrevPage,
  onNextPage,
  renderCell,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridTemplateColumns = useMemo(
    () => `repeat(${columns.length}, minmax(140px, 1fr)) 90px`,
    [columns.length],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });

  async function copyRow(row: (string | null)[], format: "tsv" | "json") {
    const text = format === "tsv" ? rowAsTsv(row) : rowAsJson(columns, row);
    await navigator.clipboard.writeText(text);
  }

  return (
    <div className="rounded-lg border border-border" role="table" aria-rowcount={rows.length}>
      <div style={{ display: "grid", gridTemplateColumns }} className="border-b border-border bg-surface-2" role="row">
        {columns.map((col) => (
          <div
            key={col}
            role="columnheader"
            className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-text-faint"
          >
            <button
              type="button"
              onClick={() => onSort?.(col)}
              className="flex items-center gap-1"
              aria-label={`Sort by ${col}`}
            >
              {col}
              {sortColumn === col ? <span aria-hidden>{sortDescending ? "▼" : "▲"}</span> : null}
            </button>
          </div>
        ))}
        <div role="columnheader" aria-label="Row actions" />
      </div>

      <div ref={scrollRef} className="max-h-125 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <div
                key={virtualRow.index}
                role="row"
                className="border-b border-border font-mono text-sm hover:bg-surface-2"
                style={{
                  display: "grid",
                  gridTemplateColumns,
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.map((value, columnIndex) =>
                  renderCell ? (
                    <div key={columnIndex} role="cell" className="px-3 py-1.75 text-text">
                      {renderCell(virtualRow.index, columnIndex, value)}
                    </div>
                  ) : (
                    <div
                      key={columnIndex}
                      role="cell"
                      className={`truncate px-3 py-1.75 text-text ${cellDisplay(value).className}`}
                    >
                      {cellDisplay(value).text}
                    </div>
                  ),
                )}
                <div role="cell" className="px-2 py-1.75">
                  <button
                    type="button"
                    aria-label="Copy row as tab-separated values"
                    onClick={() => void copyRow(row, "tsv")}
                    className="px-1 text-xs text-text-faint hover:text-text"
                  >
                    TSV
                  </button>
                  <button
                    type="button"
                    aria-label="Copy row as JSON"
                    onClick={() => void copyRow(row, "json")}
                    className="px-1 text-xs text-text-faint hover:text-text"
                  >
                    JSON
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border bg-surface px-3 py-2 text-xs text-text-faint">
        <span>
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={!hasPrevPage}
            onClick={onPrevPage}
            className="rounded-sm px-2 py-1 disabled:opacity-40"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={!hasNextPage}
            onClick={onNextPage}
            className="rounded-sm px-2 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test -- DataGrid`
Expected: PASS (9 tests)

- [ ] **Step 5: Full frontend check**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: PASS (other suites still reference the old two-prop `<DataGrid columns rows />` call in `DbTab.tsx` — that continues to compile unchanged, since every new prop is optional)

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/components/db/DataGrid.tsx apps/devbench/src/components/db/DataGrid.test.tsx
git commit -m "feat(devbench): redesign DataGrid with virtualization, sort, pagination, type-aware cells, copy"
```

---

## Task 11: Wire sort/pagination into `DbTab`'s Browse view

**Files:**
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: Task 5's `list_table_rows(connectionId, table, { orderByColumn, orderByDesc, limit, offset })`, Task 10's `<DataGrid sortColumn sortDescending onSort hasPrevPage hasNextPage onPrevPage onNextPage />`.
- Produces: `DbTab` tracks `sortColumn`, `sortDescending`, `page`, and `pkColumn` locally, resetting sort/page whenever the selected table changes. `pkColumn` is stored now for Task 12 to consume; this task does not yet use it for anything.

No exact row count is ever fetched — "Next" is enabled purely by "did this page come back full," per the design doc's reasoning against promising a `COUNT(*)` this codebase can't back cheaply.

- [ ] **Step 1: Write the failing tests**

Add to `apps/devbench/src/components/db/DbTab.test.tsx` (reusing whatever mock/render setup Task 9's tests already established for `activeConnectionId` and `invokeListTableRows`):

```tsx
  it("sorts by clicking a column header, resetting to page 0", async () => {
    useAppStore.getState().setActiveConnectionId("c1");
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["1", "pending"]],
      pk_column: "id",
    });

    render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} focusTable="orders" />);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Sort by status" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c1",
        "orders",
        expect.objectContaining({ orderByColumn: "status", orderByDesc: false, offset: 0 }),
      ),
    );
  });

  it("clicking the same column header again reverses sort direction", async () => {
    useAppStore.getState().setActiveConnectionId("c1");
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["1", "pending"]],
      pk_column: "id",
    });

    render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} focusTable="orders" />);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    const sortButton = await screen.findByRole("button", { name: "Sort by status" });
    fireEvent.click(sortButton);
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ orderByDesc: false })));
    fireEvent.click(sortButton);
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ orderByDesc: true })));
  });

  it("advances to the next page and requests the corresponding offset", async () => {
    useAppStore.getState().setActiveConnectionId("c1");
    const fullPage = Array.from({ length: 100 }, (_, i) => [String(i)]);
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"],
      rows: fullPage,
      pk_column: "id",
    });

    render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} focusTable="orders" />);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ offset: 100 })),
    );
  });

  it("selecting a different table resets sort and page", async () => {
    useAppStore.getState().setActiveConnectionId("c1");
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"],
      rows: [["1"]],
      pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
      { schema: "public", name: "payments" },
    ]);

    render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} focusTable="orders" />);
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ offset: 100 })));

    fireEvent.click(await screen.findByRole("button", { name: "Browse payments" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c1",
        "payments",
        expect.objectContaining({ orderByColumn: null, offset: 0 }),
      ),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test -- DbTab`
Expected: FAIL — `DataGrid` renders with no sort/pagination props wired, so the buttons these tests target either don't exist or don't trigger a new fetch.

- [ ] **Step 3: Implement**

Replace `apps/devbench/src/components/db/DbTab.tsx`'s state and fetch logic:

```tsx
import { useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid } from "./DataGrid";
import { invokeListTableRows, invokeListWatchedTables, invokeSetWatchedTable, type TableRows } from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";
import { useEffect } from "react";

const PAGE_SIZE = 100;

export function DbTab({
  watchedTables,
  onToggleWatch,
  focusTable,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  focusTable: string | null;
}) {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDescending, setSortDescending] = useState(false);
  const [page, setPage] = useState(0);

  async function fetchRows(table: string, orderByColumn: string | null, orderByDesc: boolean, pageNum: number) {
    if (!activeConnectionId) return;
    setError(null);
    try {
      const rows = await invokeListTableRows(activeConnectionId, table, {
        orderByColumn,
        orderByDesc,
        limit: PAGE_SIZE,
        offset: pageNum * PAGE_SIZE,
      });
      setTableRows(rows);
    } catch (err) {
      setTableRows(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSelectTable(table: string) {
    setSelectedTable(table);
    setSortColumn(null);
    setSortDescending(false);
    setPage(0);
    await fetchRows(table, null, false, 0);
  }

  function handleSort(column: string) {
    const descending = sortColumn === column ? !sortDescending : false;
    setSortColumn(column);
    setSortDescending(descending);
    setPage(0);
    if (selectedTable) void fetchRows(selectedTable, column, descending, 0);
  }

  function handlePrevPage() {
    const nextPage = Math.max(0, page - 1);
    setPage(nextPage);
    if (selectedTable) void fetchRows(selectedTable, sortColumn, sortDescending, nextPage);
  }

  function handleNextPage() {
    const nextPage = page + 1;
    setPage(nextPage);
    if (selectedTable) void fetchRows(selectedTable, sortColumn, sortDescending, nextPage);
  }

  useEffect(() => {
    if (focusTable) void handleSelectTable(focusTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTable]);

  useEffect(() => {
    if (!activeConnectionId) return;
    invokeListWatchedTables(activeConnectionId)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [activeConnectionId, setWatchedTables]);

  async function handleToggleWatch(table: string) {
    if (!activeConnectionId) return;
    const nextWatched = !watchedTables.has(table);
    onToggleWatch(table);
    try {
      await invokeSetWatchedTable(activeConnectionId, table, nextWatched);
    } catch {
      onToggleWatch(table);
    }
  }

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connectionId={activeConnectionId}
        watchedTables={watchedTables}
        onToggleWatch={handleToggleWatch}
        onSelectTable={handleSelectTable}
        onConnectionChange={setActiveConnectionId}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {error ? (
          <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
        ) : tableRows ? (
          <DataGrid
            columns={tableRows.columns}
            rows={tableRows.rows}
            sortColumn={sortColumn}
            sortDescending={sortDescending}
            onSort={handleSort}
            hasPrevPage={page > 0}
            hasNextPage={tableRows.rows.length === PAGE_SIZE}
            onPrevPage={handlePrevPage}
            onNextPage={handleNextPage}
          />
        ) : null}
      </div>
    </div>
  );
}
```

(`pkColumn` — `tableRows.pk_column` — is read from state here but not passed anywhere yet; Task 12 is what consumes it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test -- DbTab`
Expected: PASS

- [ ] **Step 5: Full frontend check**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): wire server-side sort and pagination into DbTab's grid"
```

---

## Task 12: Inline cell editing — editing → preview diff → commit/rollback

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts` (`QueryPreview` type, `invokePreviewCellEdit`/`invokeCommitPreview`/`invokeRollbackPreview`)
- Modify: `apps/devbench/src/components/db/DataGrid.tsx` (export `cellDisplay` so `DbTab` can reuse its formatting for the non-editing case)
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: Task 7's `preview_cell_edit`/`commit_preview`/`rollback_preview` commands, Task 10's `DataGrid`'s `renderCell` prop and (newly exported) `cellDisplay`.
- Produces: `DbTab` renders every cell through a custom `renderCell` that shows editing/preview UI for eligible cells and falls back to `cellDisplay`'s ordinary formatting otherwise. A committed edit updates `tableRows` locally (no refetch).

Editability is `tableRows.pk_column !== null && column !== tableRows.pk_column` — a table with no qualifying single-column PK has every cell ineligible, matching the read-only note already added at the bottom of the grid.

- [ ] **Step 1: Write the failing tests**

Add to `apps/devbench/src/lib/tauri.ts`:

```ts
export interface QueryPreview {
  preview_id: string;
  columns: string[];
  rows: (string | null)[][];
  rows_affected: number | null;
}

export function invokePreviewCellEdit(
  connectionId: string,
  table: string,
  pkColumn: string,
  pkValue: string,
  column: string,
  value: string | null,
): Promise<QueryPreview> {
  return invoke("preview_cell_edit", { connectionId, table, pkColumn, pkValue, column, value });
}

export function invokeCommitPreview(previewId: string): Promise<void> {
  return invoke("commit_preview", { previewId });
}

export function invokeRollbackPreview(previewId: string): Promise<void> {
  return invoke("rollback_preview", { previewId });
}
```

Add to `apps/devbench/src/components/db/DbTab.test.tsx`:

```tsx
  it("clicking an editable cell shows an input; previewing shows a diff; committing updates the grid", async () => {
    useAppStore.getState().setActiveConnectionId("c1");
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["1", "pending"]],
      pk_column: "id",
    });
    const preview = vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    const commit = vi.spyOn(tauriLib, "invokeCommitPreview").mockResolvedValue(undefined);

    render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} focusTable="orders" />);
    await waitFor(() => screen.getByText("pending"));

    fireEvent.click(screen.getByText("pending"));
    const input = await screen.findByDisplayValue("pending");
    fireEvent.change(input, { target: { value: "shipped" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview change" }));

    await waitFor(() => expect(preview).toHaveBeenCalledWith("c1", "orders", "id", "1", "status", "shipped"));
    expect(await screen.findByText("shipped")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Commit edit" }));

    await waitFor(() => expect(commit).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Commit edit" })).not.toBeInTheDocument());
  });

  it("rolling back an edit discards the draft and calls rollback_preview", async () => {
    useAppStore.getState().setActiveConnectionId("c1");
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["1", "pending"]],
      pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} focusTable="orders" />);
    await waitFor(() => screen.getByText("pending"));

    fireEvent.click(screen.getByText("pending"));
    fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
    await screen.findByRole("button", { name: "Rollback edit" });

    fireEvent.click(screen.getByRole("button", { name: "Rollback edit" }));

    await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("pending")).toBeInTheDocument();
  });

  it("cells are not clickable to edit when the table has no single-column primary key", async () => {
    useAppStore.getState().setActiveConnectionId("c1");
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["tenant_id", "item_id"],
      rows: [["t1", "i1"]],
      pk_column: null,
    });

    render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} focusTable="payments" />);
    await waitFor(() => screen.getByText("t1"));

    fireEvent.click(screen.getByText("t1"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/No single-column primary key/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test -- DbTab`
Expected: FAIL — `DbTab` has no editing behavior yet, and `invokePreviewCellEdit`/`invokeCommitPreview`/`invokeRollbackPreview` weren't called.

- [ ] **Step 3: Export `cellDisplay` from `DataGrid.tsx`**

In `apps/devbench/src/components/db/DataGrid.tsx`, change:
```ts
function cellDisplay(value: string | null): { text: string; className: string } {
```
to:
```ts
export function cellDisplay(value: string | null): { text: string; className: string } {
```

- [ ] **Step 4: Implement editing in `DbTab`**

In `apps/devbench/src/components/db/DbTab.tsx`, add to the imports:
```tsx
import { cellDisplay } from "./DataGrid";
import {
  invokeListTableRows,
  invokeListWatchedTables,
  invokeSetWatchedTable,
  invokePreviewCellEdit,
  invokeCommitPreview,
  invokeRollbackPreview,
  type TableRows,
} from "../../lib/tauri";
```

Add state and the editing handlers (alongside the existing sort/page state):

```tsx
  const [editing, setEditing] = useState<
    | null
    | { rowIndex: number; columnIndex: number; phase: "editing"; draft: string }
    | { rowIndex: number; columnIndex: number; phase: "preview"; draft: string; previewId: string }
  >(null);

  function startEdit(rowIndex: number, columnIndex: number, currentValue: string | null) {
    setEditing({ rowIndex, columnIndex, phase: "editing", draft: currentValue ?? "" });
  }

  async function previewEdit() {
    if (!editing || editing.phase !== "editing" || !tableRows?.pk_column || !activeConnectionId || !selectedTable) return;
    const pkIndex = tableRows.columns.indexOf(tableRows.pk_column);
    const pkValue = tableRows.rows[editing.rowIndex][pkIndex];
    if (pkValue === null) return;
    try {
      const preview = await invokePreviewCellEdit(
        activeConnectionId,
        selectedTable,
        tableRows.pk_column,
        pkValue,
        tableRows.columns[editing.columnIndex],
        editing.draft,
      );
      setEditing({ ...editing, phase: "preview", previewId: preview.preview_id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEditing(null);
    }
  }

  async function commitEdit() {
    if (!editing || editing.phase !== "preview" || !tableRows) return;
    try {
      await invokeCommitPreview(editing.previewId);
      const { rowIndex, columnIndex, draft } = editing;
      setTableRows({
        ...tableRows,
        rows: tableRows.rows.map((row, ri) =>
          ri === rowIndex ? row.map((v, ci) => (ci === columnIndex ? draft : v)) : row,
        ),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditing(null);
    }
  }

  async function rollbackEdit() {
    if (editing?.phase === "preview") {
      await invokeRollbackPreview(editing.previewId).catch(() => {});
    }
    setEditing(null);
  }

  function renderCell(rowIndex: number, columnIndex: number, value: string | null) {
    const editable = Boolean(tableRows?.pk_column) && tableRows!.columns[columnIndex] !== tableRows!.pk_column;
    const isEditingThisCell = editing && editing.rowIndex === rowIndex && editing.columnIndex === columnIndex;

    if (isEditingThisCell && editing.phase === "preview") {
      return (
        <div className="flex items-center gap-1.5">
          <span className="text-danger line-through">{value ?? "NULL"}</span>
          <span aria-hidden>→</span>
          <span className="font-semibold text-success">{editing.draft}</span>
          <button type="button" aria-label="Rollback edit" onClick={() => void rollbackEdit()} className="text-text-faint">
            ✕
          </button>
          <button type="button" aria-label="Commit edit" onClick={() => void commitEdit()} className="text-success">
            ✓
          </button>
        </div>
      );
    }

    if (isEditingThisCell) {
      return (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={editing.draft}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            className="min-w-0 flex-1 rounded-sm border border-accent bg-bg px-1.5 py-0.5 text-sm text-text"
          />
          <button type="button" aria-label="Preview change" onClick={() => void previewEdit()} className="text-success">
            ✓
          </button>
          <button type="button" aria-label="Cancel edit" onClick={() => setEditing(null)} className="text-text-faint">
            ✕
          </button>
        </div>
      );
    }

    const { text, className } = cellDisplay(value);
    return (
      <button
        type="button"
        disabled={!editable}
        onClick={() => editable && startEdit(rowIndex, columnIndex, value)}
        className={`w-full truncate text-left ${editable ? "cursor-text hover:bg-surface-2" : ""} ${className}`}
      >
        {text}
      </button>
    );
  }
```

Reset `editing` to `null` inside `handleSelectTable` (alongside the existing sort/page resets), so a stale in-flight edit can't survive a table switch. Pass `renderCell` to the grid and add the read-only note:

```tsx
          <DataGrid
            columns={tableRows.columns}
            rows={tableRows.rows}
            sortColumn={sortColumn}
            sortDescending={sortDescending}
            onSort={handleSort}
            hasPrevPage={page > 0}
            hasNextPage={tableRows.rows.length === PAGE_SIZE}
            onPrevPage={handlePrevPage}
            onNextPage={handleNextPage}
            renderCell={renderCell}
          />
          {!tableRows.pk_column ? (
            <div className="mt-2 text-xs text-text-faint">
              No single-column primary key on{" "}
              <span className="font-semibold text-text-muted">{selectedTable}</span> — cells are read-only.
            </div>
          ) : null}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test -- DbTab DataGrid`
Expected: PASS

- [ ] **Step 6: Full frontend check**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/components/db/DataGrid.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): add inline cell editing with a preview-before-commit diff"
```

---

## Task 13: `QueryConsole` — the resizable bottom drawer

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts` (`invokePreviewQuery`)
- Create: `apps/devbench/src/components/db/QueryConsole.tsx`
- Create: `apps/devbench/src/components/db/QueryConsole.test.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: Task 7's `preview_query` command, Task 12's `QueryPreview` type / `invokeCommitPreview` / `invokeRollbackPreview`, Task 10's `DataGrid` (reused for a query's result rows).
- Produces: `<QueryConsole connectionId="..." />` — self-contained (owns its own SQL text, phase, height, and drag handling). `DbTab` only owns whether it's open.

Browse (`SchemaTree` + the grid) keeps rendering the selected table the entire time the console is open — this is a sibling panel in the same flex column, not a mode that replaces anything.

- [ ] **Step 1: Write the failing tests**

Add to `apps/devbench/src/lib/tauri.ts`:

```ts
export function invokePreviewQuery(connectionId: string, sql: string): Promise<QueryPreview> {
  return invoke("preview_query", { connectionId, sql });
}
```

Create `apps/devbench/src/components/db/QueryConsole.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryConsole } from "./QueryConsole";
import * as tauriLib from "../../lib/tauri";

const SQL_PLACEHOLDER = "SELECT * FROM orders LIMIT 10;";

describe("QueryConsole", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("previews a SELECT and shows its rows without committing anything", async () => {
    const previewQuery = vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: ["id"],
      rows: [["1"]],
      rows_affected: null,
    });
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "SELECT id FROM orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(previewQuery).toHaveBeenCalledWith("c1", "SELECT id FROM orders"));
    expect(await screen.findByText("held in an open transaction — not yet committed")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("previews a write and reports rows affected, never a misleading zero rows", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), {
      target: { value: "UPDATE orders SET status = 'shipped' WHERE id = 1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("1 row affected — no rows returned.")).toBeInTheDocument();
  });

  it("commits a preview", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    const commit = vi.spyOn(tauriLib, "invokeCommitPreview").mockResolvedValue(undefined);
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "UPDATE orders SET status = 'x'" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Commit" });

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(commit).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("✓ COMMITTED")).toBeInTheDocument();
  });

  it("rolls back a preview and returns to idle", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "UPDATE orders SET status = 'x'" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Rollback" });

    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));

    await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
    expect(screen.queryByText("✓ COMMITTED")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
  });

  it("editing the SQL after a preview discards it, requiring a fresh Preview", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: ["id"],
      rows: [["1"]],
      rows_affected: null,
    });
    render(<QueryConsole connectionId="c1" />);

    const textarea = screen.getByPlaceholderText(SQL_PLACEHOLDER);
    fireEvent.change(textarea, { target: { value: "SELECT id FROM orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Commit" });

    fireEvent.change(textarea, { target: { value: "SELECT id FROM orders WHERE id = 2" } });

    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
  });
});
```

Add to `apps/devbench/src/components/db/DbTab.test.tsx`:

```tsx
  it("opens and closes the query console via the toggle button", async () => {
    useAppStore.getState().setActiveConnectionId("c1");
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: "id" });

    render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} focusTable="orders" />);
    await waitFor(() => screen.getByText("1"));

    expect(screen.queryByPlaceholderText("SELECT * FROM orders LIMIT 10;")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Query console" }));
    expect(await screen.findByPlaceholderText("SELECT * FROM orders LIMIT 10;")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Query console" }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("SELECT * FROM orders LIMIT 10;")).not.toBeInTheDocument(),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test -- QueryConsole DbTab`
Expected: FAIL — `QueryConsole` does not exist; `DbTab` has no toggle button.

- [ ] **Step 3: Implement `QueryConsole`**

Create `apps/devbench/src/components/db/QueryConsole.tsx`:

```tsx
import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { DataGrid } from "./DataGrid";
import { invokeCommitPreview, invokePreviewQuery, invokeRollbackPreview, type QueryPreview } from "../../lib/tauri";

const DEFAULT_HEIGHT_PX = 220;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 560;

type Phase = "idle" | "preview" | "committed";

export function QueryConsole({ connectionId }: { connectionId: string }) {
  const [sql, setSql] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<QueryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT_PX);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  function onHandleMouseMove(e: MouseEvent) {
    if (!dragState.current) return;
    const dy = dragState.current.startY - e.clientY;
    setHeight(Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, dragState.current.startHeight + dy)));
  }

  function onHandleMouseUp() {
    dragState.current = null;
    window.removeEventListener("mousemove", onHandleMouseMove);
    window.removeEventListener("mouseup", onHandleMouseUp);
  }

  function onHandleMouseDown(e: ReactMouseEvent) {
    dragState.current = { startY: e.clientY, startHeight: height };
    window.addEventListener("mousemove", onHandleMouseMove);
    window.addEventListener("mouseup", onHandleMouseUp);
  }

  function onSqlChange(value: string) {
    setSql(value);
    // Editing after a preview invalidates it — the open transaction is still
    // held (and will still expire on its own timeout), but this console no
    // longer has a way back to it once the text it previewed has changed.
    setPhase("idle");
    setPreview(null);
  }

  async function runPreview() {
    setError(null);
    try {
      const result = await invokePreviewQuery(connectionId, sql);
      setPreview(result);
      setPhase("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function commit() {
    if (!preview) return;
    try {
      await invokeCommitPreview(preview.preview_id);
      setPhase("committed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function rollback() {
    if (!preview) return;
    await invokeRollbackPreview(preview.preview_id).catch(() => {});
    setPhase("idle");
    setPreview(null);
  }

  return (
    <div className="flex flex-shrink-0 flex-col border-t border-border bg-surface" style={{ height }}>
      <div
        onMouseDown={onHandleMouseDown}
        className="flex h-3.5 flex-shrink-0 cursor-row-resize items-center justify-center"
        aria-hidden
      >
        <div className="h-1 w-9 rounded-full bg-border" />
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wide text-text-faint">Query console</span>
        <span className="text-[11px] text-text-faint">— single statement per run</span>
        <button
          type="button"
          onClick={() => void runPreview()}
          className="ml-auto rounded-sm bg-accent px-3 py-1 text-xs font-bold text-accent-on"
        >
          Preview
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        <textarea
          value={sql}
          onChange={(e) => onSqlChange(e.target.value)}
          placeholder="SELECT * FROM orders LIMIT 10;"
          className="min-h-14 rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-sm text-text"
        />
        {error ? <div className="text-xs text-danger">{error}</div> : null}
        {phase === "preview" && preview ? (
          <>
            <div className="flex items-center gap-2 text-xs text-text-faint">
              <span className="rounded-full bg-surface-2 px-2 py-0.5 font-bold text-text-faint">PREVIEW</span>
              <span>held in an open transaction — not yet committed</span>
            </div>
            {preview.columns.length > 0 ? (
              <DataGrid columns={preview.columns} rows={preview.rows} />
            ) : (
              <div className="text-xs text-text-faint">
                {preview.rows_affected ?? 0} row{preview.rows_affected === 1 ? "" : "s"} affected — no rows returned.
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void rollback()}
                className="rounded-sm border border-border px-3 py-1.5 text-xs text-text-muted"
              >
                Rollback
              </button>
              <button
                type="button"
                onClick={() => void commit()}
                className="rounded-sm bg-accent px-3 py-1.5 text-xs font-bold text-accent-on"
              >
                Commit
              </button>
            </div>
          </>
        ) : null}
        {phase === "committed" && preview ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-success-bg px-2 py-0.5 font-bold text-success">✓ COMMITTED</span>
            <span className="text-text-faint">
              {preview.columns.length > 0
                ? `${preview.rows.length} row${preview.rows.length === 1 ? "" : "s"}`
                : `${preview.rows_affected ?? 0} row${preview.rows_affected === 1 ? "" : "s"} affected`}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the toggle into `DbTab`**

In `apps/devbench/src/components/db/DbTab.tsx`, add the import:
```tsx
import { QueryConsole } from "./QueryConsole";
```
and a state field alongside the existing ones:
```tsx
  const [consoleOpen, setConsoleOpen] = useState(false);
```

Replace the returned JSX's right-hand column — everything from the closing tag of `<SchemaTree .../>` onward — with:

```tsx
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center border-b border-border px-4 py-2">
          <span className="text-sm font-semibold text-text-muted">{selectedTable}</span>
          <button
            type="button"
            onClick={() => setConsoleOpen((open) => !open)}
            aria-pressed={consoleOpen}
            className="ml-auto flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-text-muted hover:bg-surface-2"
          >
            <span aria-hidden style={{ display: "inline-block", transform: consoleOpen ? "rotate(180deg)" : "none" }}>
              ▾
            </span>
            Query console
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error ? (
            <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
          ) : tableRows ? (
            <DataGrid
              columns={tableRows.columns}
              rows={tableRows.rows}
              sortColumn={sortColumn}
              sortDescending={sortDescending}
              onSort={handleSort}
              hasPrevPage={page > 0}
              hasNextPage={tableRows.rows.length === PAGE_SIZE}
              onPrevPage={handlePrevPage}
              onNextPage={handleNextPage}
              renderCell={renderCell}
            />
          ) : null}
          {tableRows && !tableRows.pk_column ? (
            <div className="mt-2 text-xs text-text-faint">
              No single-column primary key on{" "}
              <span className="font-semibold text-text-muted">{selectedTable}</span> — cells are read-only.
            </div>
          ) : null}
        </div>
        {consoleOpen && activeConnectionId ? <QueryConsole connectionId={activeConnectionId} /> : null}
      </div>
```

(The outer wrapping `<div className="-m-6 flex h-full"><SchemaTree .../>` from Task 12 is unchanged — only what follows `<SchemaTree .../>` is replaced, and the `<DataGrid>`/read-only-note block that Task 12 placed directly under `<SchemaTree>`'s sibling `<div>` moves one level deeper into the new `pane-strip` + content structure above.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test -- QueryConsole DbTab`
Expected: PASS

- [ ] **Step 6: Full frontend and backend check**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: PASS

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS (unchanged by this task, confirms nothing regressed across the whole plan)

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/components/db/QueryConsole.tsx apps/devbench/src/components/db/QueryConsole.test.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): add the resizable query console drawer with preview/commit/rollback"
```

---

## Manual verification

Automated tests cover the logic; a few behaviours are worth seeing once in the running app, because they involve either a real OS keyring, real window/mouse interaction, or a genuinely abandoned transaction — none of which a unit test exercises end to end.

Run `bun run tauri dev` from `apps/devbench`, then:

1. **Upgrade continuity.** On first launch after this branch lands, the DB tab should work immediately against the seeded "Local Dev" connection with no setup — proving the default-password keyring bridge actually ran.
2. **Full connection lifecycle.** In Settings > Connections, add a second connection pointing at a different local Postgres (or the same one under a different role), test it, save it, switch to it from the DB tab's picker, browse a table, edit it, delete it from Settings, and confirm the DB tab's picker no longer offers it.
3. **Query console resize.** Open the console, drag its handle up and down, confirm it clamps at both ends and that Browse stays visible and scrollable throughout.
4. **Abandoned preview.** Open the console, preview a write, and simply leave it open (or navigate to Settings and back) for a little over 2 minutes without clicking Commit or Rollback. Confirm the write never took effect — the background sweep should have rolled it back.
5. **Cell edit on a real table.** Edit a cell on a table with a single-column primary key end to end (preview, see the diff, commit), and confirm a table with no qualifying primary key shows every cell as read-only with the explanatory note.

---

## Plan self-review

**Spec coverage:** every "What changes" row in the design doc maps to a task — connections table + Settings pane (Tasks 1, 8), stable id + `watched_tables` migration (Task 1), keyring passwords (Tasks 1–2), `connection_id` everywhere (Tasks 5, 9), `ConnectionRegistry` (Task 3), resizable query console (Task 13), preview-before-commit for both the runner and cell edits (Tasks 6, 7, 12, 13), and the grid redesign (Tasks 10–12). The design doc's "Out of scope" list (multi-engine execution, multi-statement scripts, row insert/delete, client-side search/filter, persisted UI state, query history, configurable timeout, touching the v2 shell branch) has no corresponding task, as intended.

**Placeholder scan:** no task step describes what to do without showing the code; every test in every task is a complete, runnable body, not a description of one.

**Type/signature consistency, checked across task boundaries:**
- `ConnectionSummary`/`ConnectionInput` (Task 2) are used identically in Tasks 3, 4, 8, 12.
- `postgres_connection_string` (Task 3) is the single connection-string builder — Tasks 4, 5, 6, 7 all call it rather than reimplementing it.
- `TableRows.pk_column` (Task 5) flows unchanged through Tasks 9, 11, 12.
- `QueryPreview` (Task 7's Rust struct, Task 12's TS type) has the same four fields end to end; `rows_affected: Option<u64>` (Rust) / `number | null` (TS) is used consistently by both `preview_query`/`preview_cell_edit` and by `QueryConsole`/`DbTab`'s rendering of it.
- `PendingPreviewRegistry::hold`/`take` (Task 6) are called with matching signatures in every Task 7 test and impl function.
- `preview_id`/`commit_preview`/`rollback_preview` naming is identical across Tasks 7, 12, and 13 — no drift between what the query runner and what cell editing call.

**Fixed during this review:** none — issues caught while drafting (the watched.rs/db.rs/correlation.rs task-splitting that would have left the build broken between tasks; the stray brace in Task 3; the unused `LocalDb` import/dead-code hack in Task 6) were corrected inline as they came up, not left for a separate pass.
