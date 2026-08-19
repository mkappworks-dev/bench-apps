# Table View Slice 4 — Queries as Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a saved query a first-class document — listed in the rail beside tables, opened as its own tab, run for real against the database inside a transaction that is rolled back before you decide anything, and staged into the same pending set every other write goes through.

**Architecture:** Saved queries persist in the app's own SQLite (`saved_queries`, scoped to a connection, cascading with it), not in the user's Postgres. The rail becomes `ConnectionRail` — one component, shared by table tabs and query tabs, with a segmented control choosing which list it shows. `ToolKind` gains `"query"`; a query tab is identified by `{ queryId, connectionId }` with the connection **pinned** at open. Run calls `preview_query` and fires `rollback_preview` in the same continuation the result arrives in, so no row lock is ever held while the user thinks — the Slice 3 principle ("staged intent holds no transaction") extended to the last path that broke it. `Add to pending` stages a `PendingChange::Sql`, whose Rust arm shipped in Slice 3 with no test because nothing could stage one until now. The query console drawer and `commit_preview` are deleted outright.

**Tech Stack:** Rust + sqlx (SQLite for app state, Postgres 17 for user data), Tauri 2 commands, React 18, Zustand, Tailwind v4, vitest + @testing-library/react, Playwright for anything positional.

**Spec:** `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` (§3a rail, §3b query tabs, §12 query execution and staging, §13 backend commands, §14 shared components, §15 what this retires, §16 testing, §17 slices). The four decisions this slice rests on were settled in commit `d9474ad`; read §3a, §12 and §10's *Scope* before starting.

## Global Constraints

- **Worktree:** `.claude/worktrees/devbench-db-connections`, branch `worktree-devbench-db-connections`. **`cd` explicitly before every git command** — other sessions share this machine and this repo has seven live worktrees.
- Visual source of truth: `docs/mockups/devbench-db-connections.html` (runnable; serve with `python3 -m http.server 8899` from `docs/mockups`). This slice's parts are its `.rail-seg` / `.segmented` / `.seg-btn` / `.rail-foot` rules, `.tab.query`, `.query-pane` / `.query-head` / `.query-name` / `.query-editor-wrap` / `.query-editor` / `.query-grip` / `.query-results` / `.query-actions`, and the `rail()` / `queryTab()` functions.
- Type scale from the mockup: `--fs-xs: 10.5px`, `--fs-sm: 12px`, `--fs-md: 13.5px`. Tint tokens: `--query-tint: rgba(255,255,255,.035)` dark / `rgba(16,21,31,.03)` light; `--query-edge: rgba(255,255,255,.28)` dark / `rgba(16,21,31,.35)` light.
- **A tint of the surface's own light, never a hue** (§3b). DESIGN.md reserves semantic colour for actual state; a coloured query tab would compete with the pending panel's own colour-coding.
- Column, schema and table identifiers are **validated** with `validate_identifier_labeled(kind, identifier)` before interpolation. A `QualifiedTable` cannot exist unvalidated. Filter and value payloads are **always bound parameters** — never interpolated. This slice adds no new interpolation site: a saved query's SQL is user-authored text sent to Postgres as a statement, which is the whole point of the feature, and it is never spliced into another statement.
- jsdom has no layout engine. **Never assert layout in vitest**, and never write a test that appears to check layout but asserts nothing. Anything positional is verified in a real browser via Playwright with `getComputedStyle` / `getBoundingClientRect` / `document.elementFromPoint`, reporting measured numbers.
- **Use `document.elementFromPoint`, never a z-index comparison.** Every virtualized row's `transform` creates a stacking context, so a z-index can read correctly while the element is genuinely unclickable. This has produced three separate bugs in this codebase. The most recent shipped past 522 passing jsdom tests: clicking a control focused it, the browser scrolled it into view *after* the click handler ran, and that scroll dismissed the menu the click had just opened (fixed in `c8d686f`).
- **Baseline to keep green, re-measured on this worktree at `c8d686f` while writing this plan:**
  - `cd apps/devbench && bun run test` → **523 passing / 50 files**
  - `cd apps/devbench && bun run build` → clean (`tsc` then `vite build`), **0 warnings**, 273 modules
  - `cd apps/devbench/src-tauri && cargo test` → **249 passed, 1 ignored** (lib) and **6 passed** (`smoke_test`)
  - Concurrent sessions share this machine and have moved these numbers before. **Re-measure immediately before each task and reconcile against your own measurement**, not against the absolute numbers here. The per-task delta is what must hold; the absolutes are a check, not an authority.
  - Run `cargo test`, **not** `cargo test --lib`. `--lib` does not compile `tests/*.rs` at all, so `tests/smoke_test.rs` can sit broken without anything noticing. `--lib` is fine for focused iteration on one module; it is not a suite gate.
- Postgres for Rust tests: `localhost:5432`, `postgres`/`postgres`, db `devbench_test`, from this repo's own `docker-compose.yml` (`docker compose up -d postgres`). The running container is `bench-apps-postgres-1` (`postgres:17-alpine`). `test_pool()` hardcodes port 5432 with no `PGPORT` override, so if another project holds 5432 that port must be freed first. Verify with `docker ps` that `bench-apps-postgres-1` is the holder — a sibling project on this machine binds 5433 and it is easy to confuse them. Don't modify roles or auth.
- **There is no seeded schema.** `docker-compose.yml` creates an empty `devbench_test`; every Rust test creates and drops its own fixtures. Because cargo runs tests in one process against one shared database concurrently, **every test must use fixture names unique to itself** — two tests sharing `slice4_orders` will race and fail intermittently.
- SQLite tests use the `db()` helper pattern (`tempfile::tempdir()` + `LocalDb::connect`), one fresh database per test, so they have no shared-name hazard.
- Tauri commands are registered in **`src-tauri/src/main.rs`** (`tauri::generate_handler![…]`), not `lib.rs`.
- These four grid behaviours are regression-critical and must still hold after every task: sticky header stays aligned with body columns under horizontal scroll; virtualization keeps rendering rows; horizontal scroll stays contained (`document.documentElement.scrollWidth === clientWidth`); NULL stays visually distinct from `<unsupported type>`.
- Accessibility must not regress: accessible names on buttons, `aria-sort` on sorted headers, `aria-pressed` where present. The segmented control needs `aria-selected` on its two buttons, the resize grip needs `role="separator"` with `aria-orientation`, and the query name input needs an accessible name.
- **Out of scope — do not start these, and do not "improve" them in passing:** the `reltuples` count fallback (§18), the count cache (§13), replacing `cellDisplay`'s boolean value-sniffing with real column types (§7 calls that a follow-up), and the filter compiler's casting strategy (§18's popover/jump disagreement). None are Slice 4.
- **`Discard all` scoping is in scope; the pane strip's `Pending N` badge is not.** §10's *Scope* explains why they differ: the badge is the only route to entries staged on a connection you are not looking at, so scoping it would hide them behind no affordance. Leave it counting the whole set.

---

## Verified facts this plan depends on

Each was checked against this worktree at `c8d686f` while writing the plan. If any turns out false during execution, stop and re-derive rather than working around it.

1. **`QueryConsole.tsx` is the only caller of `invokeCommitPreview` anywhere** (`QueryConsole.tsx:127`). `grep -rn "invokeCommitPreview\|commit_preview" apps/devbench/src apps/devbench/src-tauri/src` returns it, its four test spies, the `tauri.ts` wrapper, the `main.rs` registration, the two `query.rs` definitions, and two `query.rs` tests. Nothing else.
2. **Two Rust tests use `commit_preview_impl` and both survive it**, narrowed rather than deleted: `a_write_preview_is_not_visible_until_commit` (`query.rs:388`) asserts a genuinely valuable isolation property before it commits, and `committing_or_rolling_back_an_unknown_preview_id_is_a_clear_error` (`query.rs:448`) asserts the same error shape for both commands. Task 8 rewrites both to end in rollback. **The lib test count does not change from this deletion.**
3. **`focusOrCreateTab` matches on tab kind alone** (`useTabController.ts:134`: `t.pane === "left" && t.kind === kind`). It cannot serve query tabs unchanged — two saved queries must be two tabs.
4. **The Rust `tabs` table stores `kind` as a free `TEXT`** (`commands/tabs.rs:11`, `0004_tabs.sql`), so adding a `"query"` kind needs **no migration**.
5. **`SplitContent.paneOwnsDbLayout` hard-codes `kind === "db"`** (`SplitContent.tsx:41`). A query tab left out of it gets the shared `p-6` gutter and its full-bleed editor stops being full-bleed.
6. **`PendingChange::Sql`'s apply arm exists and is untested** (`db_apply.rs:239`). `apply_changes_impl` re-runs `statement` verbatim inside the changeset transaction via `sqlx::query(statement).execute(&mut *tx)`.
7. **`preview_query` returns `rows_affected: Option<i64>`** — `None` for a statement that returned rows, `Some(n)` for one that reported an affected count (`query.rs`, and its tests at `:299` and `:275` assert exactly this distinction). That is the discriminator §12 uses to gate `Add to pending`; no new backend work is needed for it.
8. **`connections` rows are the FK target** and `watched_tables` already cascades from them (`0007_watched_tables_schema.sql`), so `saved_queries` can follow that shape exactly.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src-tauri/migrations/0008_saved_queries.sql` | The `saved_queries` table, scoped to a connection and cascading with it. |
| `src-tauri/src/commands/db_queries.rs` | `SavedQuery` plus list/create/rename/set-sql/delete — impls, commands and tests. App-state CRUD against SQLite; it never touches the user's Postgres. |
| `src/lib/savedQueries.ts` | Pure helpers over the saved-query list: merge-by-id and per-connection selection with a stable order. No React, no store. |
| `src/components/db/ConnectionRail.tsx` | The rail, shared by both tab kinds: connection picker, segmented control, the active segment's list, `+ New query` footer. Owns saved-query IPC and store writes; asks its host only to open a tab. |
| `src/components/db/QueryTab.tsx` | A query tab: the rail plus the query pane. Head, editable name, full-bleed editor, resize grip, results, Discard / Add to pending. |
| `src/components/db/ConnectionRail.test.tsx` | Segment behaviour, the queries list, create and delete. |
| `src/components/db/QueryTab.test.tsx` | Rename, Run's rollback, the SELECT gate, staging. |
| `src/lib/savedQueries.test.ts` | The pure helpers. |

**Modified**

| File | Change |
|---|---|
| `src-tauri/src/commands/mod.rs` | Register `db_queries`. |
| `src-tauri/src/main.rs` | Register the five saved-query commands; unregister `commit_preview` (Task 8). |
| `src-tauri/src/commands/db_apply.rs` | Two tests for the `Sql` arm (Task 2). No production change. |
| `src-tauri/src/commands/query.rs` | `commit_preview_impl` and its command deleted; two tests narrowed to rollback (Task 8). |
| `src/lib/tauri.ts` | `SavedQuery` and its five invoke wrappers; `invokeCommitPreview` deleted (Task 8). |
| `src/store/useAppStore.ts` | `savedQueries` slice and its actions; `discardAllPending` becomes connection-scoped (Task 9). |
| `src/components/db/SchemaTree.tsx` | Deleted — its content moves into `ConnectionRail.tsx` (Task 4). |
| `src/components/db/SchemaTree.test.tsx` | Renamed to `ConnectionRail.test.tsx`, tables cases kept verbatim (Task 4). |
| `src/components/db/DbTab.tsx` | Renders `ConnectionRail`; `consoleOpen`, its toggle and `ConsoleChevronIcon` deleted (Task 8). |
| `src/components/db/QueryConsole.tsx`, `QueryConsole.test.tsx` | Deleted (Task 8). |
| `src/components/db/PendingPanel.tsx` | `Discard all` drops this connection's entries only (Task 9). |
| `src/components/shell/ToolPane.tsx` | A `"query"` case; `onOpenQuery` threaded through. |
| `src/components/shell/SplitContent.tsx` | `paneOwnsDbLayout` accepts `query`; `onOpenQuery` threaded through. |
| `src/components/shell/AppStrip.tsx` | Query tab label (mono, the query's name) and its tint. |
| `src/App.tsx` | `onOpenQuery`, wired to a query-aware focus-or-create. |
| `src/store/useTabController.ts` | `focusOrCreateTab` gains an optional matcher. |
| `src/index.css` | `--query-tint` and `--query-edge` in both themes. |
| `apps/devbench/scripts/fk-stub.js` | Stubs the saved-query commands and `preview_query` / `rollback_preview` (Task 10). |
| `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` | Reconciled with what was actually built (Task 10). |

---

## Task 1: `saved_queries` — storage and commands (Rust)

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0008_saved_queries.sql`
- Create: `apps/devbench/src-tauri/src/commands/db_queries.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `LocalDb` (`crate::local_db::LocalDb`, field `pool: SqlitePool`).
- Produces:
  - `pub struct SavedQuery { id: String, connection_id: String, name: String, sql: String, created_at: i64 }` — `Serialize`, all fields public, snake_case on the wire.
  - `list_saved_queries_impl(pool: &SqlitePool, connection_id: &str) -> Result<Vec<SavedQuery>, String>`
  - `create_saved_query_impl(pool: &SqlitePool, connection_id: &str, name: &str, sql: &str, now_ms: i64) -> Result<SavedQuery, String>`
  - `rename_saved_query_impl(pool: &SqlitePool, id: &str, name: &str) -> Result<(), String>`
  - `set_saved_query_sql_impl(pool: &SqlitePool, id: &str, sql: &str) -> Result<(), String>`
  - `delete_saved_query_impl(pool: &SqlitePool, id: &str) -> Result<(), String>`
  - Commands `list_saved_queries`, `create_saved_query`, `rename_saved_query`, `set_saved_query_sql`, `delete_saved_query`.

**Why `now_ms` is a parameter, not `Utc::now()` inside:** `preview_query_impl` already takes its clock this way, and it is what lets Task 1's ordering test create three queries at three known instants instead of racing the system clock.

- [ ] **Step 1: Write the migration**

Create `apps/devbench/src-tauri/migrations/0008_saved_queries.sql`:

```sql
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
```

- [ ] **Step 2: Write the failing tests**

Create `apps/devbench/src-tauri/src/commands/db_queries.rs` with **only** the test module and the `use` line, so the tests fail to compile against absent functions:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn a_created_query_round_trips() {
        let (_dir, db) = db().await;
        let made = create_saved_query_impl(&db.pool, "default", "failed orders", "SELECT 1;", 1000)
            .await
            .unwrap();

        assert_eq!(made.connection_id, "default");
        assert_eq!(made.name, "failed orders");
        assert_eq!(made.sql, "SELECT 1;");
        assert_eq!(made.created_at, 1000);
        assert!(!made.id.is_empty(), "the store assigns the id, not the caller");

        let listed = list_saved_queries_impl(&db.pool, "default").await.unwrap();
        assert_eq!(listed, vec![made]);
    }

    // Renaming must not reshuffle the rail, which is the whole reason the
    // order key is created_at rather than name.
    #[tokio::test]
    async fn the_list_is_ordered_by_creation_and_renaming_does_not_move_a_row() {
        let (_dir, db) = db().await;
        let first = create_saved_query_impl(&db.pool, "default", "aaa", "", 100).await.unwrap();
        let second = create_saved_query_impl(&db.pool, "default", "bbb", "", 200).await.unwrap();
        let third = create_saved_query_impl(&db.pool, "default", "ccc", "", 300).await.unwrap();

        rename_saved_query_impl(&db.pool, &third.id, "aaa-renamed-to-sort-first").await.unwrap();

        let ids: Vec<String> =
            list_saved_queries_impl(&db.pool, "default").await.unwrap().into_iter().map(|q| q.id).collect();
        assert_eq!(ids, vec![first.id, second.id, third.id]);
    }

    // Two queries created inside the same millisecond must still have a
    // stable order, or the rail reshuffles between renders for no reason.
    #[tokio::test]
    async fn queries_sharing_a_timestamp_still_order_deterministically() {
        let (_dir, db) = db().await;
        create_saved_query_impl(&db.pool, "default", "one", "", 500).await.unwrap();
        create_saved_query_impl(&db.pool, "default", "two", "", 500).await.unwrap();
        create_saved_query_impl(&db.pool, "default", "three", "", 500).await.unwrap();

        let once: Vec<String> =
            list_saved_queries_impl(&db.pool, "default").await.unwrap().into_iter().map(|q| q.id).collect();
        let twice: Vec<String> =
            list_saved_queries_impl(&db.pool, "default").await.unwrap().into_iter().map(|q| q.id).collect();
        assert_eq!(once, twice);
        assert_eq!(once.len(), 3);
    }

    #[tokio::test]
    async fn renaming_and_editing_sql_update_in_place() {
        let (_dir, db) = db().await;
        let made = create_saved_query_impl(&db.pool, "default", "old name", "SELECT 1;", 1).await.unwrap();

        rename_saved_query_impl(&db.pool, &made.id, "new name").await.unwrap();
        set_saved_query_sql_impl(&db.pool, &made.id, "SELECT 2;").await.unwrap();

        let listed = list_saved_queries_impl(&db.pool, "default").await.unwrap();
        assert_eq!(listed.len(), 1, "an update must not insert a second row");
        assert_eq!(listed[0].name, "new name");
        assert_eq!(listed[0].sql, "SELECT 2;");
        assert_eq!(listed[0].created_at, 1, "editing must not restamp creation");
    }

    #[tokio::test]
    async fn deleting_removes_only_that_query() {
        let (_dir, db) = db().await;
        let keep = create_saved_query_impl(&db.pool, "default", "keep", "", 1).await.unwrap();
        let doomed = create_saved_query_impl(&db.pool, "default", "doomed", "", 2).await.unwrap();

        delete_saved_query_impl(&db.pool, &doomed.id).await.unwrap();

        let listed = list_saved_queries_impl(&db.pool, "default").await.unwrap();
        assert_eq!(listed, vec![keep]);
    }

    // Same shape as watched_tables' scoping test: a second connection has to
    // really exist, because connection_id is a foreign key.
    #[tokio::test]
    async fn queries_are_scoped_per_connection() {
        let (_dir, db) = db().await;
        sqlx::query(
            "INSERT INTO connections (id, name, engine, host, port, database, username, sslmode, created_at, updated_at) \
             VALUES ('staging', 'Staging', 'postgres', 'staging-db.internal', 5432, 'app', 'app_ro', 'require', datetime('now'), datetime('now'))",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        create_saved_query_impl(&db.pool, "default", "dev only", "", 1).await.unwrap();
        assert!(list_saved_queries_impl(&db.pool, "staging").await.unwrap().is_empty());
    }

    // The cascade is the reason connection_id is a real foreign key rather
    // than a loose string: a query naming a dropped connection's tables has
    // nothing left to run against.
    #[tokio::test]
    async fn deleting_a_connection_takes_its_queries_with_it() {
        let (_dir, db) = db().await;
        create_saved_query_impl(&db.pool, "default", "doomed", "", 1).await.unwrap();

        sqlx::query("PRAGMA foreign_keys = ON").execute(&db.pool).await.unwrap();
        sqlx::query("DELETE FROM connections WHERE id = 'default'").execute(&db.pool).await.unwrap();

        assert!(list_saved_queries_impl(&db.pool, "default").await.unwrap().is_empty());
    }

    // Nothing in this module interpolates, so a query whose NAME is hostile
    // is stored and returned verbatim rather than being rejected or mangled.
    #[tokio::test]
    async fn a_hostile_name_is_stored_verbatim_because_nothing_interpolates_it() {
        let (_dir, db) = db().await;
        let nasty = "'; DROP TABLE saved_queries; --";
        let made = create_saved_query_impl(&db.pool, "default", nasty, "", 1).await.unwrap();

        let listed = list_saved_queries_impl(&db.pool, "default").await.unwrap();
        assert_eq!(listed, vec![made]);
        assert_eq!(listed[0].name, nasty);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd apps/devbench/src-tauri && cargo test db_queries
```

Expected: **compile error** — `cannot find function create_saved_query_impl in this scope`, and `LocalDb` unresolved. That is the correct failure; the module has no implementation yet.

- [ ] **Step 4: Write the implementation**

Insert **above** the `#[cfg(test)]` block in `db_queries.rs`:

```rust
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::local_db::LocalDb;

/// A saved query, as stored and as sent over IPC. Field names are the wire
/// names — serde reads them exactly as written, matching `TableRows`'s
/// existing `pk_column`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub sql: String,
    /// Epoch milliseconds. Orders the rail, so a rename never reshuffles it.
    pub created_at: i64,
}

fn row_to_query(r: &sqlx::sqlite::SqliteRow) -> SavedQuery {
    SavedQuery {
        id: r.get("id"),
        connection_id: r.get("connection_id"),
        name: r.get("name"),
        sql: r.get("sql"),
        created_at: r.get("created_at"),
    }
}

pub async fn list_saved_queries_impl(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Vec<SavedQuery>, String> {
    // `id` breaks the tie: two queries created inside one millisecond would
    // otherwise come back in whatever order SQLite felt like, and the rail
    // would reshuffle between renders.
    let rows = sqlx::query(
        "SELECT id, connection_id, name, sql, created_at FROM saved_queries \
         WHERE connection_id = ? ORDER BY created_at, id",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to list saved queries: {e}"))?;

    Ok(rows.iter().map(row_to_query).collect())
}

pub async fn create_saved_query_impl(
    pool: &SqlitePool,
    connection_id: &str,
    name: &str,
    sql: &str,
    now_ms: i64,
) -> Result<SavedQuery, String> {
    let made = SavedQuery {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection_id.to_string(),
        name: name.to_string(),
        sql: sql.to_string(),
        created_at: now_ms,
    };

    sqlx::query(
        "INSERT INTO saved_queries (id, connection_id, name, sql, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&made.id)
    .bind(&made.connection_id)
    .bind(&made.name)
    .bind(&made.sql)
    .bind(made.created_at)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to create saved query: {e}"))?;

    Ok(made)
}

pub async fn rename_saved_query_impl(pool: &SqlitePool, id: &str, name: &str) -> Result<(), String> {
    sqlx::query("UPDATE saved_queries SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to rename saved query: {e}"))?;
    Ok(())
}

pub async fn set_saved_query_sql_impl(pool: &SqlitePool, id: &str, sql: &str) -> Result<(), String> {
    sqlx::query("UPDATE saved_queries SET sql = ? WHERE id = ?")
        .bind(sql)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to save query sql: {e}"))?;
    Ok(())
}

pub async fn delete_saved_query_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM saved_queries WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to delete saved query: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn list_saved_queries(
    db: State<'_, LocalDb>,
    connection_id: String,
) -> Result<Vec<SavedQuery>, String> {
    list_saved_queries_impl(&db.pool, &connection_id).await
}

#[tauri::command]
pub async fn create_saved_query(
    db: State<'_, LocalDb>,
    connection_id: String,
    name: String,
    sql: String,
) -> Result<SavedQuery, String> {
    create_saved_query_impl(&db.pool, &connection_id, &name, &sql, chrono::Utc::now().timestamp_millis()).await
}

#[tauri::command]
pub async fn rename_saved_query(db: State<'_, LocalDb>, id: String, name: String) -> Result<(), String> {
    rename_saved_query_impl(&db.pool, &id, &name).await
}

#[tauri::command]
pub async fn set_saved_query_sql(db: State<'_, LocalDb>, id: String, sql: String) -> Result<(), String> {
    set_saved_query_sql_impl(&db.pool, &id, &sql).await
}

#[tauri::command]
pub async fn delete_saved_query(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    delete_saved_query_impl(&db.pool, &id).await
}
```

- [ ] **Step 5: Register the module and the commands**

In `apps/devbench/src-tauri/src/commands/mod.rs`, add `pub mod db_queries;` **after** `pub mod db_columns;` (the list is alphabetical).

In `apps/devbench/src-tauri/src/main.rs`, find the `tauri::generate_handler![…]` list and add these five beside the other `commands::db*` entries:

```rust
            commands::db_queries::list_saved_queries,
            commands::db_queries::create_saved_query,
            commands::db_queries::rename_saved_query,
            commands::db_queries::set_saved_query_sql,
            commands::db_queries::delete_saved_query,
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/devbench/src-tauri && cargo test
```

Expected: the eight new `db_queries` tests pass; total lib count is **your measured baseline + 8**. Report the number you measured, not the number written here.

If `deleting_a_connection_takes_its_queries_with_it` fails with the query still present, SQLite's `foreign_keys` pragma is off for that connection — the test turns it on explicitly for exactly that reason. Do **not** "fix" this by dropping the cascade assertion.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/migrations/0008_saved_queries.sql apps/devbench/src-tauri/src/commands/db_queries.rs apps/devbench/src-tauri/src/commands/mod.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): store saved queries per connection

A saved query is a document you return to, which is only true if it
survives a restart. It is DevBench's own state about a connection rather
than data inside it, so it lives in the app's SQLite and cascades when
the connection goes.

Ordered by created_at with an id tiebreak: renaming must not reshuffle
the rail, and two queries made in one millisecond must not either."
```

---

## Task 2: The `PendingChange::Sql` arm gets its first test (Rust)

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/db_apply.rs` (test module only — **no production change**)

**Interfaces:**
- Consumes: `apply_changes_impl(pool: &PgPool, changes: &[PendingChange]) -> Result<ApplyOutcome, String>`, `PendingChange::Sql { table, statement, previewed_effect }`, `ApplyOutcome { applied, conflict }`, and the module's existing `test_pool()` / `public()` / `update()` / `fixture()` helpers.
- Produces: nothing consumed downstream. This task closes a coverage hole.

**Why this exists:** the `Sql` arm shipped in Slice 3 (`db_apply.rs:239`) with no test, because no UI could stage one until Slice 4. Task 7 is about to make it reachable. Writing the test *before* that happens is the point.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `apps/devbench/src-tauri/src/commands/db_apply.rs`, after `commits_an_update_an_insert_and_a_delete_in_one_transaction`:

```rust
    // The Sql arm shipped in Slice 3 with no test because nothing could stage
    // one. Slice 4's query tab can, so this is the first proof that a staged
    // statement actually runs — and runs in the SAME transaction as the
    // structured entries beside it, which is what makes Apply one changeset
    // rather than a batch of separate writes.
    #[tokio::test]
    async fn a_staged_statement_runs_in_the_changeset_transaction() {
        let pool = test_pool().await;
        fixture(&pool, "apply_sql_runs", "id serial PRIMARY KEY, status text").await;
        sqlx::query("INSERT INTO apply_sql_runs (status) VALUES ('pending'), ('pending')")
            .execute(&pool).await.unwrap();

        let outcome = apply_changes_impl(&pool, &[
            update("apply_sql_runs", "1", "status", Some("pending"), Some("shipped")),
            PendingChange::Sql {
                table: None,
                statement: "UPDATE apply_sql_runs SET status = 'bulk' WHERE id = 2".into(),
                previewed_effect: "1 row affected when run".into(),
            },
        ]).await.unwrap();

        assert_eq!(outcome, ApplyOutcome { applied: 2, conflict: None });

        let rows: Vec<(i32, Option<String>)> =
            sqlx::query_as("SELECT id, status FROM apply_sql_runs ORDER BY id")
                .fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![(1, Some("shipped".into())), (2, Some("bulk".into()))]);

        sqlx::query("DROP TABLE apply_sql_runs").execute(&pool).await.unwrap();
    }

    // Atomicity has to hold when the failure comes from the free-text arm too.
    // A staged statement is the one entry whose text the app never validated,
    // so it is the likeliest thing in any changeset to fail at Apply.
    #[tokio::test]
    async fn a_failing_staged_statement_rolls_back_the_entries_beside_it() {
        let pool = test_pool().await;
        fixture(&pool, "apply_sql_atomic", "id serial PRIMARY KEY, status text").await;
        sqlx::query("INSERT INTO apply_sql_atomic (status) VALUES ('before')")
            .execute(&pool).await.unwrap();

        let result = apply_changes_impl(&pool, &[
            update("apply_sql_atomic", "1", "status", Some("before"), Some("after")),
            PendingChange::Sql {
                table: None,
                statement: "UPDATE apply_sql_atomic SET status = 'x' WHERE no_such_column = 1".into(),
                previewed_effect: "1 row affected when run".into(),
            },
        ]).await;

        let message = result.expect_err("a broken statement must fail the apply, not be skipped");
        assert!(
            message.contains("staged statement failed"),
            "the error must name the staged statement as the cause, got: {message}",
        );

        let status: String = sqlx::query_scalar("SELECT status FROM apply_sql_atomic WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(status, "before", "the update staged beside it must have rolled back");

        sqlx::query("DROP TABLE apply_sql_atomic").execute(&pool).await.unwrap();
    }

    // §12: the effect is re-derived at Apply, not replayed from what the run
    // reported. previewed_effect is carried for DISPLAY so a divergence is
    // visible; it must never gate or alter what actually runs.
    #[tokio::test]
    async fn previewed_effect_is_display_only_and_does_not_constrain_the_rerun() {
        let pool = test_pool().await;
        fixture(&pool, "apply_sql_effect", "id serial PRIMARY KEY, status text").await;
        sqlx::query("INSERT INTO apply_sql_effect (status) VALUES ('a'), ('a'), ('a')")
            .execute(&pool).await.unwrap();

        // Staged when one row matched; three match by the time Apply runs.
        let outcome = apply_changes_impl(&pool, &[PendingChange::Sql {
            table: None,
            statement: "UPDATE apply_sql_effect SET status = 'b' WHERE status = 'a'".into(),
            previewed_effect: "1 row affected when run".into(),
        }]).await.unwrap();

        assert_eq!(outcome.applied, 1, "applied counts ENTRIES, not rows touched");

        let changed: i64 = sqlx::query_scalar("SELECT count(*) FROM apply_sql_effect WHERE status = 'b'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(changed, 3, "the rerun writes what it matches now, not what the run reported");

        sqlx::query("DROP TABLE apply_sql_effect").execute(&pool).await.unwrap();
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/devbench/src-tauri && cargo test db_apply
```

Expected: **all three fail**. `a_staged_statement_runs_in_the_changeset_transaction` and the others fail on a missing fixture table only if you skipped Step 1's `fixture(...)` lines; the honest first run is that they compile and pass immediately, because the production arm already exists.

**If they pass on the first run, that is the correct outcome for this task** — it is a characterization test written against shipped-but-unproven code, not a TDD cycle. Do not manufacture a failure by breaking the arm. Instead, prove the tests have teeth: temporarily comment out the `sqlx::query(statement).execute(&mut *tx).await` line in the `Sql` arm, re-run, confirm `a_staged_statement_runs_in_the_changeset_transaction` fails, then restore it.

- [ ] **Step 3: Restore the arm and run the full suite**

```bash
cd apps/devbench/src-tauri && cargo test
```

Expected: lib count is **your Task 1 measurement + 3**. Confirm `git diff` shows **only** the test module changed — this task must not touch production code.

- [ ] **Step 4: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/src/commands/db_apply.rs
git commit -m "test(devbench): cover the staged-statement arm of apply_changes

PendingChange::Sql shipped in Slice 3 with no test, because no UI could
stage one until the query tab existed. Slice 4 is about to make it
reachable, so it gets proven first: the statement runs inside the
changeset transaction, a broken one rolls back the entries staged beside
it, and previewed_effect stays display-only rather than constraining the
rerun."
```

---

## Task 3: The saved-query wire, its helpers and the store slice (TypeScript)

**Files:**
- Create: `apps/devbench/src/lib/savedQueries.ts`
- Create: `apps/devbench/src/lib/savedQueries.test.ts`
- Modify: `apps/devbench/src/lib/tauri.ts:249-256` (beside the pending re-export)
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/store/useAppStore.test.ts`

**Interfaces:**
- Consumes: Task 1's five commands and its `SavedQuery` wire shape.
- Produces:
  - `interface SavedQuery { id: string; connection_id: string; name: string; sql: string; created_at: number }`
  - `mergeSavedQueries(existing: SavedQuery[], incoming: SavedQuery[]): SavedQuery[]`
  - `queriesForConnection(all: SavedQuery[], connectionId: string | null): SavedQuery[]`
  - `savedQueryById(all: SavedQuery[], id: string | null): SavedQuery | null`
  - `invokeListSavedQueries(connectionId)`, `invokeCreateSavedQuery(connectionId, name, sql)`, `invokeRenameSavedQuery(id, name)`, `invokeSetSavedQuerySql(id, sql)`, `invokeDeleteSavedQuery(id)`
  - Store: `savedQueries: SavedQuery[]`, `mergeSavedQueriesIntoStore(list)`, `patchSavedQuery(id, patch)`, `removeSavedQuery(id)`

**Why a global list with `connection_id` on each entry, rather than a map keyed by connection:** exactly the reason `pending` is shaped that way (`pendingChanges.ts:12-16`). A query tab pins its connection, so a tab opened against dev must resolve its name while the rail is showing staging. One flat list makes that a lookup instead of a cache-coherency problem.

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `apps/devbench/src/lib/savedQueries.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeSavedQueries, queriesForConnection, savedQueryById, type SavedQuery } from "./savedQueries";

function q(id: string, connectionId: string, name: string, createdAt: number): SavedQuery {
  return { id, connection_id: connectionId, name, sql: "", created_at: createdAt };
}

describe("mergeSavedQueries", () => {
  it("replaces an entry by id rather than appending a second copy", () => {
    const before = [q("a", "c1", "old", 1)];
    const after = mergeSavedQueries(before, [q("a", "c1", "new", 1)]);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("new");
  });

  // The rail loads one connection's list; a query tab pinned to another
  // connection has already put its own entry here. A merge that replaced the
  // array would blank that tab's label.
  it("leaves another connection's entries untouched", () => {
    const before = [q("a", "c1", "dev", 1), q("b", "c2", "staging", 1)];
    const after = mergeSavedQueries(before, [q("a", "c1", "dev renamed", 1)]);
    expect(after.map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(savedQueryById(after, "b")?.name).toBe("staging");
  });

  it("appends entries it has not seen", () => {
    const after = mergeSavedQueries([q("a", "c1", "one", 1)], [q("b", "c1", "two", 2)]);
    expect(after).toHaveLength(2);
  });
});

describe("queriesForConnection", () => {
  it("selects one connection's queries in creation order, id breaking ties", () => {
    const all = [q("z", "c1", "third", 5), q("a", "c1", "tied", 5), q("m", "c1", "first", 1), q("x", "c2", "other", 0)];
    expect(queriesForConnection(all, "c1").map((x) => x.id)).toEqual(["m", "a", "z"]);
  });

  it("is empty when no connection is selected", () => {
    expect(queriesForConnection([q("a", "c1", "one", 1)], null)).toEqual([]);
  });
});

describe("savedQueryById", () => {
  it("returns null rather than undefined for a miss", () => {
    expect(savedQueryById([q("a", "c1", "one", 1)], "nope")).toBeNull();
    expect(savedQueryById([q("a", "c1", "one", 1)], null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/devbench && bun run test savedQueries
```

Expected: FAIL — `Failed to resolve import "./savedQueries"`.

- [ ] **Step 3: Write the helpers**

Create `apps/devbench/src/lib/savedQueries.ts`:

```ts
/** Wire-compatible with the Rust `SavedQuery`. Field names are snake_case
 *  because serde reads them exactly as written, the same way `TableRows`
 *  already carries `pk_column`. */
export interface SavedQuery {
  id: string;
  connection_id: string;
  name: string;
  sql: string;
  /** Epoch milliseconds. Orders the rail; a rename never changes it. */
  created_at: number;
}

/** The list is global while a connection is not — same shape, and same
 *  reason, as `pending` (see `pendingChanges.ts`). The rail loads one
 *  connection's queries at a time, and a query tab pinned to a different
 *  connection has already contributed its own entry, so loading must merge
 *  rather than replace or that tab's label goes blank. */
export function mergeSavedQueries(existing: SavedQuery[], incoming: SavedQuery[]): SavedQuery[] {
  const byId = new Map(existing.map((q) => [q.id, q]));
  incoming.forEach((q) => byId.set(q.id, q));
  return [...byId.values()];
}

/** Sorted the same way `list_saved_queries` sorts, so the rail does not
 *  reorder between a server list and a locally-merged one. */
export function queriesForConnection(all: SavedQuery[], connectionId: string | null): SavedQuery[] {
  if (!connectionId) return [];
  return all
    .filter((q) => q.connection_id === connectionId)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

/** `null` rather than `undefined` for a miss: a query tab whose row has not
 *  loaded yet and one whose row is genuinely gone both render a fallback
 *  label, and no caller benefits from telling them apart. */
export function savedQueryById(all: SavedQuery[], id: string | null): SavedQuery | null {
  if (!id) return null;
  return all.find((q) => q.id === id) ?? null;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/devbench && bun run test savedQueries
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Add the invoke wrappers**

In `apps/devbench/src/lib/tauri.ts`, beside the pending re-export at line 249:

```ts
export type { SavedQuery } from "./savedQueries";
import type { SavedQuery } from "./savedQueries";

export function invokeListSavedQueries(connectionId: string): Promise<SavedQuery[]> {
  return invoke("list_saved_queries", { connectionId });
}

export function invokeCreateSavedQuery(connectionId: string, name: string, sql: string): Promise<SavedQuery> {
  return invoke("create_saved_query", { connectionId, name, sql });
}

export function invokeRenameSavedQuery(id: string, name: string): Promise<void> {
  return invoke("rename_saved_query", { id, name });
}

export function invokeSetSavedQuerySql(id: string, sql: string): Promise<void> {
  return invoke("set_saved_query_sql", { id, sql });
}

export function invokeDeleteSavedQuery(id: string): Promise<void> {
  return invoke("delete_saved_query", { id });
}
```

- [ ] **Step 6: Write the failing store test**

Add to `apps/devbench/src/store/useAppStore.test.ts`:

```ts
  it("merges a connection's saved queries without dropping another connection's", () => {
    useAppStore.setState({
      savedQueries: [{ id: "b", connection_id: "c2", name: "staging", sql: "", created_at: 1 }],
    });
    useAppStore.getState().mergeSavedQueriesIntoStore([
      { id: "a", connection_id: "c1", name: "dev", sql: "", created_at: 1 },
    ]);
    expect(useAppStore.getState().savedQueries.map((q) => q.id).sort()).toEqual(["a", "b"]);
  });

  it("patches a saved query in place, leaving its other fields alone", () => {
    useAppStore.setState({
      savedQueries: [{ id: "a", connection_id: "c1", name: "old", sql: "SELECT 1;", created_at: 7 }],
    });
    useAppStore.getState().patchSavedQuery("a", { name: "new" });
    const [only] = useAppStore.getState().savedQueries;
    expect(only).toEqual({ id: "a", connection_id: "c1", name: "new", sql: "SELECT 1;", created_at: 7 });
  });

  it("removes a saved query by id", () => {
    useAppStore.setState({
      savedQueries: [
        { id: "a", connection_id: "c1", name: "keep", sql: "", created_at: 1 },
        { id: "b", connection_id: "c1", name: "drop", sql: "", created_at: 2 },
      ],
    });
    useAppStore.getState().removeSavedQuery("b");
    expect(useAppStore.getState().savedQueries.map((q) => q.id)).toEqual(["a"]);
  });
```

- [ ] **Step 7: Run it to verify it fails**

```bash
cd apps/devbench && bun run test useAppStore
```

Expected: FAIL — `mergeSavedQueriesIntoStore is not a function`.

- [ ] **Step 8: Add the store slice**

In `apps/devbench/src/store/useAppStore.ts`, extend the import from `../lib/savedQueries`:

```ts
import { mergeSavedQueries, type SavedQuery } from "../lib/savedQueries";
```

Add to the `AppState` interface, after the `pending` block:

```ts
  /** Every saved query this session has loaded, across connections — the
   *  same global-list-with-connection-on-each-entry shape as `pending`, and
   *  for the same reason: a query tab pins its connection, so it must be able
   *  to resolve its own name while the rail is showing another one. */
  savedQueries: SavedQuery[];
  mergeSavedQueriesIntoStore: (list: SavedQuery[]) => void;
  patchSavedQuery: (id: string, patch: { name?: string; sql?: string }) => void;
  removeSavedQuery: (id: string) => void;
```

And to the store body, after `discardAllPending`:

```ts
  savedQueries: [],
  mergeSavedQueriesIntoStore: (list) =>
    set((s) => ({ savedQueries: mergeSavedQueries(s.savedQueries, list) })),
  patchSavedQuery: (id, patch) =>
    set((s) => ({ savedQueries: s.savedQueries.map((q) => (q.id === id ? { ...q, ...patch } : q)) })),
  removeSavedQuery: (id) => set((s) => ({ savedQueries: s.savedQueries.filter((q) => q.id !== id) })),
```

- [ ] **Step 9: Run the full suite**

```bash
cd apps/devbench && bun run test && bun run build
```

Expected: **baseline + 10** passing (7 helper + 3 store), build clean with 0 warnings.

- [ ] **Step 10: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/lib/savedQueries.ts apps/devbench/src/lib/savedQueries.test.ts apps/devbench/src/lib/tauri.ts apps/devbench/src/store/useAppStore.ts apps/devbench/src/store/useAppStore.test.ts
git commit -m "feat(devbench): carry saved queries in one cross-connection list

Same shape as the pending set, for the same reason: a query tab pins the
connection it was opened against, so it has to resolve its own name while
the rail is showing a different one. Loading a connection's list therefore
merges by id rather than replacing, or every other connection's open tab
loses its label."
```

---

## Task 4: `ConnectionRail` — one rail, two segments (spec §3a)

**Files:**
- Create: `apps/devbench/src/components/db/ConnectionRail.tsx` (from `SchemaTree.tsx`)
- Delete: `apps/devbench/src/components/db/SchemaTree.tsx`
- Rename: `apps/devbench/src/components/db/SchemaTree.test.tsx` → `ConnectionRail.test.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx:726-732` (the `<SchemaTree>` call site)

**Interfaces:**
- Consumes: Task 3's `queriesForConnection`, `mergeSavedQueriesIntoStore`, `patchSavedQuery`, `removeSavedQuery`, and the five invoke wrappers.
- Produces:
```ts
export function ConnectionRail(props: {
  connectionId: string | null;
  selected: QualifiedTable | null;            // the browsed table, as today
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
  onSelectTable: (table: QualifiedTable) => void;
  onConnectionChange: (connectionId: string) => void;
  /** "queries" on a query tab, "tables" on a table tab. Initial value only —
   *  the user can switch, and their switch is not persisted. */
  initialSegment: "tables" | "queries";
  /** The query this rail's host tab is showing, if it is a query tab. */
  activeQueryId: string | null;
  /** Open (or focus) a query tab. The rail owns creating and deleting a saved
   *  query; it does not own tabs, so opening one is the host's job. */
  onOpenQuery: (queryId: string) => void;
}): JSX.Element
```

**Why the rail owns the saved-query IPC but not the tab:** both `DbTab` and `QueryTab` render this rail, and both would otherwise need identical create/delete plumbing. It already owns the connections fetch for the same reason. Opening a tab is the one thing it cannot do — `useTabController` holds per-instance debounce timers, so calling the hook a second time inside the rail would create a second, competing writer.

- [ ] **Step 1: Move the file and its test, unchanged**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections/apps/devbench
git mv src/components/db/SchemaTree.tsx src/components/db/ConnectionRail.tsx
git mv src/components/db/SchemaTree.test.tsx src/components/db/ConnectionRail.test.tsx
```

Rename the symbol in all three places: `export function SchemaTree(` → `export function ConnectionRail(` in the component, the import and `describe("SchemaTree"` → `describe("ConnectionRail"` in the test, and the import plus `<SchemaTree` → `<ConnectionRail` in `DbTab.tsx`. All 11 existing test cases stay exactly as they are.

Add the two new required props to `DbTab.tsx`'s call site:

```tsx
        initialSegment="tables"
        activeQueryId={null}
        onOpenQuery={onOpenQuery}
```

(`onOpenQuery` reaches `DbTab` in Task 5. Until then, pass `() => {}` and leave a `// wired in Task 5` comment so the build stays green.)

- [ ] **Step 2: Run the suite to confirm the move changed nothing**

```bash
cd apps/devbench && bun run test ConnectionRail && bun run build
```

Expected: 11 passing, build clean. **Commit this move on its own** — a rename mixed into a feature commit makes the diff unreadable:

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add -A apps/devbench/src/components/db apps/devbench/src/components/db/DbTab.tsx
git commit -m "refactor(devbench): rename SchemaTree to ConnectionRail

It is about to list queries as well as tables, and a query is not part of
a schema. No behaviour change."
```

- [ ] **Step 3: Write the failing tests for the segment and the queries list**

Add to `ConnectionRail.test.tsx`. Note `render` returns nothing positional — every assertion here is about presence, text and calls, because jsdom has no layout:

```tsx
  // Parameters<typeof …>[0] rather than React.ComponentProps: this file does
  // not import React, and the new JSX transform does not put it in scope.
  function renderRail(overrides: Partial<Parameters<typeof ConnectionRail>[0]> = {}) {
    return render(
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        initialSegment="tables"
        activeQueryId={null}
        onOpenQuery={() => {}}
        {...overrides}
      />,
    );
  }

  it("shows the tables list on the Tables segment and the queries list on Queries", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([
      { id: "q1", connection_id: "c1", name: "failed orders today", sql: "SELECT 1;", created_at: 1 },
    ]);

    renderRail();
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    expect(screen.queryByText("failed orders today")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Queries" }));

    await waitFor(() => expect(screen.getByText("failed orders today")).toBeInTheDocument());
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
  });

  // §3a: tables are not created from here, so the footer belongs to one
  // segment only.
  it("shows the New query footer on Queries only", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([]);

    renderRail();
    expect(screen.queryByRole("button", { name: "New query" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Queries" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "New query" })).toBeInTheDocument());
  });

  it("opens on the Queries segment when its host tab is a query tab", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([
      { id: "q1", connection_id: "c1", name: "already open", sql: "", created_at: 1 },
    ]);

    renderRail({ initialSegment: "queries", activeQueryId: "q1" });
    await waitFor(() => expect(screen.getByText("already open")).toBeInTheDocument());
  });

  it("asks its host to open the query that was clicked", async () => {
    const onOpenQuery = vi.fn();
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([
      { id: "q1", connection_id: "c1", name: "failed orders", sql: "", created_at: 1 },
    ]);

    renderRail({ initialSegment: "queries", onOpenQuery });
    await waitFor(() => expect(screen.getByText("failed orders")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open query failed orders" }));

    expect(onOpenQuery).toHaveBeenCalledWith("q1");
  });

  it("creates a query, stores it and opens it", async () => {
    const onOpenQuery = vi.fn();
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([]);
    const create = vi.spyOn(tauriLib, "invokeCreateSavedQuery").mockResolvedValue({
      id: "new1", connection_id: "c1", name: "untitled query", sql: "", created_at: 9,
    });

    renderRail({ initialSegment: "queries", onOpenQuery });
    fireEvent.click(await screen.findByRole("button", { name: "New query" }));

    await waitFor(() => expect(onOpenQuery).toHaveBeenCalledWith("new1"));
    expect(create).toHaveBeenCalledWith("c1", "untitled query", "");
    expect(useAppStore.getState().savedQueries.map((q) => q.id)).toContain("new1");
  });

  // "+ New query" with no delete is a list that can only grow, and the
  // default name guarantees it fills with "untitled query".
  it("deletes a query from the store and the database", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([
      { id: "q1", connection_id: "c1", name: "doomed", sql: "", created_at: 1 },
    ]);
    const del = vi.spyOn(tauriLib, "invokeDeleteSavedQuery").mockResolvedValue(undefined);

    renderRail({ initialSegment: "queries" });
    await waitFor(() => expect(screen.getByText("doomed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete query doomed" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith("q1"));
    expect(useAppStore.getState().savedQueries.find((q) => q.id === "q1")).toBeUndefined();
  });
```

Add `savedQueries: []` to the `useAppStore.setState` call in the file's `beforeEach`, so cases do not leak entries into each other.

- [ ] **Step 4: Run to verify they fail**

```bash
cd apps/devbench && bun run test ConnectionRail
```

Expected: the 6 new cases FAIL (`Unable to find role="tab"`); the 11 existing ones still pass.

- [ ] **Step 5: Implement the segment, the list and the footer**

In `ConnectionRail.tsx`, add the imports:

```tsx
import { queriesForConnection } from "../../lib/savedQueries";
import {
  invokeCreateSavedQuery,
  invokeDeleteSavedQuery,
  invokeListSavedQueries,
} from "../../lib/tauri";
```

Add the props to the signature (`initialSegment`, `activeQueryId`, `onOpenQuery`), then inside the component:

```tsx
  const [segment, setSegment] = useState<"tables" | "queries">(initialSegment);
  const savedQueries = useAppStore((s) => s.savedQueries);
  const mergeSavedQueriesIntoStore = useAppStore((s) => s.mergeSavedQueriesIntoStore);
  const removeSavedQuery = useAppStore((s) => s.removeSavedQuery);
  const queries = queriesForConnection(savedQueries, connectionId);

  // Loads whenever the connection changes, not when the segment does: a query
  // tab's label reads out of this list, so the entries have to be there
  // whether or not anyone has looked at the Queries segment yet.
  useEffect(() => {
    if (!connectionId) return;
    invokeListSavedQueries(connectionId).then(mergeSavedQueriesIntoStore).catch(() => {});
  }, [connectionId, mergeSavedQueriesIntoStore]);

  async function createQuery() {
    if (!connectionId) return;
    const made = await invokeCreateSavedQuery(connectionId, "untitled query", "");
    mergeSavedQueriesIntoStore([made]);
    onOpenQuery(made.id);
  }

  async function deleteQuery(id: string) {
    removeSavedQuery(id);
    await invokeDeleteSavedQuery(id).catch(() => {});
  }
```

Render the segmented control directly under the connection head, before the list. `role="tablist"` / `role="tab"` is what gives the two buttons an accessible relationship; `aria-selected` is what the mockup's `[aria-selected="true"]` rule already styles:

```tsx
      {connectionId ? (
        <div className="border-b border-border px-2 py-1.5">
          <div role="tablist" aria-label="Rail segment" className="flex gap-0.5 rounded-sm bg-surface-2 p-0.5">
            {(["tables", "queries"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={segment === value}
                onClick={() => setSegment(value)}
                className="h-5.5 flex-1 rounded-[4px] text-[10.5px] font-bold uppercase tracking-[0.04em] text-text-faint transition-colors duration-150 hover:text-text-muted aria-selected:bg-surface aria-selected:text-text"
              >
                {value === "tables" ? "Tables" : "Queries"}
              </button>
            ))}
          </div>
        </div>
      ) : null}
```

Wrap the existing tables list in `segment === "tables" ? … : …` and add the queries list as the other branch. The delete button is a **sibling** of the open button, never nested — `SchemaTree`'s watch toggle already carries that comment, and a `<button>` inside a `<button>` is invalid HTML with unpredictable focus:

```tsx
          <div className="flex flex-col gap-0.5 p-1.5">
            {queries.map((q) => (
              <div
                key={q.id}
                className={`flex items-center gap-2 rounded-sm px-2.25 py-1.5 font-mono text-xs ${
                  q.id === activeQueryId ? "bg-surface-2 text-text" : "text-text-muted"
                }`}
              >
                <button
                  type="button"
                  aria-label={`Open query ${q.name}`}
                  aria-current={q.id === activeQueryId}
                  onClick={() => onOpenQuery(q.id)}
                  className="flex-1 truncate text-left"
                >
                  {q.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete query ${q.name}`}
                  onClick={() => void deleteQuery(q.id)}
                  className="ml-auto shrink-0 text-text-faint hover:text-danger"
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
            {queries.length === 0 ? (
              <div className="px-2.25 py-1.5 text-xs text-text-faint">No saved queries yet.</div>
            ) : null}
          </div>
```

Add the footer, outside the list, rendered only on the Queries segment:

```tsx
      {connectionId && segment === "queries" ? (
        <div className="mt-auto border-t border-border p-1.5">
          <SecondaryButton className="h-7 w-full" onClick={() => void createQuery()}>
            New query
          </SecondaryButton>
        </div>
      ) : null}
```

The `<aside>` needs `flex flex-col` for `mt-auto` to pin the footer to the bottom — change its class to `flex w-52.5 min-w-52.5 min-h-0 flex-col overflow-y-auto border-r border-border`.

Add a local `TrashIcon` (copy the one already in `DbTab.tsx:85`) and import `SecondaryButton` from `../ui/SecondaryButton`.

- [ ] **Step 6: Run to verify they pass**

```bash
cd apps/devbench && bun run test ConnectionRail && bun run test && bun run build
```

Expected: 17 passing in this file; full suite **baseline + 6**; build clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/ConnectionRail.tsx apps/devbench/src/components/db/ConnectionRail.test.tsx
git commit -m "feat(devbench): list queries beside tables in the rail

Queries are a peer of tables, not a drawer beneath them: both are things
this connection contains and both open into the main pane. The segment is
local view state seeded from the host tab's kind, so a query tab's rail
opens on Queries without that choice outliving the tab.

The list loads on connection change rather than on segment change: a query
tab reads its label out of this list whether or not anyone has looked at
the Queries segment."
```

---

## Task 5: The `query` tab kind — tokens, routing and the tinted tab (spec §3b)

**Files:**
- Create: `apps/devbench/src/components/db/QueryTab.tsx` (skeleton; Tasks 6–7 fill the pane)
- Modify: `apps/devbench/src/styles/tokens.css` (all four theme blocks)
- Modify: `apps/devbench/src/styles/globals.css:4-22` (`@theme`)
- Modify: `apps/devbench/src/store/useAppStore.ts:14` (`ToolKind`)
- Modify: `apps/devbench/src/store/useTabController.ts:134-142` (`focusOrCreateTab`)
- Modify: `apps/devbench/src/components/shell/ToolPane.tsx`
- Modify: `apps/devbench/src/components/shell/SplitContent.tsx:41-43`
- Modify: `apps/devbench/src/components/shell/AppStrip.tsx:135-159`
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx` (accept and forward `onOpenQuery`)

**Interfaces:**
- Consumes: Task 3's `savedQueryById`; Task 4's `ConnectionRail`.
- Produces:
  - `ToolKind` includes `"query"`; a query tab's `state` is `{ queryId: string; connectionId: string }`.
  - `focusOrCreateTab(kind, statePatch?, match?: (tab: Tab) => boolean)` — when `match` is given it replaces the kind-only lookup.
  - `App.tsx`'s `onOpenQuery(queryId: string)`, threaded `SplitContent → ToolPane → DbTab | QueryTab → ConnectionRail`.
  - `export function QueryTab({ tab, onOpenQuery, watchedTables, onToggleWatch }): JSX.Element`

**Why `query` is in `ToolKind` but not in `TOOLS`:** `TOOLS` (`tools.tsx`) drives the `+` menu and `EmptyPane`. You cannot meaningfully create a query tab from there — it needs a saved query to open. Leaving it out of `TOOLS` keeps the menu at four entries while `ToolPane`'s `switch` stays exhaustive. `tabLabel` and `tabCloseName` both fall back to `tab.kind` when `TOOLS` has no entry, so they need explicit query handling rather than inheriting a sensible default.

**Why the connection is pinned:** §3b. Moving the rail's picker afterwards must not retarget an open query tab — the same rule `InsertTarget` follows (`useAppStore.ts:26-31`). A query written against dev, silently repointed at prod by a picker click, is the failure this prevents.

- [ ] **Step 1: Add the tint tokens**

In `apps/devbench/src/styles/tokens.css`, add to **all four** theme blocks. Dark values go in `:root` and `:root[data-theme="dark"]`; light values in the `@media (prefers-color-scheme: light)` block and `:root[data-theme="light"]`. Missing one block means the tint is right until the user toggles the theme:

```css
  /* A query tab is a different KIND of thing from a table tab, so it reads
     differently — a tint of the surface's own light, never a hue. Semantic
     colour stays reserved for actual state, and a coloured tab would compete
     with the pending panel's own colour-coding. */
  --query-tint: rgba(255, 255, 255, 0.035);
  --query-edge: rgba(255, 255, 255, 0.28);
```

Light values for the other two blocks:

```css
  --query-tint: rgba(16, 21, 31, 0.03);
  --query-edge: rgba(16, 21, 31, 0.35);
```

In `apps/devbench/src/styles/globals.css`, inside `@theme`:

```css
  --color-query-tint: var(--query-tint);
  --color-query-edge: var(--query-edge);
```

- [ ] **Step 2: Write the failing tests**

Add to `apps/devbench/src/store/useTabController.test.ts` (it exists; its `beforeEach` already calls a `reset()` that clears `tabs` and `activeTabId`, and it already imports `renderHook`):

```ts
  it("focuses an existing tab matched by state, not merely by kind", () => {
    // Two query tabs are two documents. A kind-only lookup would focus the
    // first one no matter which query was clicked.
    useAppStore.setState({
      tabs: [
        { id: "t1", kind: "query", pane: "left", ordinal: 0, state: { queryId: "q1", connectionId: "c1" } },
        { id: "t2", kind: "query", pane: "left", ordinal: 1, state: { queryId: "q2", connectionId: "c1" } },
      ],
      activeTabId: { left: "t1", right: null },
    });

    const { result } = renderHook(() => useTabController());
    const id = result.current.focusOrCreateTab("query", undefined, (t) => t.state.queryId === "q2");

    expect(id).toBe("t2");
    expect(useAppStore.getState().activeTabId.left).toBe("t2");
  });
```

Add to `apps/devbench/src/components/shell/AppStrip.test.tsx`. Note the split: `AppStrip` takes `tabs` and `activeTabId` as **props** (see the file's `BASE` object), while `savedQueries` is read from the store by the new `useQueryName` hook — so the tab goes in a prop and only the query goes in `setState`:

```tsx
  const QUERY_TAB: Tab[] = [
    { id: "t-q", kind: "query", pane: "left", ordinal: 0, state: { queryId: "q1", connectionId: "c1" } },
  ];

  function seedQuery() {
    useAppStore.setState({
      savedQueries: [{ id: "q1", connection_id: "c1", name: "failed orders today", sql: "", created_at: 1 }],
    });
  }

  it("labels a query tab with the saved query's name in mono", () => {
    seedQuery();
    render(<AppStrip {...BASE} tabs={QUERY_TAB} activeTabId={{ left: "t-q", right: null }} />);

    const label = screen.getByText("failed orders today");
    expect(label.className).toContain("font-mono");
  });

  it("names the close button for a query tab by its query, not by its kind", () => {
    seedQuery();
    render(<AppStrip {...BASE} tabs={QUERY_TAB} activeTabId={{ left: "t-q", right: null }} />);

    expect(screen.getByRole("button", { name: "Close query failed orders today" })).toBeInTheDocument();
  });
```

This file does not currently import `useAppStore`; add it. Add `savedQueries: []` to a `beforeEach` reset so these two cases do not leak the query into the file's other cases — several of them assert on `getAllByRole("tab")` and would pick up a stray label.

- [ ] **Step 3: Run to verify they fail**

```bash
cd apps/devbench && bun run test useTabController AppStrip
```

Expected: FAIL — `focusOrCreateTab` takes two arguments, and the query tab renders the literal text `query`.

- [ ] **Step 4: Widen `ToolKind` and `focusOrCreateTab`**

`useAppStore.ts:14`:

```ts
/** `query` is a real tab kind but deliberately absent from `TOOLS`: it cannot
 *  be created from the + menu, because opening one needs a saved query to
 *  open. See §3b. */
export type ToolKind = "api" | "db" | "log" | "email" | "query";
```

`useTabController.ts`, replacing `focusOrCreateTab`:

```ts
  /** `match` narrows the lookup past tab kind. Query tabs need it: two saved
   *  queries are two tabs, so a kind-only search would focus whichever one
   *  happened to be first regardless of which query was clicked. */
  function focusOrCreateTab(
    kind: ToolKind,
    statePatch?: Record<string, unknown>,
    match?: (tab: Tab) => boolean,
  ): string {
    const existing = useAppStore
      .getState()
      .tabs.find((t) => t.pane === "left" && t.kind === kind && (match ? match(t) : true));
    if (existing) {
      setActiveTabIdInStore("left", existing.id);
      if (statePatch) patchTabState(existing.id, statePatch);
      return existing.id;
    }
    return addTab(kind, "left", statePatch ?? {});
  }
```

- [ ] **Step 5: Label and tint the tab**

In `AppStrip.tsx`, replace `tabLabel` and `tabCloseName`:

```tsx
function useQueryName(tab: Tab): string | null {
  const savedQueries = useAppStore((s) => s.savedQueries);
  if (tab.kind !== "query") return null;
  const id = typeof tab.state.queryId === "string" ? tab.state.queryId : null;
  return savedQueryById(savedQueries, id)?.name ?? "untitled query";
}

function TabLabel({ tab }: { tab: Tab }) {
  const meta = TABS.find((t) => t.id === tab.kind);
  const queryName = useQueryName(tab);
  // Visible subtitle stays the bare name, not schema-qualified — same
  // no-visible-change-in-`public` rule ConnectionRail's own label follows.
  const subtitle = tab.kind === "db" ? (normalizeTable(tab.state.table)?.name ?? null) : null;

  // A query tab's NAME is the label, not a subtitle under a kind word: the
  // document is the thing, and "Query / failed orders today" would read as a
  // category with an instance under it.
  if (queryName !== null) {
    return (
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="shrink-0 text-text-faint">
          <QueryIcon />
        </span>
        <span className="max-w-40 truncate font-mono">{queryName}</span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      {meta ? (
        <span aria-hidden="true" className="shrink-0 text-text-faint">
          {meta.icon}
        </span>
      ) : null}
      <span className="flex flex-col items-start leading-tight">
        <span>{meta?.label ?? tab.kind}</span>
        {subtitle ? <span className="font-mono text-[10px] text-text-faint">{subtitle}</span> : null}
      </span>
    </span>
  );
}

function tabCloseName(tab: Tab, queryName: string | null): string {
  if (queryName !== null) return `query ${queryName}`;
  const base = TABS.find((t) => t.id === tab.kind)?.label ?? tab.kind;
  const table = normalizeTable(tab.state.table);
  return table ? `${base} ${table.name}` : base;
}
```

`tabLabel(tab)` was a plain function and is now a component, because it reads the store. Change its call site to `<TabLabel tab={tab} />`. The close button's name needs the same lookup, so lift it into the row: extract the `<div className="group flex shrink-0 items-center">` body into a small `TabRow` component that calls `useQueryName(tab)` once and passes the result to both.

Add the tint to `Tabs.Tab`'s className — appended, so the existing `data-selected:` rules still apply:

```tsx
              className={`shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 data-selected:bg-surface-2 data-selected:font-semibold data-selected:text-text ${
                tab.kind === "query"
                  ? "data-selected:bg-query-tint data-selected:shadow-[inset_0_-2px_0_var(--query-edge)]"
                  : ""
              }`}
```

Add a `QueryIcon` beside the file's other icons (the mockup uses a play glyph):

```tsx
function QueryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}
```

- [ ] **Step 6: Route the tab**

`SplitContent.tsx:41-43` — a query tab manages its own edge-to-edge layout for the same reason a DB tab does, and its editor is full-bleed by definition:

```tsx
  function paneOwnsDbLayout(pane: Pane): boolean {
    const kind = tabs.find((t) => t.pane === pane && t.id === activeTabId[pane])?.kind;
    return kind === "db" || kind === "query";
  }
```

Thread `onOpenQuery: (queryId: string) => void` through `SplitContent`'s props into `ToolPane`, exactly as `onOpenDb` already is.

`ToolPane.tsx` — add the case, and pass `onOpenQuery` to the `db` case too, since `DbTab`'s rail needs it:

```tsx
    case "query":
      return (
        <QueryTab
          tab={tab}
          onOpenQuery={onOpenQuery}
          watchedTables={watchedTables}
          onToggleWatch={toggleWatchedTable}
        />
      );
```

`App.tsx` — define the handler beside the existing `onOpenDb`, and pass it into `SplitContent`:

```tsx
  function onOpenQuery(queryId: string) {
    const connectionId = useAppStore.getState().activeConnectionId;
    if (!connectionId) return;
    // Matched on queryId: one saved query is one document, so selecting the
    // same query again focuses its tab instead of stacking a duplicate (§3b).
    // The connection is captured here and never patched afterwards — moving
    // the rail's picker must not silently repoint an open query at another
    // database.
    tabController.focusOrCreateTab(
      "query",
      { queryId, connectionId },
      (t) => t.state.queryId === queryId,
    );
  }
```

- [ ] **Step 7: Create the `QueryTab` skeleton**

Create `apps/devbench/src/components/db/QueryTab.tsx`. The pane is filled in Tasks 6–7; this task ends with a tab that routes, labels and tints correctly:

```tsx
import { ConnectionRail } from "./ConnectionRail";
import { useAppStore, type Tab } from "../../store/useAppStore";
import { savedQueryById } from "../../lib/savedQueries";
import type { QualifiedTable } from "../../lib/tauri";

export function QueryTab({
  tab,
  onOpenQuery,
  watchedTables,
  onToggleWatch,
}: {
  tab: Tab;
  onOpenQuery: (queryId: string) => void;
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
}) {
  const queryId = typeof tab.state.queryId === "string" ? tab.state.queryId : null;
  // Pinned at open (§3b), read from tab state rather than from the store's
  // active connection: moving the rail's picker must not retarget this tab.
  const connectionId = typeof tab.state.connectionId === "string" ? tab.state.connectionId : null;
  const savedQueries = useAppStore((s) => s.savedQueries);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const query = savedQueryById(savedQueries, queryId);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0">
      <ConnectionRail
        connectionId={connectionId}
        selected={null}
        watchedTables={watchedTables}
        onToggleWatch={onToggleWatch}
        onSelectTable={() => {}}
        onConnectionChange={setActiveConnectionId}
        initialSegment="queries"
        activeQueryId={queryId}
        onOpenQuery={onOpenQuery}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-query-tint">
        <div className="flex h-11 items-center border-b border-border px-3">
          <span className="font-mono text-xs text-text-muted">{query?.name ?? "untitled query"}</span>
        </div>
      </div>
    </div>
  );
}
```

`DbTab.tsx` gains an `onOpenQuery` prop and forwards it to its rail, replacing Task 4's `() => {}` placeholder.

- [ ] **Step 8: Run everything**

```bash
cd apps/devbench && bun run test && bun run build
```

Expected: **baseline + 3**; build clean. If `tsc` reports a non-exhaustive `switch` in `ToolPane`, the `"query"` case is missing or misspelled — that error is the type system doing its job, not a nuisance to cast away.

- [ ] **Step 9: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/styles apps/devbench/src/store apps/devbench/src/components/shell apps/devbench/src/components/db/QueryTab.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/App.tsx
git commit -m "feat(devbench): open a saved query as its own tab

A query tab is identified by its query and pins the connection it was
opened against, so moving the rail's picker cannot silently repoint a
query written for dev at prod. Selecting the same query twice focuses its
tab rather than stacking a duplicate, which needed focusOrCreateTab to
match on state instead of only on kind.

The tab reads as a different kind of thing through a tint of the surface's
own light and a mono label, never a hue: semantic colour stays reserved
for actual state."
```

---

## Task 6: The query pane — head, editable name, full-bleed editor, resize grip (spec §3b)

**Files:**
- Modify: `apps/devbench/src/components/db/QueryTab.tsx`
- Create: `apps/devbench/src/components/db/QueryTab.test.tsx`

**Interfaces:**
- Consumes: Task 3's `patchSavedQuery`, `invokeRenameSavedQuery`, `invokeSetSavedQuerySql`; Task 5's `QueryTab` skeleton.
- Produces: the pane chrome Task 7 hangs Run and the results off. Exported constants `MIN_EDITOR_PX = 90` and `MAX_EDITOR_PX = 560` (§3b's range), imported by the browser gate in Task 10.

**Layout numbers, all from the mockup and all verified in Task 10, not here:** head 44px with `gap: 10px` between Run and the name; name input 28px, borderless until hover; editor `padding: 12px 14px 20px`, mono, `line-height: 1.6`, default height 220px; grip a 36×4 pill centred in a full-width 14px hit zone; editor and results both on `--bg` while head and tab carry `--query-tint`.

**Why the editor is on `--bg` and not the tint:** §3b. The tint marks *"this is a query"* as a chrome signal; the SQL you write and the rows you get back are ordinary content and sit on the same ground as everywhere else. Tinting the editor would make the signal meaningless by applying it to everything.

**Why renaming keeps the caret:** the mockup patches the tab label's DOM by hand because it re-renders the page from a template string. React does not need that. The input is controlled by store state, the store updates on every keystroke, and only the **SQLite write** is debounced — so nothing async ever writes back into the field while you are typing in it. This is the same shape `patchTabState` uses (`useTabController.ts:104`, `DEBOUNCE_MS = 300`).

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/db/QueryTab.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryTab } from "./QueryTab";
import * as tauriLib from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";
import type { Tab } from "../../store/useAppStore";

const TAB: Tab = {
  id: "t1", kind: "query", pane: "left", ordinal: 0,
  state: { queryId: "q1", connectionId: "c1" },
};

function seed(sql = "SELECT 1;") {
  useAppStore.setState({
    savedQueries: [{ id: "q1", connection_id: "c1", name: "failed orders", sql, created_at: 1 }],
    pending: [],
    activeConnectionId: "c1",
  });
}

function renderTab() {
  return render(
    <QueryTab tab={TAB} onOpenQuery={() => {}} watchedTables={new Set()} onToggleWatch={() => {}} />,
  );
}

describe("QueryTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([]);
    seed();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the query name in an editable field, not as static text", () => {
    renderTab();
    const name = screen.getByRole("textbox", { name: "Query name" });
    expect(name).toHaveValue("failed orders");
  });

  // The store updates on the keystroke so the tab label follows immediately;
  // only the SQLite write waits. Nothing async writes back into the field
  // while it has focus, which is what keeps the caret where it was.
  it("renames into the store immediately and into the database once, debounced", async () => {
    const rename = vi.spyOn(tauriLib, "invokeRenameSavedQuery").mockResolvedValue(undefined);
    renderTab();

    const name = screen.getByRole("textbox", { name: "Query name" });
    fireEvent.change(name, { target: { value: "failed order" } });
    fireEvent.change(name, { target: { value: "failed orders today" } });

    expect(useAppStore.getState().savedQueries[0].name).toBe("failed orders today");
    expect(rename).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(300); });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("q1", "failed orders today");
  });

  it("saves edited SQL to the database once, debounced", async () => {
    const setSql = vi.spyOn(tauriLib, "invokeSetSavedQuerySql").mockResolvedValue(undefined);
    renderTab();

    fireEvent.change(screen.getByRole("textbox", { name: "SQL" }), {
      target: { value: "SELECT 2;" },
    });
    expect(useAppStore.getState().savedQueries[0].sql).toBe("SELECT 2;");
    expect(setSql).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(300); });
    expect(setSql).toHaveBeenCalledWith("q1", "SELECT 2;");
  });

  it("gives the resize grip a separator role with a horizontal orientation", () => {
    renderTab();
    const grip = screen.getByRole("separator", { name: "Resize query editor" });
    expect(grip).toHaveAttribute("aria-orientation", "horizontal");
  });

  // The pane strip's Pending button is global by design (§10 Scope) — it is
  // the only route to entries staged on a connection you are not looking at.
  it("shows the Pending button only when something is staged", () => {
    const { rerender } = renderTab();
    expect(screen.queryByRole("button", { name: /Pending/ })).not.toBeInTheDocument();

    act(() => {
      useAppStore.setState({
        pending: [{ kind: "sql", connection_id: "c1", table: null, statement: "SELECT 1;", previewed_effect: "1 row affected when run" }],
      });
    });
    rerender(<QueryTab tab={TAB} onOpenQuery={() => {}} watchedTables={new Set()} onToggleWatch={() => {}} />);
    expect(screen.getByRole("button", { name: /Pending/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/devbench && bun run test QueryTab
```

Expected: FAIL — `Unable to find an accessible element with the role "textbox" and name "Query name"`.

- [ ] **Step 3: Build the pane**

Replace `QueryTab.tsx`'s placeholder pane. The whole component:

```tsx
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ConnectionRail } from "./ConnectionRail";
import { SecondaryButton } from "../ui/SecondaryButton";
import { useAppStore, type Tab } from "../../store/useAppStore";
import { savedQueryById } from "../../lib/savedQueries";
import {
  invokeRenameSavedQuery,
  invokeSetSavedQuerySql,
  type QualifiedTable,
} from "../../lib/tauri";

/** §3b's range for the editor. Exported for the browser gate, which measures
 *  the grip against them rather than trusting the CSS. */
export const MIN_EDITOR_PX = 90;
export const MAX_EDITOR_PX = 560;
const DEFAULT_EDITOR_PX = 220;
/** Matches useTabController's own write debounce; a query's name and SQL are
 *  the same kind of thing as tab state — typed continuously, persisted
 *  occasionally. */
const WRITE_DEBOUNCE_MS = 300;

export function QueryTab({
  tab,
  onOpenQuery,
  watchedTables,
  onToggleWatch,
}: {
  tab: Tab;
  onOpenQuery: (queryId: string) => void;
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
}) {
  const queryId = typeof tab.state.queryId === "string" ? tab.state.queryId : null;
  const connectionId = typeof tab.state.connectionId === "string" ? tab.state.connectionId : null;
  const savedQueries = useAppStore((s) => s.savedQueries);
  const patchSavedQuery = useAppStore((s) => s.patchSavedQuery);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const pending = useAppStore((s) => s.pending);
  const dockPanel = useAppStore((s) => s.dockPanel);
  const setDockPanel = useAppStore((s) => s.setDockPanel);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const query = savedQueryById(savedQueries, queryId);

  const [editorHeight, setEditorHeight] = useState(DEFAULT_EDITOR_PX);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);
  const writeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // One timer per field, keyed, so renaming does not cancel a pending SQL
  // write or vice versa.
  function debouncedWrite(key: string, write: () => Promise<unknown>) {
    const existing = writeTimers.current.get(key);
    if (existing !== undefined) clearTimeout(existing);
    writeTimers.current.set(
      key,
      setTimeout(() => {
        writeTimers.current.delete(key);
        void write().catch(() => {});
      }, WRITE_DEBOUNCE_MS),
    );
  }

  // A tab closed mid-debounce would otherwise fire a write against an
  // unmounted component. The keystrokes are already in the store either way;
  // this only drops the trailing persist, which the next edit re-schedules.
  useEffect(() => {
    const timers = writeTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  function onNameChange(name: string) {
    if (!queryId) return;
    // Store first, synchronously: the tab label reads out of the store, so
    // this is what makes the label track the field without anything writing
    // back into the field the caret is sitting in.
    patchSavedQuery(queryId, { name });
    debouncedWrite("name", () => invokeRenameSavedQuery(queryId, name));
  }

  function onSqlChange(sql: string) {
    if (!queryId) return;
    patchSavedQuery(queryId, { sql });
    debouncedWrite("sql", () => invokeSetSavedQuerySql(queryId, sql));
  }

  function onGripMouseMove(e: MouseEvent) {
    if (!dragState.current) return;
    const dy = e.clientY - dragState.current.startY;
    setEditorHeight(
      Math.min(MAX_EDITOR_PX, Math.max(MIN_EDITOR_PX, dragState.current.startHeight + dy)),
    );
  }

  function onGripMouseUp() {
    dragState.current = null;
    window.removeEventListener("mousemove", onGripMouseMove);
    window.removeEventListener("mouseup", onGripMouseUp);
  }

  function onGripMouseDown(e: ReactMouseEvent) {
    dragState.current = { startY: e.clientY, startHeight: editorHeight };
    window.addEventListener("mousemove", onGripMouseMove);
    window.addEventListener("mouseup", onGripMouseUp);
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0">
      <ConnectionRail
        connectionId={connectionId}
        selected={null}
        watchedTables={watchedTables}
        onToggleWatch={onToggleWatch}
        onSelectTable={() => {}}
        onConnectionChange={setActiveConnectionId}
        initialSegment="queries"
        activeQueryId={queryId}
        onOpenQuery={onOpenQuery}
      />
      {/* The tint lives on the pane's chrome. The editor and results below
          re-assert --bg, because what you write and what comes back are
          ordinary content (§3b). */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-query-tint">
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border pl-3 pr-2.5">
          {/* Run leads, the name follows: on a tab whose purpose is executing
              something, the action is the subject. Filled in Task 7. */}
          <RunSlot />
          <input
            aria-label="Query name"
            spellCheck={false}
            value={query?.name ?? ""}
            onChange={(e) => onNameChange(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-2 text-[13.5px] font-semibold text-text outline-none hover:border-border focus:border-text-faint focus:bg-bg"
          />
          {pending.length > 0 ? (
            <SecondaryButton
              className="h-7 gap-1.5"
              aria-pressed={dockPanel === "pending"}
              onClick={() => {
                setDockPanel("pending");
                setChatOpen(true);
              }}
            >
              <span>Pending</span>
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-lg bg-accent px-1 text-[10.5px] font-bold text-accent-on">
                {pending.length}
              </span>
            </SecondaryButton>
          ) : null}
        </div>

        {/* Full bleed: the editor is the content of this pane, not a field
            sitting inside it, so it runs edge to edge with no gutter. */}
        <div className="relative shrink-0 border-b border-border bg-bg" style={{ height: editorHeight }}>
          <textarea
            aria-label="SQL"
            spellCheck={false}
            value={query?.sql ?? ""}
            onChange={(e) => onSqlChange(e.target.value)}
            className="block h-full w-full resize-none border-0 bg-transparent px-3.5 pb-5 pt-3 font-mono text-xs leading-[1.6] text-text outline-none"
          />
          {/* Full-width hit zone, small centred grip: the affordance reads as
              "bottom middle", not a bar spanning the pane. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize query editor"
            onMouseDown={onGripMouseDown}
            className="group absolute inset-x-0 bottom-0 flex h-3.5 cursor-row-resize items-center justify-center"
          >
            <div className="h-1 w-9 rounded-full bg-border transition-colors duration-150 group-hover:bg-text-faint" aria-hidden />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto bg-bg px-3.5 py-3">
          <ResultsSlot />
        </div>
      </div>
    </div>
  );
}
```

`RunSlot` and `ResultsSlot` are temporary stubs — define them at the bottom of the file as `function RunSlot() { return null; }` and `function ResultsSlot() { return null; }`. Task 7 replaces both. They exist so this task ends with a pane that renders, and so the diff Task 7 produces is confined to the parts it owns.

- [ ] **Step 4: Run to verify they pass**

```bash
cd apps/devbench && bun run test QueryTab && bun run test && bun run build
```

Expected: 5 passing in this file; full suite **baseline + 5**; build clean.

If `renames into the store immediately...` sees `rename` called twice, the debounce map is being recreated each render — `writeTimers` must be a `useRef`, not a plain `const`.

- [ ] **Step 5: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/QueryTab.tsx apps/devbench/src/components/db/QueryTab.test.tsx
git commit -m "feat(devbench): give the query tab its editor and editable name

The name is the document's title, so it is edited in place rather than
behind a dialog. The store takes every keystroke and only the SQLite write
is debounced, so nothing async ever writes back into the field the caret
is sitting in — the mockup patched the tab label's DOM by hand to achieve
the same thing, which React does not need.

The editor runs edge to edge on --bg: the tint marks the pane as a query,
and the SQL you write is ordinary content."
```

---

## Task 7: Run query, its rollback, and Add to pending (spec §12)

**Files:**
- Modify: `apps/devbench/src/components/db/QueryTab.tsx` (`RunSlot`, `ResultsSlot`)
- Modify: `apps/devbench/src/components/db/QueryTab.test.tsx`
- Modify: `apps/devbench/src/store/useAppStore.ts` (`addPendingSql`)
- Modify: `apps/devbench/src/store/useAppStore.test.ts`

**Interfaces:**
- Consumes: `invokePreviewQuery(connectionId, sql): Promise<QueryPreview>` and `invokeRollbackPreview(previewId): Promise<void>` (both already exist, `tauri.ts:285,293`); `QueryPreview { preview_id, columns, rows, rows_affected }`; `DataGrid`.
- Produces: `addPendingSql(connectionId: string, statement: string, previewedEffect: string): void` on the store, appending `{ kind: "sql", connection_id, table: null, statement, previewed_effect }`.

**The rollback rule, and why it is written this way:** the rollback is fired **in the same `.then` continuation the result arrives in** — not in a click handler, not in a `useEffect` cleanup, not awaited before the UI updates. Three consequences follow, and all three are the point:

1. No row lock is held while the user decides. This is the Slice 3 principle ("staged intent holds no transaction") applied to the last path that broke it.
2. An unmount mid-flight still releases the transaction, because the promise chain is not tied to React's lifecycle. `QueryConsole` needed a `stateRef` + unmount-cleanup + `generationRef` to approximate this; none of that is needed once nothing outlives the call.
3. `commit_preview` becomes unreachable, which is what Task 8 acts on.

**Do not reintroduce a generation guard.** There is no state a late response can corrupt: the response is consumed once, in the continuation that requested it, and the transaction it names is already gone.

- [ ] **Step 1: Write the failing store test**

Add to `apps/devbench/src/store/useAppStore.test.ts`:

```ts
  it("stages a sql change with no table, under its own heading", () => {
    useAppStore.setState({ pending: [] });
    useAppStore.getState().addPendingSql("c1", "UPDATE orders SET status = 'x';", "3 rows affected when run");

    expect(useAppStore.getState().pending).toEqual([
      {
        kind: "sql",
        connection_id: "c1",
        table: null,
        statement: "UPDATE orders SET status = 'x';",
        previewed_effect: "3 rows affected when run",
      },
    ]);
  });

  // Two runs of the same statement are two things to apply, unlike a cell
  // staged twice — there is no stored value to compare against, so there is
  // nothing to upsert against either.
  it("appends a second sql change rather than replacing the first", () => {
    useAppStore.setState({ pending: [] });
    useAppStore.getState().addPendingSql("c1", "SELECT 1;", "1 row affected when run");
    useAppStore.getState().addPendingSql("c1", "SELECT 1;", "1 row affected when run");
    expect(useAppStore.getState().pending).toHaveLength(2);
  });
```

- [ ] **Step 2: Add the store action**

In `useAppStore.ts`, beside `addPendingInsert` — interface:

```ts
  /** Spec §12. `table` is always null: a staged statement has no table, so it
   *  files under its own heading rather than under one it might have touched
   *  (§10, §18). Always appended — unlike a cell edit there is no stored
   *  value to compare against, so there is nothing to upsert against. */
  addPendingSql: (connectionId: string, statement: string, previewedEffect: string) => void;
```

Body:

```ts
  addPendingSql: (connectionId, statement, previewedEffect) =>
    set((s) => ({
      pending: [
        ...s.pending,
        { kind: "sql", connection_id: connectionId, table: null, statement, previewed_effect: previewedEffect },
      ],
    })),
```

- [ ] **Step 3: Write the failing pane tests**

Add to `QueryTab.test.tsx`:

```tsx
  const WRITE_PREVIEW = { preview_id: "p1", columns: [], rows: [], rows_affected: 3 };
  const SELECT_PREVIEW = {
    preview_id: "p2",
    columns: ["id", "status"],
    rows: [["1", "failed"]],
    rows_affected: null,
  };

  it("runs the statement and rolls its transaction back without being asked", async () => {
    const run = vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
    expect(run).toHaveBeenCalledWith("c1", "SELECT 1;");
    // Nothing about the result may read as written.
    expect(screen.getByText(/rolled back/i)).toBeInTheDocument();
  });

  it("reports the affected count for a write and offers to stage it", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(screen.getByText(/3 rows affected/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add to pending" })).toBeEnabled();
  });

  // §12: re-running a SELECT at Apply writes nothing, so staging one would
  // occupy a slot in the count without being able to change anything.
  it("refuses to stage a statement that returned rows", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(SELECT_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add to pending" })).toBeDisabled();
  });

  it("stages the statement with the effect the run reported", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to pending" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add to pending" }));

    expect(useAppStore.getState().pending).toEqual([
      {
        kind: "sql",
        connection_id: "c1",
        table: null,
        statement: "SELECT 1;",
        previewed_effect: "3 rows affected when run",
      },
    ]);
    // The result is consumed by staging it; leaving it up invites a second
    // click that would stage the same statement twice.
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
  });

  it("discards the result and stages nothing", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(screen.getByText(/3 rows affected/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.queryByText(/3 rows affected/)).not.toBeInTheDocument();
    expect(useAppStore.getState().pending).toEqual([]);
  });

  it("surfaces a failed run as an error and stages nothing", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockRejectedValue(new Error('column "nope" does not exist'));
    const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(screen.getByText(/column "nope" does not exist/)).toBeInTheDocument());
    // A failed preview_query never returned a preview_id, so there is nothing
    // to roll back and calling it would be a guaranteed "no open preview".
    expect(rollback).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
  });

  it("runs on Cmd+Enter from inside the editor", async () => {
    const run = vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "SQL" }), { key: "Enter", metaKey: true });

    await waitFor(() => expect(run).toHaveBeenCalled());
  });
```

- [ ] **Step 4: Run to verify they fail**

```bash
cd apps/devbench && bun run test QueryTab useAppStore
```

Expected: FAIL — no `Run query` button, `addPendingSql is not a function`.

- [ ] **Step 5: Implement Run and the results**

In `QueryTab.tsx`, add the imports:

```tsx
import { DataGrid } from "./DataGrid";
import { invokePreviewQuery, invokeRollbackPreview, type QueryPreview } from "../../lib/tauri";
```

Add state and the run function inside the component:

```tsx
  const addPendingSql = useAppStore((s) => s.addPendingSql);
  const [result, setResult] = useState<QueryPreview | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  /** §12: the effect the run reported, carried into the pending entry so a
   *  divergence at Apply is visible rather than silent. Only ever built for a
   *  statement that reported a count — a SELECT cannot be staged. */
  function effectLabel(n: number): string {
    return `${n} row${n === 1 ? "" : "s"} affected when run`;
  }

  async function run() {
    if (running || !connectionId || !query) return;
    setRunError(null);
    setResult(null);
    setRunning(true);
    try {
      const preview = await invokePreviewQuery(connectionId, query.sql);
      // Rolled back here, in the continuation that received it — not on a
      // later click and not in an unmount cleanup. Nothing holds a lock while
      // the user decides, and an unmount mid-flight still lands here because
      // this chain is not tied to React's lifecycle. What gets staged is the
      // STATEMENT; Apply re-runs it (§12), so this transaction has no future.
      void invokeRollbackPreview(preview.preview_id).catch(() => {});
      setResult(preview);
    } catch (err) {
      // A failed preview_query never returned a preview_id — there is no
      // transaction of ours to roll back.
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  function stage() {
    if (!connectionId || !query || result?.rows_affected == null) return;
    addPendingSql(connectionId, query.sql, effectLabel(result.rows_affected));
    setResult(null);
  }
```

Wire Cmd+Enter on the textarea:

```tsx
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run();
              }
            }}
```

Replace the `RunSlot` stub with the real button in the head — `inline-flex`, because the app sets `svg { display: block }` globally and a block-level icon inside a button stacks above its label instead of sitting beside it (§14):

```tsx
          <button
            type="button"
            disabled={running || !connectionId}
            onClick={() => void run()}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on transition-opacity duration-150 disabled:opacity-50"
          >
            <PlayIcon />
            <span>Run query</span>
            <span className="text-[10.5px] font-semibold opacity-70">⌘⏎</span>
          </button>
```

Replace the `ResultsSlot` stub with the results body:

```tsx
          {runError ? <div className="text-xs text-danger">{runError}</div> : null}
          {result ? (
            <>
              <div className="flex items-center gap-2 text-xs text-text-faint">
                <span className="rounded-full bg-surface-2 px-2 py-0.5 font-bold text-text-faint">RAN</span>
                <span>
                  ran in a transaction that was rolled back — nothing is written unless you add it to
                  Pending and Apply
                </span>
              </div>
              {result.rows_affected === null ? (
                <DataGrid columns={result.columns} rows={result.rows} />
              ) : (
                <div className="text-xs text-text-faint">
                  {result.rows_affected} row{result.rows_affected === 1 ? "" : "s"} affected — no rows
                  returned.
                </div>
              )}
              {/* 28px, set by the row rather than by each button (§14). */}
              <div className="flex justify-end gap-2">
                <SecondaryButton className="h-7" onClick={() => setResult(null)}>
                  Discard
                </SecondaryButton>
                <button
                  type="button"
                  disabled={result.rows_affected === null}
                  onClick={stage}
                  title={
                    result.rows_affected === null
                      ? "Re-running a query that returns rows writes nothing, so there is nothing to stage."
                      : undefined
                  }
                  className="inline-flex h-7 items-center rounded-sm bg-accent px-3 text-xs font-bold text-accent-on disabled:opacity-50"
                >
                  Add to pending
                </button>
              </div>
            </>
          ) : null}
```

Add a `PlayIcon` beside the file's other helpers (same glyph as `AppStrip`'s `QueryIcon`, at 11px), and delete both stub functions.

- [ ] **Step 6: Run to verify they pass**

```bash
cd apps/devbench && bun run test && bun run build
```

Expected: **baseline + 9** (7 pane + 2 store); build clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/QueryTab.tsx apps/devbench/src/components/db/QueryTab.test.tsx apps/devbench/src/store/useAppStore.ts apps/devbench/src/store/useAppStore.test.ts
git commit -m "feat(devbench): run a query for real, then stage the statement

Run opens a transaction, captures what the statement did and rolls back
inside the same continuation — no lock is held while you decide, and an
unmount mid-flight still releases it because the chain is not tied to
React's lifecycle. That is what lets this path drop the generation guards
the console needed.

Add to pending records the statement and the effect the run reported, and
is refused for anything that returned rows: re-running a SELECT at Apply
writes nothing, so staging one would pad the count that makes Apply N
honest."
```

---

## Task 8: Delete the query console drawer and `commit_preview` (spec §15)

**Files:**
- Delete: `apps/devbench/src/components/db/QueryConsole.tsx`, `apps/devbench/src/components/db/QueryConsole.test.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx` (`consoleOpen`, its toggle, `ConsoleChevronIcon`, the `QueryConsole` import and render)
- Modify: `apps/devbench/src/lib/tauri.ts:289-291` (`invokeCommitPreview`)
- Modify: `apps/devbench/src-tauri/src/commands/query.rs` (`commit_preview_impl`, `commit_preview`, two tests)
- Modify: `apps/devbench/src-tauri/src/main.rs` (unregister `commit_preview`)

**Interfaces:**
- Consumes: nothing new. Task 7 replaced the console's only reason to exist.
- Produces: a smaller surface. `preview_query`, `rollback_preview`, `preview_state` and the sweep all **stay** — Task 7's Run is their live caller.

**Every line number below is advisory; the symbol name is binding.** Tasks 3-7 insert into `tauri.ts` and `DbTab.tsx` before this task reads them, so the offsets cited here — measured at `c8d686f` — will have moved. Locate each target by name and let Step 5's grep be the check.

**Do this in one commit, frontend and backend together.** Deleting `invokeCommitPreview` while `QueryConsole` still imports it breaks the build; deleting the console while `commit_preview` is still registered leaves a Tauri command no code can reach. They are one change.

**Neither Rust test is deleted.** Both assert something that still matters and both are narrowed rather than removed — see Verified fact 2. The lib test count does not move.

- [ ] **Step 1: Delete the console**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections/apps/devbench
git rm src/components/db/QueryConsole.tsx src/components/db/QueryConsole.test.tsx
```

In `DbTab.tsx`, remove: the `QueryConsole` import (line 4), `const [consoleOpen, setConsoleOpen] = useState(false)` (line 176), the `ConsoleChevronIcon` function (line 97), the entire `<button aria-label="Query console" …>` block in the pane strip, and the `{consoleOpen && activeConnectionId ? <QueryConsole … /> : null}` render (line 906).

The Pending button in that strip carries `className={`ml-auto h-7 gap-1.5`}` already, and the console button's `ml-auto` fallback goes away with it — check the strip still pushes Pending to the right when nothing else is there.

- [ ] **Step 2: Delete `invokeCommitPreview`**

In `apps/devbench/src/lib/tauri.ts`, delete the whole `invokeCommitPreview` function (lines 289-291). Leave `invokePreviewQuery` and `invokeRollbackPreview` exactly as they are.

- [ ] **Step 3: Narrow the two Rust tests**

In `apps/devbench/src-tauri/src/commands/query.rs`, rename `a_write_preview_is_not_visible_until_commit` and end it in a rollback. The isolation property it asserts is the one Run depends on; only the commit half goes:

```rust
    // The isolation guarantee Run query rests on: a statement's effect is
    // real inside its transaction and invisible outside it, so the effect can
    // be reported honestly without anything being written.
    #[tokio::test]
    async fn a_write_preview_is_not_visible_outside_its_transaction() {
```

Replace the tail of that test — everything from `commit_preview_impl(&previews, &preview.preview_id).await.unwrap();` to the line before the `DROP TABLE` — with:

```rust
        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let still_pending: String = sqlx::query("SELECT status FROM preview_write_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(still_pending, "pending", "rolling back must leave the row as it was");
```

Then narrow the error test:

```rust
    #[tokio::test]
    async fn rolling_back_an_unknown_preview_id_is_a_clear_error() {
        let previews = PendingPreviewRegistry::new();
        assert!(rollback_preview_impl(&previews, "not-a-real-id").await.is_err());
    }
```

- [ ] **Step 4: Delete the command**

In `query.rs`, delete `commit_preview_impl` (line 126) and the `#[tauri::command] pub async fn commit_preview` (lines 149-152). In `main.rs`, delete the `commands::query::commit_preview,` line from `generate_handler!`.

- [ ] **Step 5: Verify nothing references it**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
grep -rn "commit_preview\|invokeCommitPreview\|QueryConsole\|consoleOpen" apps/devbench/src apps/devbench/src-tauri/src
```

Expected: **no output**. Any hit is a leftover, not an acceptable remainder.

- [ ] **Step 6: Run both suites**

```bash
cd apps/devbench && bun run test && bun run build
cd src-tauri && cargo test
```

Expected: vitest drops by the **19** cases `QueryConsole.test.tsx` held (counted at `c8d686f` with `grep -c "  it(" src/components/db/QueryConsole.test.tsx`; re-count from git before deleting if the file has moved since), **and one test file**. Cargo lib count is **unchanged**: two tests were narrowed, none removed. Build clean, 0 warnings — a `warning: function is never used` for anything preview-related means Step 4 missed something.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add -A apps/devbench/src apps/devbench/src-tauri/src
git commit -m "refactor(devbench): retire the query console and commit_preview

The console is a query tab now. commit_preview goes with it: nothing in
the new path commits a held preview, because Add to pending re-runs the
statement inside the changeset transaction instead. The console was its
only caller anywhere.

preview_query, rollback_preview, preview_state and the sweep all stay —
Run query is their live caller. Both Rust tests that used commit survive,
narrowed to rollback: the isolation property one of them asserts is
exactly what Run depends on."
```

---

## Task 9: `Discard all` becomes the inverse of Apply (spec §10, *Scope*)

**Files:**
- Modify: `apps/devbench/src/store/useAppStore.ts` (`discardAllPending`)
- Modify: `apps/devbench/src/lib/pendingChanges.ts` (a helper for the split)
- Modify: `apps/devbench/src/components/db/PendingPanel.tsx:277`
- Modify: `apps/devbench/src/lib/pendingChanges.test.ts`, `apps/devbench/src/components/db/PendingPanel.test.tsx`

**Interfaces:**
- Consumes: `PendingPanel`'s existing `mine` / `elsewhere` split (`PendingPanel.tsx:221-222`).
- Produces: `discardAllPending(connectionId: string | null): void` — the signature gains a parameter. `entriesForOtherConnections(pending, connectionId)` in `pendingChanges.ts`.

**Why this is a bug and not a preference:** the panel already dims other connections' entries under "switch to it to apply" and disables Apply unless `mine.length > 0`. Every affordance says "this connection's subset is what you act on" — except `Discard all`, which was the only one that could destroy the work the panel had just declared unreachable. Making it connection-scoped makes it the exact inverse of Apply.

**Leave the pane strip's `Pending N` badge alone.** §10's *Scope* is explicit: on a connection with nothing staged, that badge is the only route to the panel that explains where the staged entries live. This task changes exactly one control.

- [ ] **Step 1: Write the failing tests**

Add to `apps/devbench/src/lib/pendingChanges.test.ts`:

```ts
describe("entriesForOtherConnections", () => {
  const mine: PendingChange = { kind: "delete", connection_id: "c1", table: { schema: "public", name: "orders" }, pk_column: "id", pk_value: "1" };
  const theirs: PendingChange = { kind: "delete", connection_id: "c2", table: { schema: "public", name: "orders" }, pk_column: "id", pk_value: "2" };

  it("keeps everything staged against another connection", () => {
    expect(entriesForOtherConnections([mine, theirs], "c1")).toEqual([theirs]);
  });

  // With no connection selected there is no "mine" to discard, so discarding
  // must be a no-op rather than a wipe.
  it("keeps everything when no connection is selected", () => {
    expect(entriesForOtherConnections([mine, theirs], null)).toEqual([mine, theirs]);
  });
});
```

Add to `apps/devbench/src/components/db/PendingPanel.test.tsx`:

```tsx
  it("discards this connection's entries and leaves another connection's standing", () => {
    useAppStore.setState({
      pending: [
        { kind: "delete", connection_id: "c1", table: { schema: "public", name: "orders" }, pk_column: "id", pk_value: "1" },
        { kind: "delete", connection_id: "c2", table: { schema: "public", name: "orders" }, pk_column: "id", pk_value: "2" },
      ],
    });

    // renderPanel's first positional argument is the connection id
    // (`PendingPanel.test.tsx:28`), not an options object.
    renderPanel("c1");
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));

    const left = useAppStore.getState().pending;
    expect(left).toHaveLength(1);
    expect(left[0].connection_id).toBe("c2");
  });
```

(`renderPanel` is the file's existing helper — `renderPanel(connectionId = "c1", onConflictIndex = vi.fn())`.)

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/devbench && bun run test pendingChanges PendingPanel
```

Expected: FAIL — `entriesForOtherConnections` is not exported, and the panel test finds `pending` emptied to `[]`.

- [ ] **Step 3: Implement**

In `pendingChanges.ts`, beside `removeEntries`:

```ts
/** What survives a Discard all on `connectionId`. With no connection selected
 *  nothing is "mine", so nothing is discarded — a null connection must not
 *  read as "discard everything". */
export function entriesForOtherConnections(
  pending: PendingChange[],
  connectionId: string | null,
): PendingChange[] {
  if (!connectionId) return pending;
  return pending.filter((p) => p.connection_id !== connectionId);
}
```

In `useAppStore.ts`, replace the action — interface first:

```ts
  /** Scoped to one connection, making it the exact inverse of Apply (§10).
   *  Left global it was the only control in the panel that could destroy work
   *  the panel itself renders as unreachable from here. */
  discardAllPending: (connectionId: string | null) => void;
```

Body:

```ts
  discardAllPending: (connectionId) =>
    set((s) => ({ pending: entriesForOtherConnections(s.pending, connectionId) })),
```

Add `entriesForOtherConnections` to the existing import from `../lib/pendingChanges`.

In `PendingPanel.tsx:277`, pass the connection:

```tsx
            <SecondaryButton className="h-7.5" disabled={applying} onClick={() => discardAllPending(connectionId)}>
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd apps/devbench && bun run test && bun run build
```

Expected: **baseline + 3**; build clean. `tsc` will flag any other `discardAllPending()` call site that still passes no argument — fix those rather than making the parameter optional, since an omitted argument would silently mean "discard nothing" and read as a broken button.

- [ ] **Step 5: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/lib/pendingChanges.ts apps/devbench/src/lib/pendingChanges.test.ts apps/devbench/src/store/useAppStore.ts apps/devbench/src/components/db/PendingPanel.tsx apps/devbench/src/components/db/PendingPanel.test.tsx
git commit -m "fix(devbench): scope Discard all to the connection Apply uses

The panel already dims other connections' entries under 'switch to it to
apply' and refuses to Apply them. Discard all was the one control that
ignored that and could destroy work the panel had just declared
unreachable from here. It is now the exact inverse of Apply.

The pane strip's badge stays globally counted on purpose: on a connection
with nothing staged it is the only route to the entries staged elsewhere."
```

---

## Task 10: The browser measurement gate and spec reconciliation

**Files:**
- Modify: `apps/devbench/scripts/fk-stub.js`
- Modify: `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md`

jsdom has no layout engine, so everything in this task is measured in a real browser and **reported as numbers**. "Looks right" is not a result. If a measurement fails, fix the code and re-measure — do not relax the pass condition.

**Use `document.elementFromPoint` for every "is this clickable" question.** A z-index read is not evidence: every virtualized row's `transform` creates a stacking context, and this codebase has shipped three separate bugs where the z-index was correct and the element was genuinely unhittable. The most recent got past 522 passing jsdom tests — clicking a control focused it, the browser scrolled it into view *after* the handler ran, and that scroll dismissed the menu the click had just opened (`c8d686f`).

- [ ] **Step 1: Extend the IPC stub**

In `apps/devbench/scripts/fk-stub.js`, add to `HANDLERS`, beside `apply_changes`:

```js
    // One saved query so the rail has something to open without the gate
    // having to create one first. `sql` is a write, so Add to pending is
    // reachable — a SELECT would leave it correctly disabled and the gate
    // would have nothing to measure.
    list_saved_queries: () => [
      { id: "sq1", connection_id: "c1", name: "mark 1042 shipped", created_at: 1,
        sql: "UPDATE orders SET status = 'shipped' WHERE id = 1042;" },
    ],
    create_saved_query: (args) => ({
      id: `sq-${Math.random().toString(36).slice(2, 8)}`,
      connection_id: args.connectionId, name: args.name, sql: args.sql, created_at: 2,
    }),
    rename_saved_query: () => null,
    set_saved_query_sql: () => null,
    delete_saved_query: () => null,
    // Reports an affected count, so the result renders the write branch and
    // Add to pending is enabled. The gate measures the UI around Run, not the
    // write — the transaction it names is rolled back immediately anyway.
    preview_query: () => ({ preview_id: "prev-1", columns: [], rows: [], rows_affected: 3 }),
    rollback_preview: () => null,
```

- [ ] **Step 2: Start the app and load it with the stub**

```bash
cd apps/devbench && bun run dev
```

Drive the page with Playwright (the `playwright` MCP browser tools, or a script using the `npx playwright` already on this machine). Inject `scripts/fk-stub.js` with `addInitScript` **before** navigating to `http://localhost:5173`, then wait for `[role="table"]`.

Record: the viewport size used, and how many rows and columns the grid reports.

- [ ] **Step 3: Re-measure the four regression-critical behaviours**

They are constraints on every task in this plan, and this slice changed the rail every DB tab renders.

```js
(() => {
  const table = document.querySelector('[role="table"]');
  const scroller = table.querySelector('.overflow-auto');
  const th = table.querySelector('[role="columnheader"]');
  const rows = () => [...table.querySelectorAll('[role="row"]')];
  const cell = rows()[1].querySelector('[role="cell"]');
  const before = { th: th.getBoundingClientRect().left, td: cell.getBoundingClientRect().left };
  scroller.scrollLeft = 400;
  const after = { th: th.getBoundingClientRect().left, td: cell.getBoundingClientRect().left };
  scroller.scrollLeft = 0;
  return {
    headerBodyDrift: (after.th - after.td) - (before.th - before.td),
    renderedRows: rows().length,
    pageScrollWidth: document.documentElement.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
  };
})()
```

Pass: `headerBodyDrift === 0`, `renderedRows > 1`, `pageScrollWidth === pageClientWidth`.

- [ ] **Step 4: Measure the rail's segmented control — and that its buttons are hittable**

Click Queries via `elementFromPoint`, not via a selector click, so the measurement proves the button is the topmost element at its own centre:

```js
(() => {
  const seg = document.querySelector('[role="tablist"][aria-label="Rail segment"]');
  const queries = [...seg.querySelectorAll('[role="tab"]')].find(b => b.textContent.trim() === 'Queries');
  const r = queries.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    segmentedControlFound: !!seg,
    queriesHittable: queries === at || queries.contains(at),
    topmostTag: at && at.tagName,
    railWidthBefore: document.querySelector('aside').getBoundingClientRect().width,
  };
})()
```

Pass: `queriesHittable === true`. Then click it for real and confirm the saved query and the `New query` footer both appear.

- [ ] **Step 5: Open the query tab and measure the head**

Click `Open query mark 1042 shipped`, wait for `[aria-label="Query name"]`, then:

```js
(() => {
  const head = document.querySelector('[aria-label="Query name"]').parentElement;
  const kids = [...head.children];
  const tops = kids.map(k => Math.round(k.getBoundingClientRect().top));
  const run = kids.find(k => k.textContent.includes('Run query'));
  const name = document.querySelector('[aria-label="Query name"]');
  return {
    headHeight: Math.round(head.getBoundingClientRect().height),
    oneRow: new Set(tops).size === 1,
    runHeight: Math.round(run.getBoundingClientRect().height),
    nameHeight: Math.round(name.getBoundingClientRect().height),
    gapRunToName: Math.round(name.getBoundingClientRect().left - run.getBoundingClientRect().right),
    runIconInline: getComputedStyle(run).display,
  };
})()
```

Pass: `headHeight === 44`, `oneRow === true`, `runHeight === 28`, `nameHeight === 28`, `gapRunToName` is 10 ±1, `runIconInline === "inline-flex"` (§14 — a block-level button stacks its icon above its label).

- [ ] **Step 6: Measure the editor's full bleed and the tint boundary**

The tint is a chrome signal; if it has leaked onto the editor or the results it marks nothing (§3b):

```js
(() => {
  const ed = document.querySelector('[aria-label="SQL"]');
  const wrap = ed.parentElement;
  const pane = wrap.parentElement;
  const results = pane.lastElementChild;
  const head = document.querySelector('[aria-label="Query name"]').parentElement;
  const paneR = pane.getBoundingClientRect(), wrapR = wrap.getBoundingClientRect();
  const bg = el => getComputedStyle(el).backgroundColor;
  return {
    leftGap: Math.round(wrapR.left - paneR.left),
    rightGap: Math.round(paneR.right - wrapR.right),
    paneTinted: bg(pane),
    headTinted: bg(head),
    editorGround: bg(wrap),
    resultsGround: bg(results),
    editorMono: getComputedStyle(ed).fontFamily,
  };
})()
```

Pass: `leftGap === 0` and `rightGap === 0` (full bleed, no gutter of its own); `editorGround` and `resultsGround` are the page's `--bg`, **not** the tint; `paneTinted` differs from `editorGround`; `editorMono` contains a mono family.

- [ ] **Step 7: Measure the resize grip — hittable at its centre, and clamped**

```js
(() => {
  const grip = document.querySelector('[role="separator"][aria-label="Resize query editor"]');
  const wrap = document.querySelector('[aria-label="SQL"]').parentElement;
  const g = grip.getBoundingClientRect();
  const cx = g.left + g.width / 2, cy = g.top + g.height / 2;
  const at = document.elementFromPoint(cx, cy);
  const pill = grip.firstElementChild.getBoundingClientRect();
  return {
    gripHittable: grip === at || grip.contains(at),
    topmostTag: at && at.tagName,
    hitZoneWidth: Math.round(g.width),
    paneWidth: Math.round(wrap.getBoundingClientRect().width),
    pillWidth: Math.round(pill.width),
    pillCentred: Math.abs((pill.left + pill.width / 2) - cx) <= 1,
    startHeight: Math.round(wrap.getBoundingClientRect().height),
  };
})()
```

Pass: `gripHittable === true`; `hitZoneWidth === paneWidth` (full-width hit zone); `pillWidth` is 36 ±1 and `pillCentred === true` (§3b: the affordance reads as "bottom middle", not a bar spanning the pane).

Then drag it with real mouse events — `mousedown` at the grip centre, `mousemove` far past each bound, `mouseup` — and re-read the wrapper height after each:

Pass: dragging up past the floor clamps at **90**, dragging down past the ceiling clamps at **560**. Report both measured numbers.

- [ ] **Step 8: Run the query and measure the actions row**

Click `Run query`, wait for the `RAN` label, then:

```js
(() => {
  const add = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add to pending');
  const discard = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard');
  const r = add.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    addHittable: add === at || add.contains(at),
    topmostTag: at && at.tagName,
    addHeight: Math.round(r.height),
    discardHeight: Math.round(discard.getBoundingClientRect().height),
    sameBaseline: Math.round(r.top) === Math.round(discard.getBoundingClientRect().top),
    addDisabled: add.disabled,
    ranLabelPresent: !!document.body.textContent.match(/rolled back/i),
  };
})()
```

Pass: `addHittable === true`; `addHeight === 28` and `discardHeight === 28` and `sameBaseline === true` (§14 — the row owns the height, which is what stops a secondary and its primary drifting apart); `addDisabled === false`; `ranLabelPresent === true`.

**Then click Add to pending for real** and confirm the pending badge appears in the head and the result block is gone. A button that measures correctly and does nothing has passed nothing.

- [ ] **Step 9: Measure the rail across a tab-kind switch**

Switch back to the DB tab and forward to the query tab, reading the rail's width each time:

```js
(() => {
  const rail = document.querySelector('aside');
  return { width: Math.round(rail.getBoundingClientRect().width) };
})()
```

Pass: identical on both tab kinds. A rail that resizes as you move between tabs would make the whole pane jump.

- [ ] **Step 10: Record the measurements in the plan**

Append a `## Measured results` section to this file with the viewport, every number from Steps 3–9, and a PASS/FAIL per check. Numbers, not adjectives. If anything failed and was fixed, record the before and after.

- [ ] **Step 11: Reconcile the spec**

Read `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` §3a, §3b, §12, §13, §15, §16 against what was actually built and correct anything that drifted. In particular:

- §13's `SavedQuery` block must match Task 1's real struct.
- §16's Slice 4 test bullets must match the tests that exist.
- §17 must mark Slice 4 as built, not merely planned.
- If any measurement in Step 10 forced a layout change, the layout numbers in §3b must match what was measured, not what was drawn.

Add anything discovered during execution to §18 as a known gap rather than leaving it undocumented.

- [ ] **Step 12: Full green run of all three gates**

```bash
cd apps/devbench && bun run test && bun run build
cd src-tauri && cargo test
```

Report all three numbers measured, and state the delta against the baseline you measured at the start of Task 1.

- [ ] **Step 13: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/scripts/fk-stub.js docs/superpowers/specs/2026-08-02-devbench-table-view-design.md docs/superpowers/plans/2026-08-19-table-view-slice-4-queries.md
git commit -m "test(devbench): measure the query pane in a real browser

The editor's full bleed, the grip's clamp, the 28px actions row and the
tint boundary are all layout claims, and jsdom cannot check any of them.
Every 'is this clickable' question is answered with elementFromPoint: a
z-index read has been wrong three times in this codebase while the element
was genuinely unhittable.

Spec reconciled with what was built."
```

---

## Self-review notes

**Spec coverage.** §3a rail and segmented control → Task 4; saved-query storage → Task 1; the delete affordance → Task 4. §3b query tab kind, tint, pinned connection, focus-not-stack → Task 5; editable name, full-bleed editor, resize grip → Task 6. §12 Run, its rollback, Add to pending, the SELECT gate → Task 7; the `Sql` apply arm → Task 2. §13 saved-query commands → Task 1. §15 console and `commit_preview` removal → Task 8. §10 *Scope* Discard all → Task 9. §14 28px rows and `inline-flex` → measured in Task 10 Steps 5 and 8. §16 all three test families → Tasks 1–9 plus Task 10.

**Deliberately not covered, and why:** the count cache (§13), the `reltuples` fallback (§18), boolean type-sniffing (§7 names it a follow-up), and the filter compiler's casting strategy (§18). None is Slice 4, and each is named in Global Constraints so an executor does not adopt one in passing.

**Type consistency.** `SavedQuery`'s five fields are identical in Task 1's Rust struct, Task 3's TS interface, Task 10's stub and every test fixture. `mergeSavedQueriesIntoStore` is the store action throughout (never `upsertSavedQueries`, an earlier draft's name). `discardAllPending` takes `connectionId: string | null` from Task 9 onward, and Task 9 Step 4 explicitly requires fixing rather than optionalizing the other call sites. `MIN_EDITOR_PX` / `MAX_EDITOR_PX` are exported in Task 6 and asserted by number in Task 10 Step 7.

**One ordering note.** Task 4 leaves `onOpenQuery={() => {}}` in `DbTab` and Task 5 replaces it. That placeholder is deliberate — it keeps Task 4 independently green — and Task 5 Step 7 names its removal, so it cannot survive to the end.
