# Table View Slice 3 — Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the grid writable through staged intent — insert a row, delete a row, toggle a boolean, edit a cell — where nothing touches the database until Apply commits the whole set in one transaction.

**Architecture:** A global, ordered `PendingChange[]` lives in `useAppStore` and is a **diff against the database, not a log**: each update is keyed by `(table, pkValue, column)` and staging a cell back to its stored value removes the entry. The right dock becomes a three-occupant slot (chat | pending | insert) sharing one `DockShell` for width and resize. `apply_changes` replays the ordered set inside a single Postgres transaction, guarding each structured update with `IS NOT DISTINCT FROM` on the value it was staged against, so a row someone else moved rolls the whole set back and reports the divergence. Staged intent holds no transaction, which is what lets the single-preview cell-edit machinery (`editGenerationRef`, in-flight disabling, rollback-on-arrival) be deleted outright.

**Tech Stack:** Rust + sqlx (Postgres 17), Tauri 2 commands, React 18, Zustand, Tailwind v4, vitest + @testing-library/react, Playwright for anything positional.

**Spec:** `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` (§9 insert panel, §10 pending changes, §11 row delete, §15 what this retires, §7 booleans, §1 dock slot, §13 backend commands, §14 shared components, §16 testing, §17 slices).

## Global Constraints

- Visual source of truth: `docs/mockups/devbench-db-connections.html` (runnable; serve with `python3 -m http.server 8899` from `docs/mockups`). This slice's parts are its `.dock` / `.dock-head` / `.dock-body` / `.dock-foot` rules, `.pend*`, `.field-row`, `.cell-check`, `table.data td.staged`, and the `insertPanel()` / `pendingPanel()` / `stageCell()` functions.
- Type scale from the mockup: `--fs-xs: 10.5px`, `--fs-sm: 12px`, `--fs-md: 13.5px`.
- Column, schema and table identifiers are **validated** with `validate_identifier_labeled(kind, identifier)` before interpolation. A `QualifiedTable` cannot exist unvalidated — its only constructor validates, and its `serde(try_from)` funnels IPC through that constructor. Filter and value payloads are **always bound parameters** — never interpolated.
- **Casts on the value side, never the column side, for anything keyed.** `"{col}"::text = $1` is non-sargable and forces a seq scan on an indexed column. `$1::{type}` keeps the index usable. `{type}` comes from the catalog via `get_column_type`, and is still `validate_identifier_labeled`-checked before interpolation — the same two-layer discipline `preview_cell_edit_impl` already applies to `pk_type`.
- jsdom has no layout engine. Never assert layout in vitest, and never write a test that appears to check layout but asserts nothing. Anything positional is verified in a real browser via Playwright with `getComputedStyle` / `getBoundingClientRect` / `document.elementFromPoint`, reporting measured numbers.
- **Baseline to keep green, re-measured on this worktree at `1e67af0` while writing this plan:**
  - `cd apps/devbench && bun run test` → **445 passing / 46 files**
  - `cd apps/devbench && bun run build` → clean (`tsc` then `vite build`), **0 warnings**
  - `cd apps/devbench/src-tauri && cargo test` → **242 passed, 1 ignored** (lib) and **6 passed** (`smoke_test`)
  - Concurrent sessions share this machine and have moved these numbers before. **Re-measure immediately before each task and reconcile against your own measurement**, not against the absolute numbers here. The per-task delta is what must hold; the absolutes are a check, not an authority.
  - Run `cargo test`, **not** `cargo test --lib`. `--lib` does not compile `tests/*.rs` at all, so `tests/smoke_test.rs` can sit broken for tasks without anything noticing. `--lib` is fine for focused iteration on one module; it is not a suite gate.
- Postgres for Rust tests: `localhost:5432`, `postgres`/`postgres`, db `devbench_test`, from this repo's own `docker-compose.yml` (`docker compose up -d postgres`). The running container is `bench-apps-postgres-1` (`postgres:17-alpine`). `test_pool()` hardcodes port 5432 with no `PGPORT` override, so if another project holds 5432 that port must be freed first. Don't modify roles or auth.
- **There is no seeded schema.** `docker-compose.yml` creates an empty `devbench_test`; every Rust test creates and drops its own fixtures. Because cargo runs tests in one process against one shared database concurrently, **every test must use fixture names unique to itself** — two tests sharing `apply_orders` will race and fail intermittently.
- Tauri commands are registered in **`src-tauri/src/main.rs`** (`tauri::generate_handler![…]`), not `lib.rs`.
- These four grid behaviours are regression-critical and must still hold after every task: sticky header stays aligned with body columns under horizontal scroll; virtualization keeps rendering rows; horizontal scroll stays contained (`document.documentElement.scrollWidth === clientWidth`); NULL stays visually distinct from `<unsupported type>`.
- `renderCell` must keep receiving the **data** column index and the **unfiltered** row index. A reorder or filter that shifts either sends a staged change to the wrong cell. Both are covered by existing tests in `DataGrid.test.tsx` and `DbTab.test.tsx`; keep them passing.
- Accessibility must not regress: accessible names on buttons, `aria-sort` on sorted headers, `aria-pressed` where present. Both new dock panels need a landmark with an accessible name, and every staged-cell control needs a name that says what it stages.
- **`cellDisplay`'s boolean value-sniffing in `DataGrid.tsx` stays.** Spec §7 is explicit that replacing the string inference with the real column type "is a follow-up, not part of this design". Slice 3 makes the checkbox *interactive*; it does not change how a boolean is *detected*. Detecting from `cellDisplay(value).kind` also means toggling still works on the first render, before `describe_columns` has landed.
- **Leave the query console drawer exactly as it is.** Slice 4 removes it. Several tasks rewrite parts of `DbTab`, which holds `consoleOpen` and renders `<QueryConsole>` — leave both untouched.
- **`preview_state`, `preview_query`, `commit_preview` and `rollback_preview` all STAY** (spec §12, §15). `QueryConsole.tsx` is their live caller. Only the *cell-edit* use of that machinery is retired, which means exactly `preview_cell_edit` / `preview_cell_edit_impl` and `invokePreviewCellEdit`.
- **Out of scope for this plan — do not start these, and do not "improve" them in passing:** rail segments, queries-as-tabs, the query pane, and the "Add to pending" UI (Slice 4). The `sql` variant of `PendingChange` is built here because §10 defines the type as a four-variant union and Apply must handle whatever the set holds — but **no UI stages one in this slice**.
- **The count cache named in §13 is not built here.** `count_table_rows` is already fetched in parallel per query. Apply refetches the current page and its count directly. Introducing a cache would add an invalidation path with nothing yet complaining about the cost.

---

## Verified facts this plan depends on

Each was measured against the live `bench-apps-postgres-1` (Postgres 17) while writing this plan, not assumed. If any turns out false during execution, stop and re-derive rather than working around it.

1. **`SET "col" = $1` with a text-bound parameter fails on a non-text column.**
   `PREPARE p(text) AS UPDATE t SET n = $1` → `ERROR: column "n" is of type integer but expression is of type text`. Postgres has no assignment cast from `text`. This is why every generated statement in Task 1 casts the value: `$1::int4`.
   This is also a **latent bug in the code being retired**: `preview_cell_edit_impl` never cast its SET value, and all four of its tests edit a `text` column. Deleting it in Task 9 removes the bug with it.
2. **`$n::{type}` + `IS NOT DISTINCT FROM` detects a stale old value.** With `n = 7` stored, `... AND n IS NOT DISTINCT FROM $3::int4` bound `'5'` returns `UPDATE 0`.
3. **`IS NOT DISTINCT FROM` matches a genuine NULL.** With `t IS NULL` stored, the same guard bound `NULL` returns `UPDATE 1`. Plain `=` would return 0 and report a false conflict on every NULL cell.
4. **The grid's own display strings round-trip through the cast.** `'true'::bool` → `t`. `cell_to_string` renders a `timestamptz` via chrono's `Display` as `2026-08-02 10:15:00 UTC`, and `'2026-08-02 10:15:00 UTC'::timestamptz` parses to the same instant. So the guard does not falsely fire on booleans or timestamps.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src-tauri/src/commands/db_apply.rs` | `PendingChange`, `ApplyOutcome`, `ConflictReport`, `apply_changes_impl` and its command. One transaction, ordered replay, conflict detection. Sits beside `db_columns.rs`. |
| `src/lib/pendingChanges.ts` | TS mirror of the wire types plus the whole diff model: keying, typed comparison, upsert-or-delete staging, staged lookup, grouping. Pure — no React, no store. |
| `src/components/shell/DockShell.tsx` | The dock frame extracted from `ChatDock`: width state, `--w-chat`, the resize handle, head/body/foot slots. |
| `src/components/db/InsertPanel.tsx` | Dock occupant. Fields generated from `ColumnInfo`; Save stages an insert. |
| `src/components/db/PendingPanel.tsx` | Dock occupant. Grouped, colour-coded entries; per-entry discard; Apply / Discard all; conflict report. |

**Modified**

| File | Change |
|---|---|
| `src-tauri/src/commands/mod.rs` | Register `db_apply`. |
| `src-tauri/src/main.rs` | Register `apply_changes`; unregister `preview_cell_edit` (Task 9). |
| `src-tauri/src/commands/query.rs` | `preview_cell_edit_impl`, its command and its four tests deleted (Task 9). |
| `src/lib/tauri.ts` | `invokeApplyChanges`; re-export the pending types; `invokePreviewCellEdit` deleted (Task 9). |
| `src/store/useAppStore.ts` | `dockPanel` occupant, the global `pending` set and its three actions. |
| `src/components/shell/ChatDock.tsx` | Renders through `DockShell` instead of owning the frame. |
| `src/App.tsx` | The dock slot renders one of three occupants. |
| `src/components/db/DataGrid.tsx` | `renderRowActions` hook in the actions column. |
| `src/components/db/DbTab.tsx` | Preview machinery deleted; cell edit stages; boolean toggling; staged values and their marker; row delete; Insert wiring; the pane-strip Pending button; Apply refetch. |
| `apps/devbench/scripts/fk-stub.js` | Stubs `apply_changes`; adds a nullable/defaulted/identity column shape the insert panel exercises. |
| `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` | §10 records the wire shape actually built; §13 records `apply_changes`'s real signature; §17 marks Slice 3 planned. |

---

## Task 1: `apply_changes` — one transaction, ordered replay, conflict detection (Rust)

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/db_apply.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `crate::commands::qualified_table::QualifiedTable` (`::new`, `.quoted()`, `Display`), `crate::commands::db::{get_column_type, validate_identifier_labeled}` (both `pub(crate)`, same crate), `crate::connection_registry::ConnectionRegistry`, `crate::local_db::LocalDb`, `crate::secrets::SecretStore`
- Produces:
  - `pub enum PendingChange` — `#[serde(tag = "kind", rename_all = "snake_case")]`, four variants: `Update`, `Insert`, `Delete`, `Sql`
  - `pub struct ConflictReport { index: usize, table: String, description: String, column: Option<String>, expected: Option<String>, found: Option<String>, row_missing: bool }` (Serialize + PartialEq)
  - `pub struct ApplyOutcome { applied: usize, conflict: Option<ConflictReport> }` (Serialize + PartialEq)
  - `pub async fn apply_changes_impl(pool: &PgPool, changes: &[PendingChange]) -> Result<ApplyOutcome, String>`
  - Tauri command `apply_changes(connection_id, changes)`

**Why the wire shape differs from spec §10's sketch:** §10 writes `table: string` and `values: Record<string, string|null>`. `table` becomes a `QualifiedTable` for the same reason §10 itself gives for splitting the primary key into `pkColumn` + `pkValue` — a pre-joined string ends up interpolated into SQL, and `QualifiedTable` is the only validated path a table has to SQL in this codebase. `values` stays a JSON object on the wire and deserializes into a `BTreeMap`, whose iteration order is deterministic, so the generated column list and VALUES list can never drift apart.

- [ ] **Step 1: Register the new module**

In `apps/devbench/src-tauri/src/commands/mod.rs`, keep the list alphabetical — `db_apply` goes between `db` and `db_columns`:

```rust
pub mod db_apply;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/devbench/src-tauri/src/commands/db_apply.rs` containing only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Each test module in this codebase builds its own pool (see db.rs,
    // db_columns.rs and correlation.rs); there is no shared helper to import.
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

    fn public(name: &str) -> QualifiedTable {
        QualifiedTable::new("public", name).unwrap()
    }

    fn update(
        table: &str, pk_value: &str, column: &str,
        old_value: Option<&str>, new_value: Option<&str>,
    ) -> PendingChange {
        PendingChange::Update {
            table: public(table),
            pk_column: "id".into(),
            pk_value: pk_value.into(),
            column: column.into(),
            old_value: old_value.map(str::to_string),
            new_value: new_value.map(str::to_string),
        }
    }

    // Fixture names are unique per test on purpose: cargo runs these
    // concurrently against one shared database, so two tests sharing a table
    // name would race and fail intermittently.
    async fn fixture(pool: &PgPool, name: &str, columns: &str) {
        sqlx::query(&format!("DROP TABLE IF EXISTS {name}")).execute(pool).await.unwrap();
        sqlx::query(&format!("CREATE TABLE {name} ({columns})")).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn commits_an_update_an_insert_and_a_delete_in_one_transaction() {
        let pool = test_pool().await;
        fixture(&pool, "apply_mixed", "id serial PRIMARY KEY, status text").await;
        sqlx::query("INSERT INTO apply_mixed (status) VALUES ('pending'), ('doomed')")
            .execute(&pool).await.unwrap();

        let outcome = apply_changes_impl(&pool, &[
            update("apply_mixed", "1", "status", Some("pending"), Some("shipped")),
            PendingChange::Insert {
                table: public("apply_mixed"),
                values: BTreeMap::from([("status".to_string(), Some("fresh".to_string()))]),
            },
            PendingChange::Delete {
                table: public("apply_mixed"),
                pk_column: "id".into(),
                pk_value: "2".into(),
            },
        ]).await.unwrap();

        assert_eq!(outcome, ApplyOutcome { applied: 3, conflict: None });

        let rows: Vec<(i32, Option<String>)> =
            sqlx::query_as("SELECT id, status FROM apply_mixed ORDER BY id")
                .fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![(1, Some("shipped".into())), (3, Some("fresh".into()))]);

        sqlx::query("DROP TABLE apply_mixed").execute(&pool).await.unwrap();
    }

    // The regression that motivated casting at all: sqlx binds every value as
    // TEXT, and Postgres has no assignment cast from text to integer or
    // boolean, so an uncast `SET "n" = $1` is a hard error on any column that
    // is not text. The retired preview_cell_edit_impl had exactly this bug and
    // never tripped it, because all four of its tests edited a text column.
    #[tokio::test]
    async fn casts_values_for_non_text_columns() {
        let pool = test_pool().await;
        fixture(&pool, "apply_casts", "id serial PRIMARY KEY, n int4, flag bool").await;
        sqlx::query("INSERT INTO apply_casts (n, flag) VALUES (5, true)")
            .execute(&pool).await.unwrap();

        let outcome = apply_changes_impl(&pool, &[
            update("apply_casts", "1", "n", Some("5"), Some("7")),
            update("apply_casts", "1", "flag", Some("true"), Some("false")),
        ]).await.unwrap();

        assert_eq!(outcome.applied, 2);
        assert_eq!(outcome.conflict, None);

        let (n, flag): (i32, bool) = sqlx::query_as("SELECT n, flag FROM apply_casts WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!((n, flag), (7, false));

        sqlx::query("DROP TABLE apply_casts").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn reports_a_conflict_and_writes_nothing_when_the_stored_value_moved() {
        let pool = test_pool().await;
        fixture(&pool, "apply_conflict", "id serial PRIMARY KEY, status text").await;
        sqlx::query("INSERT INTO apply_conflict (status) VALUES ('moved_underneath')")
            .execute(&pool).await.unwrap();

        // The first entry would succeed on its own. It must still be rolled
        // back, because the conflicting second entry aborts the whole set.
        let outcome = apply_changes_impl(&pool, &[
            update("apply_conflict", "1", "status", Some("moved_underneath"), Some("first")),
            update("apply_conflict", "1", "status", Some("stale_expectation"), Some("second")),
        ]).await.unwrap();

        assert_eq!(outcome.applied, 0, "a conflict means nothing was written");
        let conflict = outcome.conflict.expect("the stale expectation must be reported");
        assert_eq!(conflict.index, 1);
        assert_eq!(conflict.column.as_deref(), Some("status"));
        assert_eq!(conflict.expected.as_deref(), Some("stale_expectation"));
        // Read back inside the aborted transaction: what the first entry had
        // already written, which is what the second entry actually collided with.
        assert_eq!(conflict.found.as_deref(), Some("first"));
        assert!(!conflict.row_missing);

        let status: Option<String> = sqlx::query_scalar("SELECT status FROM apply_conflict WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(status.as_deref(), Some("moved_underneath"), "the whole set rolled back");

        sqlx::query("DROP TABLE apply_conflict").execute(&pool).await.unwrap();
    }

    // `IS NOT DISTINCT FROM` rather than `=` exists for exactly this case: `=`
    // against NULL is NULL, never true, so every staged edit of a NULL cell
    // would match zero rows and report a conflict that did not happen.
    #[tokio::test]
    async fn stages_over_a_null_without_reporting_a_conflict() {
        let pool = test_pool().await;
        fixture(&pool, "apply_null_old", "id serial PRIMARY KEY, note text").await;
        sqlx::query("INSERT INTO apply_null_old (note) VALUES (NULL)")
            .execute(&pool).await.unwrap();

        let outcome = apply_changes_impl(&pool, &[
            update("apply_null_old", "1", "note", None, Some("written")),
        ]).await.unwrap();

        assert_eq!(outcome, ApplyOutcome { applied: 1, conflict: None });

        let note: Option<String> = sqlx::query_scalar("SELECT note FROM apply_null_old WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(note.as_deref(), Some("written"));

        sqlx::query("DROP TABLE apply_null_old").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn rolls_everything_back_when_one_entry_errors() {
        let pool = test_pool().await;
        fixture(&pool, "apply_atomic", "id serial PRIMARY KEY, status text NOT NULL").await;
        sqlx::query("INSERT INTO apply_atomic (status) VALUES ('before')")
            .execute(&pool).await.unwrap();

        // The second entry violates NOT NULL — a database error, not a
        // conflict, so it surfaces as Err rather than an ApplyOutcome.
        let result = apply_changes_impl(&pool, &[
            update("apply_atomic", "1", "status", Some("before"), Some("after")),
            update("apply_atomic", "1", "status", Some("after"), None),
        ]).await;
        assert!(result.is_err(), "a failing entry must fail the call, not be skipped");

        let status: String = sqlx::query_scalar("SELECT status FROM apply_atomic WHERE id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(status, "before", "the earlier entry must not survive the failure");

        sqlx::query("DROP TABLE apply_atomic").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn reports_a_missing_row_for_a_delete_that_matches_nothing() {
        let pool = test_pool().await;
        fixture(&pool, "apply_gone", "id serial PRIMARY KEY, status text").await;

        let outcome = apply_changes_impl(&pool, &[
            PendingChange::Delete {
                table: public("apply_gone"),
                pk_column: "id".into(),
                pk_value: "404".into(),
            },
        ]).await.unwrap();

        let conflict = outcome.conflict.expect("a delete matching no row is a conflict");
        assert!(conflict.row_missing);
        assert_eq!(conflict.column, None, "a delete targets a row, not a column");
        assert_eq!(outcome.applied, 0);

        sqlx::query("DROP TABLE apply_gone").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_a_malicious_column_before_it_reaches_sql() {
        let pool = test_pool().await;
        let result = apply_changes_impl(&pool, &[
            update("apply_never_created", "1", "status\" = 'x'; DROP TABLE users; --", Some("a"), Some("b")),
        ]).await;
        assert!(result.is_err(), "an invalid identifier must be rejected before interpolation");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test db_apply`
Expected: FAIL to compile — `cannot find function apply_changes_impl`, `cannot find type PendingChange`, and friends.

- [ ] **Step 4: Write the implementation**

Prepend this above the `#[cfg(test)] mod tests` block in `db_apply.rs`:

```rust
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use tauri::State;

use crate::commands::db::{get_column_type, validate_identifier_labeled};
use crate::commands::qualified_table::QualifiedTable;
use crate::connection_registry::ConnectionRegistry;
use crate::local_db::LocalDb;
use crate::secrets::SecretStore;

/// One staged intention. Ordered: Apply replays the set in staging order, so
/// an insert followed by an update of the same row behaves the way the user
/// watched it being built.
///
/// `table` is a `QualifiedTable`, not the plain string spec §10 sketches, for
/// the reason §10 itself gives for splitting a primary key into column and
/// value: a pre-joined string is a string that ends up interpolated into SQL.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingChange {
    Update {
        table: QualifiedTable,
        pk_column: String,
        pk_value: String,
        column: String,
        /// The value this edit was staged against. It travels into the WHERE
        /// so a row someone else moved matches nothing instead of being
        /// silently overwritten.
        old_value: Option<String>,
        new_value: Option<String>,
    },
    Insert {
        table: QualifiedTable,
        /// A JSON object on the wire. A BTreeMap rather than a HashMap so the
        /// generated column list and VALUES list are built from one
        /// deterministic iteration order and cannot drift apart.
        values: BTreeMap<String, Option<String>>,
    },
    Delete {
        table: QualifiedTable,
        pk_column: String,
        pk_value: String,
    },
    /// Staged from the query console (spec §12). No UI stages one in Slice 3;
    /// the variant exists because Apply must handle whatever the set holds,
    /// and a set that cannot represent it would have to change again in
    /// Slice 4. The statement is re-run here, inside the changeset
    /// transaction — `previewed_effect` is what the frontend displays
    /// alongside it so a divergence is visible rather than silent.
    Sql {
        table: Option<QualifiedTable>,
        statement: String,
        previewed_effect: String,
    },
}

/// A staged entry that no longer matches the database. Reported rather than
/// papered over: the alternative is overwriting someone else's write with a
/// value staged before it happened.
#[derive(Debug, Serialize, PartialEq)]
pub struct ConflictReport {
    /// Position in the submitted set, so the panel can mark the exact entry.
    pub index: usize,
    /// `public.orders` — for display only, never for SQL.
    pub table: String,
    /// `id = 42`, the row this entry targeted.
    pub description: String,
    /// `None` for a delete, which targets a row rather than a column.
    pub column: Option<String>,
    pub expected: Option<String>,
    pub found: Option<String>,
    /// The primary key matched no row at all — someone deleted it. Distinct
    /// from `found: None`, which means the row is there holding NULL.
    pub row_missing: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ApplyOutcome {
    /// Entries applied, not rows touched — it backs the "Apply 3" label.
    pub applied: usize,
    /// `Some(_)` means the transaction rolled back whole and `applied` is 0.
    pub conflict: Option<ConflictReport>,
}

/// Resolves a column's Postgres type for interpolation into a cast. The type
/// comes from the catalog rather than user input, but is validated anyway
/// before it reaches a format string — the same two-layer discipline the rest
/// of this codebase applies to identifiers.
async fn cast_type(
    pool: &PgPool,
    table: &QualifiedTable,
    column: &str,
    kind: &str,
) -> Result<String, String> {
    validate_identifier_labeled(kind, column)?;
    let ty = get_column_type(pool, table, column).await?;
    validate_identifier_labeled(&format!("{kind} type"), &ty)?;
    Ok(ty)
}

/// Reads a column's current value *inside the aborted transaction*, so the
/// conflict reports what this entry actually collided with — including any
/// earlier entry in the same set that already wrote to that cell.
/// `::text` is safe here in a way it would not be in a WHERE: the row is
/// already located by its primary key, so there is no index to defeat.
async fn read_current(
    tx: &mut Transaction<'_, Postgres>,
    table: &QualifiedTable,
    pk_column: &str,
    pk_type: &str,
    pk_value: &str,
    column: &str,
) -> (bool, Option<String>) {
    let sql = format!(
        "SELECT \"{column}\"::text AS v FROM {} WHERE \"{pk_column}\" = $1::{pk_type}",
        table.quoted()
    );
    match sqlx::query(&sql).bind(pk_value).fetch_optional(&mut **tx).await {
        Ok(Some(row)) => (false, row.try_get::<Option<String>, _>("v").ok().flatten()),
        // No row: the primary key matches nothing any more.
        Ok(None) => (true, None),
        // The read itself failed. Reporting "row missing" would be a claim
        // about the data that this call did not establish.
        Err(_) => (false, None),
    }
}

pub async fn apply_changes_impl(
    pool: &PgPool,
    changes: &[PendingChange],
) -> Result<ApplyOutcome, String> {
    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;
    let mut applied = 0usize;

    for (index, change) in changes.iter().enumerate() {
        match change {
            PendingChange::Update { table, pk_column, pk_value, column, old_value, new_value } => {
                let pk_type = cast_type(pool, table, pk_column, "pk column").await?;
                let col_type = cast_type(pool, table, column, "column").await?;

                let sql = format!(
                    "UPDATE {} SET \"{column}\" = $1::{col_type} \
                     WHERE \"{pk_column}\" = $2::{pk_type} \
                       AND \"{column}\" IS NOT DISTINCT FROM $3::{col_type}",
                    table.quoted()
                );
                let result = sqlx::query(&sql)
                    .bind(new_value.as_deref())
                    .bind(pk_value)
                    .bind(old_value.as_deref())
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("update on {table} failed: {e}"))?;

                if result.rows_affected() != 1 {
                    let (row_missing, found) =
                        read_current(&mut tx, table, pk_column, &pk_type, pk_value, column).await;
                    tx.rollback().await.ok();
                    return Ok(ApplyOutcome {
                        applied: 0,
                        conflict: Some(ConflictReport {
                            index,
                            table: table.to_string(),
                            description: format!("{pk_column} = {pk_value}"),
                            column: Some(column.clone()),
                            expected: old_value.clone(),
                            found,
                            row_missing,
                        }),
                    });
                }
                applied += 1;
            }

            PendingChange::Insert { table, values } => {
                if values.is_empty() {
                    return Err(format!("insert into {table} has no values"));
                }
                let mut names = Vec::with_capacity(values.len());
                let mut placeholders = Vec::with_capacity(values.len());
                let mut binds: Vec<Option<&str>> = Vec::with_capacity(values.len());
                for (position, (column, value)) in values.iter().enumerate() {
                    let col_type = cast_type(pool, table, column, "insert column").await?;
                    names.push(format!("\"{column}\""));
                    placeholders.push(format!("${}::{col_type}", position + 1));
                    binds.push(value.as_deref());
                }
                let sql = format!(
                    "INSERT INTO {} ({}) VALUES ({})",
                    table.quoted(),
                    names.join(", "),
                    placeholders.join(", ")
                );
                let mut query = sqlx::query(&sql);
                for bind in binds {
                    query = query.bind(bind);
                }
                query
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("insert into {table} failed: {e}"))?;
                applied += 1;
            }

            PendingChange::Delete { table, pk_column, pk_value } => {
                let pk_type = cast_type(pool, table, pk_column, "pk column").await?;
                let sql = format!(
                    "DELETE FROM {} WHERE \"{pk_column}\" = $1::{pk_type}",
                    table.quoted()
                );
                let result = sqlx::query(&sql)
                    .bind(pk_value)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("delete from {table} failed: {e}"))?;

                if result.rows_affected() != 1 {
                    tx.rollback().await.ok();
                    return Ok(ApplyOutcome {
                        applied: 0,
                        conflict: Some(ConflictReport {
                            index,
                            table: table.to_string(),
                            description: format!("{pk_column} = {pk_value}"),
                            column: None,
                            expected: None,
                            found: None,
                            row_missing: true,
                        }),
                    });
                }
                applied += 1;
            }

            // Re-run verbatim: the console previewed it in a transaction that
            // was rolled back, so this is the first time it runs for real.
            PendingChange::Sql { statement, .. } => {
                sqlx::query(statement)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("staged statement failed: {e}"))?;
                applied += 1;
            }
        }
    }

    tx.commit().await.map_err(|e| format!("commit failed: {e}"))?;
    Ok(ApplyOutcome { applied, conflict: None })
}

#[tauri::command]
pub async fn apply_changes(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
    changes: Vec<PendingChange>,
) -> Result<ApplyOutcome, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    apply_changes_impl(&pool, &changes).await
}
```

- [ ] **Step 5: Register the command**

In `apps/devbench/src-tauri/src/main.rs`, inside `tauri::generate_handler![…]`, add beside the other db commands (they are grouped, not alphabetical — put it after `commands::db_columns::get_referenced_row`):

```rust
            commands::db_apply::apply_changes,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS — baseline + 7, i.e. **249 passed, 1 ignored** (lib) and **6 passed** (`smoke_test`), assuming your re-measured baseline was 242.
If Postgres is not up: `docker compose up -d postgres` from the repo root. If 5432 is held by another project, free it first — `test_pool()` has no port override.

- [ ] **Step 7: Verify there are no new warnings**

Run: `cd apps/devbench/src-tauri && cargo build 2>&1 | grep -c warning`
Expected: `0`

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/src/commands/db_apply.rs apps/devbench/src-tauri/src/commands/mod.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): apply a staged changeset in one transaction"
```

---

## Task 2: The pending set — the diff model, the store, and the invoke wrapper

**Files:**
- Create: `apps/devbench/src/lib/pendingChanges.ts`
- Create: `apps/devbench/src/lib/pendingChanges.test.ts`
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/store/useAppStore.test.ts`
- Modify: `apps/devbench/src/lib/tauri.ts`

**Interfaces:**
- Consumes: `tableKey` from `./tableIdentity`, `QualifiedTable` from `./tauri` (type-only — `tableIdentity.ts` already imports it exactly this way, and a type-only import erases at runtime, so the re-export back out of `tauri.ts` creates no cycle)
- Produces (from `pendingChanges.ts`):
  - `type PendingChange` — four-variant union, snake_case fields, mirroring the Rust enum
  - `type UpdateChange = Extract<PendingChange, { kind: "update" }>`
  - `interface ConflictReport`, `interface ApplyOutcome`
  - `sameStoredValue(a: string | null, b: string | null): boolean`
  - `stageUpdate(pending: PendingChange[], entry: UpdateChange): PendingChange[]`
  - `stagedUpdateFor(pending, table, pkValue, column): { staged: true; value: string | null } | { staged: false }`
  - `toggleDelete(pending, table, pkColumn, pkValue): PendingChange[]`
  - `hasStagedDelete(pending, table, pkValue): boolean`
  - `discardAt(pending, index): PendingChange[]`
  - `interface PendingGroup { label: string; entries: { entry: PendingChange; index: number }[] }`
  - `groupByTable(pending): PendingGroup[]`
- Produces (from `useAppStore.ts`): `DockPanel`, `dockPanel`, `setDockPanel`, `pending`, `stagePendingUpdate`, `togglePendingDelete`, `addPendingInsert`, `discardPendingAt`, `discardAllPending`
- Produces (from `tauri.ts`): `invokeApplyChanges(connectionId, changes): Promise<ApplyOutcome>` and re-exported `PendingChange` / `ApplyOutcome` / `ConflictReport`

**The load-bearing contract, stated once here because every later task depends on it:** an update's `old_value` is **always the stored database value** — the one in `tableRows` — never the currently staged one. That is what makes the set a diff rather than a log, what lets a second toggle *remove* an entry, and what gives the `IS NOT DISTINCT FROM` guard in Task 1 something true to compare against. A caller that passes the staged value instead produces a set that grows forever and an Apply that guards against itself.

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/lib/pendingChanges.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  discardAt,
  groupByTable,
  hasStagedDelete,
  sameStoredValue,
  stageUpdate,
  stagedUpdateFor,
  toggleDelete,
  type PendingChange,
  type UpdateChange,
} from "./pendingChanges";

const ORDERS = { schema: "public", name: "orders" };
const USERS = { schema: "public", name: "users" };

function edit(pkValue: string, column: string, oldValue: string | null, newValue: string | null): UpdateChange {
  return {
    kind: "update",
    table: ORDERS,
    pk_column: "id",
    pk_value: pkValue,
    column,
    old_value: oldValue,
    new_value: newValue,
  };
}

describe("pendingChanges", () => {
  it("stages a cell that differs from its stored value", () => {
    const next = stageUpdate([], edit("1", "status", "pending", "shipped"));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: "update", column: "status", new_value: "shipped" });
  });

  it("replaces the entry for a cell rather than appending a second one", () => {
    const once = stageUpdate([], edit("1", "status", "pending", "shipped"));
    const twice = stageUpdate(once, edit("1", "status", "pending", "cancelled"));
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ new_value: "cancelled" });
  });

  // Spec §10: without this the set is append-only, "Pending 2" would be a lie,
  // and Apply would write a value that is already there.
  it("leaves no pending change when a boolean is toggled back to its stored value", () => {
    const on = stageUpdate([], edit("1", "paid", "false", "true"));
    const off = stageUpdate(on, edit("1", "paid", "false", "false"));
    expect(off).toEqual([]);
  });

  it("leaves no pending change when a text edit is typed back to its stored value", () => {
    const changed = stageUpdate([], edit("1", "status", "pending", "shipped"));
    const back = stageUpdate(changed, edit("1", "status", "pending", "pending"));
    expect(back).toEqual([]);
  });

  it("keeps one entry per cell, not one per row", () => {
    let pending: PendingChange[] = [];
    pending = stageUpdate(pending, edit("1", "status", "pending", "shipped"));
    pending = stageUpdate(pending, edit("1", "notes", null, "checked"));
    expect(pending).toHaveLength(2);
  });

  // A text column holding the four characters N-U-L-L is a value; a real NULL
  // is the absence of one. Comparing display strings would silently drop the
  // change that turns one into the other.
  it('never treats a text value of "NULL" as equal to a real NULL', () => {
    expect(sameStoredValue("NULL", null)).toBe(false);
    expect(sameStoredValue(null, null)).toBe(true);
    expect(sameStoredValue("NULL", "NULL")).toBe(true);
  });

  it("distinguishes a staged NULL from nothing staged", () => {
    const pending = stageUpdate([], edit("1", "notes", "something", null));
    expect(stagedUpdateFor(pending, ORDERS, "1", "notes")).toEqual({ staged: true, value: null });
    expect(stagedUpdateFor(pending, ORDERS, "1", "status")).toEqual({ staged: false });
  });

  it("does not confuse the same primary key in two different tables", () => {
    const pending = stageUpdate([], edit("1", "status", "pending", "shipped"));
    expect(stagedUpdateFor(pending, USERS, "1", "status")).toEqual({ staged: false });
  });

  it("toggles a row delete on and back off", () => {
    const staged = toggleDelete([], ORDERS, "id", "7");
    expect(staged).toHaveLength(1);
    expect(hasStagedDelete(staged, ORDERS, "7")).toBe(true);
    expect(toggleDelete(staged, ORDERS, "id", "7")).toEqual([]);
  });

  it("groups by table in first-appearance order, keeping each entry's index in the whole set", () => {
    const pending: PendingChange[] = [
      edit("1", "status", "pending", "shipped"),
      { kind: "delete", table: USERS, pk_column: "id", pk_value: "9" },
      edit("2", "status", "pending", "failed"),
      { kind: "sql", table: null, statement: "DELETE FROM audit", previewed_effect: "3 rows affected" },
    ];
    const groups = groupByTable(pending);
    expect(groups.map((g) => g.label)).toEqual(["public.orders", "public.users", "SQL"]);
    expect(groups[0].entries.map((e) => e.index)).toEqual([0, 2]);
    expect(groups[2].entries[0].index).toBe(3);
  });

  it("discards one entry by its index in the whole set", () => {
    const pending: PendingChange[] = [
      edit("1", "status", "pending", "shipped"),
      edit("2", "status", "pending", "failed"),
    ];
    expect(discardAt(pending, 0)).toHaveLength(1);
    expect(discardAt(pending, 0)[0]).toMatchObject({ pk_value: "2" });
  });
});
```

Append to `apps/devbench/src/store/useAppStore.test.ts`, inside the existing `describe("useAppStore", ...)` block:

```ts
  it("starts on chat and switches the dock's occupant", () => {
    expect(useAppStore.getState().dockPanel).toBe("chat");
    useAppStore.getState().setDockPanel("pending");
    expect(useAppStore.getState().dockPanel).toBe("pending");
    useAppStore.getState().setDockPanel("chat");
  });

  it("holds one global pending set across tables and clears it wholesale", () => {
    useAppStore.getState().discardAllPending();
    useAppStore.getState().stagePendingUpdate({
      kind: "update",
      table: { schema: "public", name: "orders" },
      pk_column: "id",
      pk_value: "1",
      column: "status",
      old_value: "pending",
      new_value: "shipped",
    });
    useAppStore.getState().togglePendingDelete({ schema: "public", name: "users" }, "id", "9");
    expect(useAppStore.getState().pending).toHaveLength(2);
    useAppStore.getState().discardAllPending();
    expect(useAppStore.getState().pending).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test src/lib/pendingChanges.test.ts src/store/useAppStore.test.ts`
Expected: FAIL — `Failed to resolve import "./pendingChanges"`.

- [ ] **Step 3: Write the pure module**

Create `apps/devbench/src/lib/pendingChanges.ts`:

```ts
import { tableKey } from "./tableIdentity";
import type { QualifiedTable } from "./tauri";

/** Wire-compatible with the Rust `PendingChange`. Field names are snake_case
 *  because serde reads them exactly as written, the same way `TableRows`
 *  already carries `pk_column`. */
export type PendingChange =
  | {
      kind: "update";
      table: QualifiedTable;
      pk_column: string;
      pk_value: string;
      column: string;
      /** ALWAYS the stored database value, never the currently staged one.
       *  This is what makes the set a diff instead of a log, and what the
       *  backend's `IS NOT DISTINCT FROM` guard compares against. */
      old_value: string | null;
      new_value: string | null;
    }
  | { kind: "insert"; table: QualifiedTable; values: Record<string, string | null> }
  | { kind: "delete"; table: QualifiedTable; pk_column: string; pk_value: string }
  | { kind: "sql"; table: QualifiedTable | null; statement: string; previewed_effect: string };

export type UpdateChange = Extract<PendingChange, { kind: "update" }>;

/** Wire-compatible with the Rust `ConflictReport`. */
export interface ConflictReport {
  index: number;
  table: string;
  description: string;
  column: string | null;
  expected: string | null;
  found: string | null;
  /** The primary key matched no row at all — distinct from `found: null`,
   *  which means the row is there holding NULL. */
  row_missing: boolean;
}

/** Wire-compatible with the Rust `ApplyOutcome`. */
export interface ApplyOutcome {
  applied: number;
  conflict: ConflictReport | null;
}

/** A NUL byte separates the parts, not a `:`. A colon can occur inside a
 *  primary-key value, which would let ("a:b", "c") and ("a", "b:c") key to the
 *  same string and cross two unrelated cells' entries. NUL cannot occur in a
 *  Postgres identifier, nor in a text value Postgres will store. */
function updateKey(table: QualifiedTable, pkValue: string, column: string): string {
  return `${tableKey(table)}\u0000${pkValue}\u0000${column}`;
}

/** Spec §10: comparison runs on typed values, not display strings.
 *
 *  On this wire a value is `string | null`, where `null` IS the SQL NULL and
 *  the string "NULL" is four ordinary characters. So identity comparison
 *  already IS the typed comparison the spec asks for, and the failure the spec
 *  warns about — a text cell holding "NULL" testing equal to a real NULL —
 *  cannot arise. This function exists so that reasoning has one home and one
 *  test, rather than being re-derived at every call site. */
export function sameStoredValue(a: string | null, b: string | null): boolean {
  return a === b;
}

function updateIndex(pending: PendingChange[], key: string): number {
  return pending.findIndex(
    (p) => p.kind === "update" && updateKey(p.table, p.pk_value, p.column) === key,
  );
}

export function discardAt(pending: PendingChange[], index: number): PendingChange[] {
  return pending.filter((_, i) => i !== index);
}

/** Spec §10: staging is an upsert-or-delete, not an append. A cell set back to
 *  its stored value removes its entry rather than adding a second one that
 *  cancels the first — otherwise toggling a checkbox twice would read
 *  "Pending 2" and Apply would write a value that is already there. */
export function stageUpdate(pending: PendingChange[], entry: UpdateChange): PendingChange[] {
  const at = updateIndex(pending, updateKey(entry.table, entry.pk_value, entry.column));
  if (sameStoredValue(entry.old_value, entry.new_value)) {
    return at >= 0 ? discardAt(pending, at) : pending;
  }
  if (at < 0) return [...pending, entry];
  return pending.map((p, i) => (i === at ? entry : p));
}

/** A discriminated result rather than `string | null | undefined`: a staged
 *  NULL and "nothing staged" are different facts, and collapsing them would
 *  make a cell staged to NULL render its stored value instead. */
export function stagedUpdateFor(
  pending: PendingChange[],
  table: QualifiedTable,
  pkValue: string,
  column: string,
): { staged: true; value: string | null } | { staged: false } {
  const at = updateIndex(pending, updateKey(table, pkValue, column));
  if (at < 0) return { staged: false };
  const hit = pending[at];
  // Narrowing only — updateIndex matches no other kind.
  return hit.kind === "update" ? { staged: true, value: hit.new_value } : { staged: false };
}

function deleteIndex(pending: PendingChange[], table: QualifiedTable, pkValue: string): number {
  return pending.findIndex(
    (p) => p.kind === "delete" && tableKey(p.table) === tableKey(table) && p.pk_value === pkValue,
  );
}

/** Staging the same row twice means "undo that", not "delete it twice" — the
 *  row action is the only control for it, so it has to be its own undo. */
export function toggleDelete(
  pending: PendingChange[],
  table: QualifiedTable,
  pkColumn: string,
  pkValue: string,
): PendingChange[] {
  const at = deleteIndex(pending, table, pkValue);
  if (at >= 0) return discardAt(pending, at);
  return [...pending, { kind: "delete", table, pk_column: pkColumn, pk_value: pkValue }];
}

export function hasStagedDelete(
  pending: PendingChange[],
  table: QualifiedTable,
  pkValue: string,
): boolean {
  return deleteIndex(pending, table, pkValue) >= 0;
}

export interface PendingGroup {
  label: string;
  /** `index` is the position in the WHOLE set, not in this group — a discard
   *  button and a `ConflictReport` both address that same position. */
  entries: { entry: PendingChange; index: number }[];
}

/** Spec §10: the panel groups by table. A `sql` entry has no table, so it
 *  files under its own heading rather than under one it might have touched. */
export function groupByTable(pending: PendingChange[]): PendingGroup[] {
  const groups: PendingGroup[] = [];
  pending.forEach((entry, index) => {
    const label = entry.table ? tableKey(entry.table) : "SQL";
    let group = groups.find((g) => g.label === label);
    if (!group) {
      group = { label, entries: [] };
      groups.push(group);
    }
    group.entries.push({ entry, index });
  });
  return groups;
}
```

- [ ] **Step 4: Wire the store**

In `apps/devbench/src/store/useAppStore.ts`, add beside the existing imports:

```ts
import {
  discardAt,
  stageUpdate,
  toggleDelete,
  type PendingChange,
  type UpdateChange,
} from "../lib/pendingChanges";
```

Add beside the other exported unions near the top:

```ts
/** Spec §1: the right dock holds one of three occupants at a time. Closing a
 *  panel returns to chat; `chatOpen` still governs whether the dock is open at
 *  all, so AppStrip's existing toggle keeps working unchanged. */
export type DockPanel = "chat" | "pending" | "insert";
```

Add to the `AppState` interface, beside `chatOpen`:

```ts
  dockPanel: DockPanel;
  setDockPanel: (panel: DockPanel) => void;
  /** Spec §10: global, not per-tab. It can hold changes to several tables from
   *  several tabs, and Apply commits them together. */
  pending: PendingChange[];
  stagePendingUpdate: (entry: UpdateChange) => void;
  togglePendingDelete: (table: QualifiedTable, pkColumn: string, pkValue: string) => void;
  addPendingInsert: (table: QualifiedTable, values: Record<string, string | null>) => void;
  discardPendingAt: (index: number) => void;
  discardAllPending: () => void;
```

Add to the store body, beside `chatOpen: true`:

```ts
  dockPanel: "chat",
  setDockPanel: (dockPanel) => set({ dockPanel }),
  pending: [],
  stagePendingUpdate: (entry) => set((s) => ({ pending: stageUpdate(s.pending, entry) })),
  togglePendingDelete: (table, pkColumn, pkValue) =>
    set((s) => ({ pending: toggleDelete(s.pending, table, pkColumn, pkValue) })),
  // Inserts are always appended: two inserts into one table are two rows, so
  // there is nothing here to upsert against.
  addPendingInsert: (table, values) =>
    set((s) => ({ pending: [...s.pending, { kind: "insert", table, values }] })),
  discardPendingAt: (index) => set((s) => ({ pending: discardAt(s.pending, index) })),
  discardAllPending: () => set({ pending: [] }),
```

- [ ] **Step 5: Add the invoke wrapper**

In `apps/devbench/src/lib/tauri.ts`, beside the existing `columnMeta` re-export block:

```ts
export type { PendingChange, ApplyOutcome, ConflictReport } from "./pendingChanges";
import type { ApplyOutcome, PendingChange } from "./pendingChanges";

export function invokeApplyChanges(
  connectionId: string,
  changes: PendingChange[],
): Promise<ApplyOutcome> {
  return invoke("apply_changes", { connectionId, changes });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test`
Expected: PASS — baseline **+13** (11 new in `pendingChanges.test.ts`, 2 new in `useAppStore.test.ts`) and **+1 file**, i.e. **458 passing / 47 files** if your re-measured baseline was 445/46.

- [ ] **Step 7: Verify the build is clean**

Run: `cd apps/devbench && bun run build`
Expected: no `tsc` errors, no warnings.

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/lib/pendingChanges.ts apps/devbench/src/lib/pendingChanges.test.ts apps/devbench/src/lib/tauri.ts apps/devbench/src/store/useAppStore.ts apps/devbench/src/store/useAppStore.test.ts
git commit -m "feat(devbench): hold staged changes as a diff against the database"
```

---

## Task 3: `DockShell` — one frame, three occupants

**Files:**
- Create: `apps/devbench/src/components/shell/DockShell.tsx`
- Create: `apps/devbench/src/components/shell/DockShell.test.tsx`
- Modify: `apps/devbench/src/components/shell/ChatDock.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DockShell({ label, closeLabel, title, onClose, footer, children })`

This task is a **pure refactor**: `ChatDock`'s rendered output must not change, and all of its existing tests must pass untouched. Spec §1 requires the two new panels to inherit the dock's width, resize handle and `--w-chat` behaviour; extracting the frame is how they inherit it rather than each reimplementing it.

**Why `label` and `closeLabel` are separate props:** `ChatDock`'s existing tests look up `"Resize AI Assistant"` and `"Close chat"`. Those two strings do not share a stem, so one prop cannot produce both without changing an accessible name that tests — and screen-reader users — already rely on.

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/shell/DockShell.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DockShell } from "./DockShell";

describe("DockShell", () => {
  it("names the landmark and its resize handle from the label", () => {
    render(
      <DockShell label="Pending changes" closeLabel="Close pending changes" title="Pending changes" onClose={() => {}}>
        <div>body</div>
      </DockShell>,
    );
    expect(screen.getByRole("complementary", { name: "Pending changes" })).toBeTruthy();
    expect(screen.getByLabelText("Resize Pending changes")).toBeTruthy();
  });

  it("closes through the button its own closeLabel names", () => {
    const onClose = vi.fn();
    render(
      <DockShell label="Insert row" closeLabel="Close insert row" title="Insert row" onClose={onClose}>
        <div>body</div>
      </DockShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close insert row" }));
    expect(onClose).toHaveBeenCalled();
  });

  // A footer is a slot, not a fixture: the Pending panel hides its Apply row
  // entirely when nothing is staged, and the shell must not leave a stray
  // divider behind when it does.
  it("renders no footer element when given none", () => {
    const { container, rerender } = render(
      <DockShell label="Insert row" closeLabel="Close insert row" title="Insert row" onClose={() => {}}>
        <div>body</div>
      </DockShell>,
    );
    expect(container.querySelector("[data-dock-foot]")).toBeNull();

    rerender(
      <DockShell
        label="Insert row"
        closeLabel="Close insert row"
        title="Insert row"
        onClose={() => {}}
        footer={<button type="button">Stage insert</button>}
      >
        <div>body</div>
      </DockShell>,
    );
    expect(screen.getByRole("button", { name: "Stage insert" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test src/components/shell/DockShell.test.tsx`
Expected: FAIL — `Failed to resolve import "./DockShell"`.

- [ ] **Step 3: Write `DockShell`**

Create `apps/devbench/src/components/shell/DockShell.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";

// Matches --w-chat's 20rem token default (tokens.css) at a standard 16px root
// font-size, so the panel doesn't jump on first paint.
const DEFAULT_WIDTH_PX = 320;
const MIN_WIDTH_PX = 260;
const MAX_WIDTH_PX = 640;

/** The right dock's frame, shared by all three occupants (spec §1). Width, the
 *  resize handle and the `--w-chat` custom property live here so chat, pending
 *  and insert cannot drift apart — and so two side panels can never compete
 *  for the same edge. */
export function DockShell({
  label,
  closeLabel,
  title,
  onClose,
  footer,
  children,
}: {
  /** Accessible name for the landmark, and the stem of the resize handle's
   *  name. */
  label: string;
  /** The close button's accessible name in full. Separate from `label`
   *  because "Close chat" is not "Close AI Assistant", and that string is
   *  already what tests and screen readers ask for. */
  closeLabel: string;
  title: ReactNode;
  onClose: () => void;
  /** Rendered below the body with no styling of its own — each occupant
   *  brings its own border and padding, and one that has nothing to act on
   *  passes none at all. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH_PX);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  // AppStrip's topbar sizes its own last grid column from this same `--w-chat`
  // custom property (DESIGN.md's three-column shell) — writing it here, not
  // just an inline style on this element, is what keeps the topbar and the
  // dock in lockstep while dragging.
  useEffect(() => {
    document.documentElement.style.setProperty("--w-chat", `${width}px`);
  }, [width]);

  // No persistence beyond this mount, matching QueryConsole's drag-resize
  // height: reopening the dock (it fully unmounts on close) starts back at
  // DEFAULT_WIDTH_PX. Removing the override here (rather than leaving the last
  // dragged value on the root element) is what makes that true.
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty("--w-chat");
    };
  }, []);

  function onHandleMouseMove(e: MouseEvent) {
    if (!dragState.current) return;
    const dx = dragState.current.startX - e.clientX;
    setWidth(Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, dragState.current.startWidth + dx)));
  }

  function onHandleMouseUp() {
    dragState.current = null;
    window.removeEventListener("mousemove", onHandleMouseMove);
    window.removeEventListener("mouseup", onHandleMouseUp);
  }

  function onHandleMouseDown(e: ReactMouseEvent) {
    dragState.current = { startX: e.clientX, startWidth: width };
    window.addEventListener("mousemove", onHandleMouseMove);
    window.addEventListener("mouseup", onHandleMouseUp);
  }

  return (
    // Ghosty and a flex sibling of the content column — it RESIZES the
    // workspace rather than overlaying it (DESIGN.md).
    <aside aria-label={label} className="relative flex w-(--w-chat) min-w-(--w-chat) border-l border-border">
      {/* Overlays the panel's left edge rather than taking a flex track of its
          own. As a track it pushed the whole content column inward, so the
          header and composer rules started 14px short of the panel edge
          instead of meeting the border like every other divider in the shell. */}
      <div
        onMouseDown={onHandleMouseDown}
        className="absolute inset-y-0 left-0 z-10 flex w-3.5 cursor-col-resize items-center justify-center"
        aria-label={`Resize ${label}`}
        role="separator"
        aria-orientation="vertical"
      >
        <div className="h-9 w-1 rounded-full bg-border" aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center justify-between border-b border-border pl-4 pr-2.5">
          <span className="min-w-0 truncate text-xs font-bold text-text-muted">{title}</span>
          <button
            aria-label={closeLabel}
            onClick={onClose}
            className="shrink-0 rounded-sm px-1.5 text-text-faint hover:bg-surface-2 hover:text-text"
          >
            ✕
          </button>
        </div>
        {children}
        {footer ? <div data-dock-foot>{footer}</div> : null}
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Rewrite `ChatDock` to use it**

In `apps/devbench/src/components/shell/ChatDock.tsx`:

1. Delete `DEFAULT_WIDTH_PX`, `MIN_WIDTH_PX`, `MAX_WIDTH_PX`, the `width` state, `dragState`, both `--w-chat` effects, and all three `onHandle*` functions — `DockShell` owns them now.
2. Drop `useRef` and the `MouseEvent as ReactMouseEvent` type import if nothing else in the file uses them. Leave `useEffect` and `useState` (the provider-status effect and the transcript state still need them).
3. Add `import { DockShell } from "./DockShell";`.
4. Replace the whole returned tree — from `<aside …>` to its closing tag — with:

```tsx
  return (
    <DockShell
      label="AI Assistant"
      closeLabel="Close chat"
      title="AI Assistant"
      onClose={onClose}
      footer={
        <div className="flex gap-2 border-t border-border p-2.5">
          <input
            value={draft}
            disabled={hasKey !== true}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send();
            }}
            placeholder="Ask about this request…"
            className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-xs text-text disabled:opacity-60"
          />
          <button
            aria-label="Send message"
            disabled={hasKey !== true || sending}
            onClick={() => void send()}
            className="rounded-sm bg-accent px-2.5 text-xs font-bold text-accent-on disabled:opacity-60"
          >
            Send
          </button>
        </div>
      }
    >
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {turns.length === 0 ? (
          <div className="text-xs text-text-faint">
            Ask about this session, or anything DevBench observed.
          </div>
        ) : (
          turns.map((turn, i) => (
            <div
              key={i}
              className={`rounded-lg px-2.5 py-2 text-xs ${
                turn.role === "user" ? "bg-surface-2 text-text" : "text-text"
              }`}
            >
              <div className="whitespace-pre-wrap">{turn.content}</div>
              {turn.toolCalls && turn.toolCalls.length > 0 ? (
                <div className="mt-1 text-[11px] text-text-faint">
                  Used {turn.toolCalls.join(", ")}
                </div>
              ) : null}
            </div>
          ))
        )}
        {sending ? <div className="text-xs text-text-faint">Thinking…</div> : null}
        {error ? (
          <div className="rounded-sm bg-danger-bg px-2 py-1 text-[11px] text-danger">{error}</div>
        ) : null}
        {hasKey === false ? (
          <div className="rounded-sm bg-warning-bg px-2 py-1 text-[11px] text-warning">
            Add a provider key in Settings &gt; Provider to use the assistant.
          </div>
        ) : null}
      </div>
    </DockShell>
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test src/components/shell`
Expected: PASS. **`ChatDock.test.tsx` must be unmodified** — its resize, `--w-chat`, cleanup, close and send tests all still pass against the extracted shell. If any of them needed editing, the refactor changed behaviour and is wrong; fix `DockShell`, not the test.

- [ ] **Step 6: Run the whole suite**

Run: `cd apps/devbench && bun run test`
Expected: baseline **+3** and **+1 file**, i.e. **461 passing / 48 files** carrying Task 2's numbers forward.

- [ ] **Step 7: Verify the build is clean**

Run: `cd apps/devbench && bun run build`
Expected: no `tsc` errors, no warnings. If `tsc` reports an unused import in `ChatDock.tsx`, Step 4.2 was skipped.

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/shell/DockShell.tsx apps/devbench/src/components/shell/DockShell.test.tsx apps/devbench/src/components/shell/ChatDock.tsx
git commit -m "refactor(devbench): extract the dock frame so three panels can share it"
```

---

## Task 4: Insert panel (spec §9)

**Files:**
- Create: `apps/devbench/src/components/db/InsertPanel.tsx`
- Create: `apps/devbench/src/components/db/InsertPanel.test.tsx`
- Modify: `apps/devbench/src/components/db/grid/columnMeta.ts`
- Modify: `apps/devbench/src/components/db/grid/columnMeta.test.ts`
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: `ColumnInfo` and `familyOfUdt` from `./grid/columnMeta`, `DockShell` from `../shell/DockShell`, `addPendingInsert` / `setDockPanel` from `useAppStore`
- Produces:
  - `isNumericUdt(udt: string): boolean` (from `columnMeta.ts`)
  - `InsertPanel({ target, onClose })` where `target: InsertTarget`
  - `interface InsertTarget { connectionId: string; table: QualifiedTable; columns: ColumnInfo[] }` and store fields `insertTarget` / `setInsertTarget` (from `useAppStore.ts`)

**Why the panel is handed a target rather than reading the focused tab:** the dock is rendered by `App.tsx`, outside `SplitContent`, so it cannot reach into a `DbTab`'s state. The toolbar's Insert button publishes `{ connectionId, table, columns }` and opens the panel in the same handler. That also settles what happens when the user then switches tables: **the panel keeps describing the table it was opened for**, which is correct, because a staged insert belongs to that table and the pending set spans tables by design (§10). The head shows `Insert row · public.orders`, so the target is never ambiguous.

**Accepted gap, matching the mockup:** a blank field means "let the database decide" (§9), so a blank is omitted from the staged values entirely. There is therefore no way to insert an explicit empty string into a nullable text column that also has a default. A per-field NULL/empty toggle would fix it and is not worth the surface here.

- [ ] **Step 1: Write the failing tests**

Append to `apps/devbench/src/components/db/grid/columnMeta.test.ts`, inside the existing top-level `describe`:

```ts
  // Narrower than the "number" FILTER family, which also covers dates because
  // `>` and `<` answer something for both. An insert field is a real input,
  // and a date in a number input is unusable.
  it("counts only true numerics as numeric, not the dates the number family covers", () => {
    expect(isNumericUdt("int4")).toBe(true);
    expect(isNumericUdt("numeric")).toBe(true);
    expect(isNumericUdt("timestamptz")).toBe(false);
    expect(isNumericUdt("text")).toBe(false);
    expect(familyOfUdt("timestamptz")).toBe("number");
  });
```

Add `isNumericUdt` to that file's existing import from `./columnMeta`.

Create `apps/devbench/src/components/db/InsertPanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { InsertPanel } from "./InsertPanel";
import { useAppStore } from "../../store/useAppStore";
import type { ColumnInfo } from "./grid/columnMeta";

const ORDERS = { schema: "public", name: "orders" };

function column(name: string, over: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    udt: "text",
    nullable: true,
    default_expr: null,
    is_identity: false,
    references: null,
    ...over,
  };
}

function renderPanel(columns: ColumnInfo[]) {
  return render(
    <InsertPanel target={{ connectionId: "c1", table: ORDERS, columns }} onClose={() => {}} />,
  );
}

describe("InsertPanel", () => {
  beforeEach(() => {
    useAppStore.getState().discardAllPending();
  });

  // Spec §9: visible so the shape of the row is honest, but not editable.
  it("renders a database-assigned column read-only and says who assigns it", () => {
    renderPanel([column("id", { is_identity: true, nullable: false })]);
    const field = screen.getByLabelText(/^id/) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(screen.getByText(/assigned by the database/i)).toBeTruthy();
  });

  it("requires a NOT NULL column with no default, and blocks Save until it is filled", () => {
    renderPanel([column("status", { nullable: false })]);
    const save = screen.getByRole("button", { name: /stage insert/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
    expect((screen.getByRole("button", { name: /stage insert/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  // Spec §9: leaving a field blank visibly means "let the database decide".
  it("shows a default expression as the field's placeholder and does not require it", () => {
    renderPanel([column("created_at", { nullable: false, default_expr: "now()", udt: "timestamptz" })]);
    expect((screen.getByLabelText(/^created_at/) as HTMLInputElement).placeholder).toBe("now()");
    expect((screen.getByRole("button", { name: /stage insert/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("picks the input from the column's type", () => {
    renderPanel([
      column("paid", { udt: "bool" }),
      column("amount", { udt: "int4" }),
      column("notes", { udt: "text" }),
    ]);
    expect(screen.getByLabelText(/^paid/).tagName).toBe("SELECT");
    expect((screen.getByLabelText(/^amount/) as HTMLInputElement).type).toBe("number");
    expect((screen.getByLabelText(/^notes/) as HTMLInputElement).type).toBe("text");
  });

  it("stages only the fields that were filled, never the database-assigned ones", () => {
    renderPanel([
      column("id", { is_identity: true, nullable: false }),
      column("status", { nullable: false }),
      column("notes"),
    ]);
    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
    fireEvent.click(screen.getByRole("button", { name: /stage insert/i }));

    expect(useAppStore.getState().pending).toEqual([
      { kind: "insert", table: ORDERS, values: { status: "pending" } },
    ]);
  });

  // Save STAGES. If this ever calls a tauri invoke, the whole model is broken.
  it("shows the staged insert instead of writing it", () => {
    renderPanel([column("status", { nullable: false })]);
    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
    fireEvent.click(screen.getByRole("button", { name: /stage insert/i }));
    expect(useAppStore.getState().dockPanel).toBe("pending");
  });
});
```

Append to `apps/devbench/src/components/db/DbTab.test.tsx`, inside the existing `describe("DbTab", …)`:

```tsx
  it("opens the insert panel on the table whose toolbar was used", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([
      { name: "id", udt: "int4", nullable: false, default_expr: null, is_identity: true, references: null },
      { name: "status", udt: "text", nullable: false, default_expr: null, is_identity: false, references: null },
    ]);

    renderDb(ORDERS);
    await screen.findByRole("button", { name: "Insert" });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(useAppStore.getState().dockPanel).toBe("insert");
    expect(useAppStore.getState().insertTarget?.table).toEqual(ORDERS);
    // The panel builds its fields from these, so an empty list here would be a
    // silently blank form rather than a visible failure.
    expect(useAppStore.getState().insertTarget?.columns.map((c) => c.name)).toEqual(["id", "status"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test src/components/db/InsertPanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./InsertPanel"`.

- [ ] **Step 3: Add `isNumericUdt`**

In `apps/devbench/src/components/db/grid/columnMeta.ts`, beside `ORDERED_UDTS`:

```ts
const NUMERIC_UDTS = new Set(["int2", "int4", "int8", "float4", "float8", "numeric", "money"]);

/** Narrower than the `"number"` filter family, which also covers dates because
 *  `>` and `<` answer something for both. This one drives a real `<input
 *  type="number">` in the insert panel, where a date would be unusable. */
export function isNumericUdt(udt: string): boolean {
  return NUMERIC_UDTS.has(udt);
}
```

- [ ] **Step 4: Add the insert target to the store**

In `apps/devbench/src/store/useAppStore.ts`, add the import:

```ts
import type { ColumnInfo } from "../components/db/grid/columnMeta";
```

Add beside `DockPanel`:

```ts
/** What the Insert panel builds its form from. Published by the toolbar button
 *  that opens the panel, because the dock renders outside `SplitContent` and
 *  cannot reach into a tab's state. Switching tables afterwards does NOT
 *  retarget an open panel: a staged insert belongs to the table it was written
 *  for, and the panel's head names it. */
export interface InsertTarget {
  connectionId: string;
  table: QualifiedTable;
  columns: ColumnInfo[];
}
```

Add to the `AppState` interface, beside `dockPanel`:

```ts
  insertTarget: InsertTarget | null;
  setInsertTarget: (target: InsertTarget | null) => void;
```

Add to the store body, beside `dockPanel: "chat"`:

```ts
  insertTarget: null,
  setInsertTarget: (insertTarget) => set({ insertTarget }),
```

- [ ] **Step 5: Write the panel**

Create `apps/devbench/src/components/db/InsertPanel.tsx`:

```tsx
import { useState } from "react";
import { DockShell } from "../shell/DockShell";
import { SecondaryButton } from "../ui/SecondaryButton";
import { familyOfUdt, isNumericUdt, type ColumnInfo } from "./grid/columnMeta";
import { useAppStore, type InsertTarget } from "../../store/useAppStore";
import { tableKey } from "../../lib/tableIdentity";

/** Spec §9: the database assigns identity, generated and serial columns, so
 *  they are shown (the row's shape should be honest) but never typed into. */
function isAssigned(column: ColumnInfo): boolean {
  return column.is_identity;
}

/** Required means "the database will reject the row without it": NOT NULL, no
 *  default, and not something the database fills in itself. */
function isRequired(column: ColumnInfo): boolean {
  return !isAssigned(column) && !column.nullable && column.default_expr === null;
}

export function InsertPanel({ target, onClose }: { target: InsertTarget; onClose: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const addPendingInsert = useAppStore((s) => s.addPendingInsert);
  const setDockPanel = useAppStore((s) => s.setDockPanel);

  const editable = target.columns.filter((c) => !isAssigned(c));
  const missing = editable.some((c) => isRequired(c) && !(draft[c.name] ?? "").trim());

  function stage() {
    if (missing) return;
    // A blank field is omitted rather than sent as NULL: spec §9 makes blank
    // mean "let the database decide", and an omitted column is exactly that —
    // it takes its default, or NULL when it has none. Sending NULL explicitly
    // would instead override a default the user chose not to touch.
    const values: Record<string, string | null> = {};
    for (const column of editable) {
      const typed = (draft[column.name] ?? "").trim();
      if (typed !== "") values[column.name] = typed;
    }
    addPendingInsert(target.table, values);
    // Straight to Pending rather than closing: the whole point of Save is that
    // it did NOT write, and showing the entry it produced is what makes that
    // legible instead of looking like nothing happened.
    setDockPanel("pending");
  }

  return (
    <DockShell
      label="Insert row"
      closeLabel="Close insert row"
      title={`Insert row · ${tableKey(target.table)}`}
      onClose={onClose}
      footer={
        // Spec §14: the ROW sets 30px (h-7.5) for both its secondary and its
        // primary, which is what stops the pair drifting apart. SecondaryButton
        // deliberately carries no height of its own for exactly this reason.
        <div className="flex gap-2 border-t border-border px-3 py-2.5">
          <SecondaryButton className="h-7.5" onClick={onClose}>
            Cancel
          </SecondaryButton>
          <button
            type="button"
            disabled={missing}
            onClick={stage}
            className="h-7.5 flex-1 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on hover:bg-accent-strong disabled:opacity-40"
          >
            Stage insert
          </button>
        </div>
      }
    >
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {target.columns.map((column) => {
          const assigned = isAssigned(column);
          const required = isRequired(column);
          // The label carries the column name plus its annotations, and the
          // control is named by it — so a screen reader (and a test) reads
          // "status * text" rather than an anonymous textbox.
          const label = (
            <span className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-text-faint">
              {column.name}
              {required ? <span className="text-danger">*</span> : null}
              <span className="font-medium normal-case tracking-normal text-text-faint">
                {assigned ? "— assigned by the database" : column.udt}
              </span>
            </span>
          );

          const fieldClass =
            "rounded-sm border border-border bg-bg px-2 py-1.5 font-mono text-xs text-text read-only:cursor-not-allowed read-only:bg-surface-2 read-only:text-text-faint";

          return (
            <label key={column.name} className="flex flex-col gap-1">
              {label}
              {assigned ? (
                <input readOnly value="" placeholder="auto" className={fieldClass} />
              ) : familyOfUdt(column.udt) === "boolean" ? (
                <select
                  value={draft[column.name] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [column.name]: e.target.value })}
                  className={fieldClass}
                >
                  <option value="">{column.default_expr ?? "NULL"} (default)</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  type={isNumericUdt(column.udt) ? "number" : "text"}
                  value={draft[column.name] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [column.name]: e.target.value })}
                  placeholder={column.default_expr ?? (column.nullable ? "NULL" : "")}
                  className={fieldClass}
                />
              )}
            </label>
          );
        })}
        <div className="text-xs text-text-faint">
          Blank means the database decides — defaults are shown as placeholders. Saving stages the
          insert; nothing is written until you Apply.
        </div>
      </div>
    </DockShell>
  );
}
```

- [ ] **Step 6: Render it in the dock**

In `apps/devbench/src/App.tsx`, read the new state beside the existing `chatOpen`:

```tsx
  const dockPanel = useAppStore((s) => s.dockPanel);
  const setDockPanel = useAppStore((s) => s.setDockPanel);
  const insertTarget = useAppStore((s) => s.insertTarget);
```

Replace the dock line:

```tsx
        {chatOpen ? <ChatDock onClose={() => setChatOpen(false)} /> : null}
```

with:

```tsx
        {/* One slot, three occupants (spec §1). Closing a panel returns to
            chat; only closing chat itself closes the dock. An insert panel
            with no target can't render a form, so it falls back rather than
            showing an empty one. */}
        {chatOpen ? (
          dockPanel === "insert" && insertTarget ? (
            <InsertPanel target={insertTarget} onClose={() => setDockPanel("chat")} />
          ) : (
            <ChatDock onClose={() => setChatOpen(false)} />
          )
        ) : null}
```

Add `import { InsertPanel } from "./components/db/InsertPanel";`.

- [ ] **Step 7: Wire the toolbar button**

In `apps/devbench/src/components/db/DbTab.tsx`, read the actions near the other store selectors at the top of the component:

```tsx
  const setDockPanel = useAppStore((s) => s.setDockPanel);
  const setInsertTarget = useAppStore((s) => s.setInsertTarget);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
```

Add to the `<GridToolbar …>` props, beside `onRefresh`:

```tsx
                        onInsert={() => {
                          if (!table || !activeConnectionId) return;
                          setInsertTarget({ connectionId: activeConnectionId, table, columns: columnMeta });
                          setDockPanel("insert");
                          // The dock has to be open for the panel to be seen
                          // at all — opening the panel into a closed dock
                          // would read as the button doing nothing.
                          setChatOpen(true);
                        }}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test`
Expected: PASS — **+8** (1 in `columnMeta.test.ts`, 6 in `InsertPanel.test.tsx`, 1 in `DbTab.test.tsx`) and **+1 file**, i.e. **469 passing / 49 files** carrying Task 3's numbers forward.

- [ ] **Step 9: Verify the build is clean**

Run: `cd apps/devbench && bun run build`
Expected: no `tsc` errors, no warnings.

- [ ] **Step 10: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/InsertPanel.tsx apps/devbench/src/components/db/InsertPanel.test.tsx apps/devbench/src/components/db/grid/columnMeta.ts apps/devbench/src/components/db/grid/columnMeta.test.ts apps/devbench/src/store/useAppStore.ts apps/devbench/src/App.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): generate an insert form from column metadata"
```

---

## Task 5: Pending changes panel and Apply (spec §10)

**Files:**
- Create: `apps/devbench/src/components/db/PendingPanel.tsx`
- Create: `apps/devbench/src/components/db/PendingPanel.test.tsx`
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: `groupByTable`, `PendingChange`, `ConflictReport` from `../../lib/pendingChanges`; `invokeApplyChanges` from `../../lib/tauri`; `DockShell`, `SecondaryButton`; store `pending` / `discardPendingAt` / `discardAllPending` / `setDockPanel`
- Produces: `PendingPanel({ connectionId, onClose, onApplied })`

**`onApplied` exists because the panel cannot refetch the grid.** The panel lives in the app-level dock; the rows live in a `DbTab`. After a successful Apply the grid is stale — it still shows pre-Apply values, and the staged overlay it was drawing has just been cleared, so without a refetch every applied cell would visibly snap *back*. `DbTab` subscribes to the pending set and refetches when it empties; `onApplied` is the panel's half of that contract and is documented at both ends.

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/db/PendingPanel.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PendingPanel } from "./PendingPanel";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";
import type { PendingChange } from "../../lib/pendingChanges";

const ORDERS = { schema: "public", name: "orders" };
const USERS = { schema: "public", name: "users" };

const UPDATE: PendingChange = {
  kind: "update", table: ORDERS, pk_column: "id", pk_value: "1",
  column: "status", old_value: "pending", new_value: "shipped",
};
const DELETE: PendingChange = { kind: "delete", table: USERS, pk_column: "id", pk_value: "9" };

function seed(pending: PendingChange[]) {
  useAppStore.setState({ pending });
}

function renderPanel(onApplied = vi.fn()) {
  return { onApplied, ...render(<PendingPanel connectionId="c1" onClose={() => {}} onApplied={onApplied} />) };
}

describe("PendingPanel", () => {
  beforeEach(() => {
    useAppStore.getState().discardAllPending();
  });

  it("says nothing is staged, and offers no Apply, when the set is empty", () => {
    renderPanel();
    expect(screen.getByText(/nothing staged/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^apply/i })).toBeNull();
  });

  it("groups entries by table and labels each entry's kind", () => {
    seed([UPDATE, DELETE]);
    renderPanel();
    expect(screen.getByText("public.orders")).toBeTruthy();
    expect(screen.getByText("public.users")).toBeTruthy();
    expect(screen.getByText("update")).toBeTruthy();
    expect(screen.getByText("delete")).toBeTruthy();
  });

  it("shows an update as old then new, so the diff is readable without the grid", () => {
    seed([UPDATE]);
    renderPanel();
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("shipped")).toBeTruthy();
    expect(screen.getByText("id = 1")).toBeTruthy();
  });

  it("counts the whole set on the Apply button", () => {
    seed([UPDATE, DELETE]);
    renderPanel();
    expect(screen.getByRole("button", { name: "Apply 2" })).toBeTruthy();
  });

  it("discards one entry by its position in the whole set", () => {
    seed([UPDATE, DELETE]);
    renderPanel();
    fireEvent.click(screen.getAllByRole("button", { name: /^discard this/i })[0]);
    expect(useAppStore.getState().pending).toEqual([DELETE]);
  });

  it("discards everything at once", () => {
    seed([UPDATE, DELETE]);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    expect(useAppStore.getState().pending).toEqual([]);
  });

  it("sends the whole ordered set in one call and clears it on success", async () => {
    seed([UPDATE, DELETE]);
    const apply = vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({ applied: 2, conflict: null });
    const { onApplied } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 2" }));

    await waitFor(() => expect(apply).toHaveBeenCalledWith("c1", [UPDATE, DELETE]));
    await waitFor(() => expect(useAppStore.getState().pending).toEqual([]));
    expect(onApplied).toHaveBeenCalled();
  });

  // Spec §10: a conflict rolls the transaction back whole. The set must
  // SURVIVE, or the user loses work to a failure that wrote nothing.
  it("keeps the set and reports what it expected versus what it found on a conflict", async () => {
    seed([UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({
      applied: 0,
      conflict: {
        index: 0, table: "public.orders", description: "id = 1", column: "status",
        expected: "pending", found: "cancelled", row_missing: false,
      },
    });
    const { onApplied } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("cancelled");
    expect(useAppStore.getState().pending).toEqual([UPDATE]);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("says the row is gone rather than reporting a NULL it did not find", async () => {
    seed([DELETE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({
      applied: 0,
      conflict: {
        index: 0, table: "public.users", description: "id = 9", column: null,
        expected: null, found: null, row_missing: true,
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toMatch(/no longer exists|already gone|no row/i);
  });

  it("keeps the set when the call itself fails", async () => {
    seed([UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockRejectedValue(new Error("connection refused"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
    expect(useAppStore.getState().pending).toEqual([UPDATE]);
  });
});
```

Append to `apps/devbench/src/components/db/DbTab.test.tsx`, inside the existing `describe("DbTab", …)`:

```tsx
  it("shows the Pending button only once something is staged, and opens the panel", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
    });
    useAppStore.getState().discardAllPending();

    renderDb(ORDERS);
    await screen.findByRole("grid");
    // Hidden entirely when empty: it must never advertise a state that does
    // not exist (spec §3).
    expect(screen.queryByRole("button", { name: /^pending/i })).toBeNull();

    act(() => {
      useAppStore.getState().stagePendingUpdate({
        kind: "update", table: ORDERS, pk_column: "id", pk_value: "1",
        column: "status", old_value: "pending", new_value: "shipped",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Pending 1" }));
    expect(useAppStore.getState().dockPanel).toBe("pending");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test src/components/db/PendingPanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./PendingPanel"`.

- [ ] **Step 3: Write the panel**

Create `apps/devbench/src/components/db/PendingPanel.tsx`:

```tsx
import { useState } from "react";
import { DockShell } from "../shell/DockShell";
import { SecondaryButton } from "../ui/SecondaryButton";
import { useAppStore } from "../../store/useAppStore";
import { groupByTable, type ConflictReport, type PendingChange } from "../../lib/pendingChanges";
import { invokeApplyChanges } from "../../lib/tauri";

/** Spec §10: the panel colour-codes the kind. This is semantic colour used for
 *  what it is reserved for — real state — not decoration: update is provisional
 *  (`--warning`), insert creates (`--success`), delete destroys (`--danger`),
 *  and a raw statement makes no such claim, so it stays neutral. */
const KIND_CLASS: Record<PendingChange["kind"], string> = {
  update: "text-warning",
  insert: "text-success",
  delete: "text-danger",
  sql: "text-text-muted",
};

/** The row this entry targets, for the entry's header line. */
function describeTarget(entry: PendingChange): string {
  if (entry.kind === "update" || entry.kind === "delete") {
    return `${entry.pk_column} = ${entry.pk_value}`;
  }
  return "";
}

function DisplayValue({ value }: { value: string | null }) {
  return value === null ? <span className="italic">NULL</span> : <>{value}</>;
}

function EntryBody({ entry }: { entry: PendingChange }) {
  if (entry.kind === "update") {
    return (
      <>
        <span className="text-text-faint">{entry.column}</span>
        <span className="text-danger line-through">
          <DisplayValue value={entry.old_value} />
        </span>
        <span aria-hidden className="text-text-faint">
          →
        </span>
        <span className="font-semibold text-success">
          <DisplayValue value={entry.new_value} />
        </span>
      </>
    );
  }
  if (entry.kind === "insert") {
    return (
      <>
        {Object.entries(entry.values).map(([column, value]) => (
          <span key={column} className="flex items-center gap-1.5">
            <span className="text-text-faint">{column}</span>
            <span className="font-semibold text-success">
              <DisplayValue value={value} />
            </span>
          </span>
        ))}
      </>
    );
  }
  if (entry.kind === "delete") {
    return <span className="text-danger line-through">{describeTarget(entry)}</span>;
  }
  // A staged statement is re-run at Apply, so the effect the run reported
  // travels with it — a divergence should be visible, not silent (spec §12).
  return (
    <>
      <span className="whitespace-pre-wrap">{entry.statement}</span>
      <span className="text-text-faint">· {entry.previewed_effect} when run</span>
    </>
  );
}

/** Spec §10: reported honestly rather than silently overwriting. The wording
 *  separates the two facts a failed guard can carry — the row moved, or the
 *  row is gone — because "expected pending, found nothing" would describe a
 *  deleted row as a NULL. */
function conflictMessage(conflict: ConflictReport): string {
  const where = `${conflict.table} ${conflict.description}`;
  if (conflict.row_missing) {
    return `Nothing was written. ${where} no longer exists — someone deleted it after this change was staged.`;
  }
  const expected = conflict.expected ?? "NULL";
  const found = conflict.found ?? "NULL";
  return `Nothing was written. ${where} was staged against ${conflict.column} = ${expected}, but it now holds ${found}.`;
}

export function PendingPanel({
  connectionId,
  onClose,
  onApplied,
}: {
  connectionId: string | null;
  onClose: () => void;
  /** Called only after a commit that actually wrote. The grid lives in a
   *  DbTab, out of this panel's reach, and its rows are stale the moment Apply
   *  succeeds — without a refetch every applied cell would visibly snap back
   *  to its pre-Apply value as the staged overlay clears. */
  onApplied: () => void;
}) {
  const pending = useAppStore((s) => s.pending);
  const discardPendingAt = useAppStore((s) => s.discardPendingAt);
  const discardAllPending = useAppStore((s) => s.discardAllPending);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function apply() {
    if (!connectionId || applying || pending.length === 0) return;
    setApplying(true);
    setProblem(null);
    try {
      const outcome = await invokeApplyChanges(connectionId, pending);
      if (outcome.conflict) {
        // The transaction rolled back whole, so the set is still exactly what
        // the user staged. Clearing it here would cost them their work over a
        // failure that wrote nothing.
        setProblem(conflictMessage(outcome.conflict));
        return;
      }
      discardAllPending();
      onApplied();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  const groups = groupByTable(pending);

  return (
    <DockShell
      label="Pending changes"
      closeLabel="Close pending changes"
      title="Pending changes"
      onClose={onClose}
      footer={
        pending.length > 0 ? (
          // Spec §14: the ROW sets 30px (h-7.5) for both buttons.
          <div className="flex gap-2 border-t border-border px-3 py-2.5">
            <SecondaryButton className="h-7.5" disabled={applying} onClick={discardAllPending}>
              Discard all
            </SecondaryButton>
            <button
              type="button"
              disabled={applying || !connectionId}
              onClick={() => void apply()}
              className="h-7.5 flex-1 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on hover:bg-accent-strong disabled:opacity-40"
            >
              {applying ? "Applying…" : `Apply ${pending.length}`}
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {problem ? (
          <div role="alert" className="rounded-sm border border-border bg-danger-bg px-2.5 py-1.5 text-xs text-danger">
            {problem}
          </div>
        ) : null}

        {pending.length === 0 ? (
          <div className="text-xs text-text-faint">
            Nothing staged. Editing a cell, inserting a row or deleting a row collects here — then
            Apply commits them together in one transaction.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-1.5">
              <div className="text-[10.5px] font-bold uppercase tracking-wide text-text-faint">
                {group.label}
              </div>
              {group.entries.map(({ entry, index }) => (
                <div key={index} className="rounded-sm border border-border bg-surface px-2.5 py-2">
                  <div className="mb-1.25 flex items-center gap-1.5 font-mono text-[10.5px] text-text-faint">
                    <span className={`font-bold uppercase tracking-wide ${KIND_CLASS[entry.kind]}`}>
                      {entry.kind}
                    </span>
                    <span>{describeTarget(entry)}</span>
                    <button
                      type="button"
                      // Named by what it drops, not "Discard": several of
                      // these are on screen at once, and identical accessible
                      // names would make them indistinguishable.
                      aria-label={`Discard this ${entry.kind}`}
                      disabled={applying}
                      onClick={() => discardPendingAt(index)}
                      className="ml-auto rounded-sm px-1 text-text-faint hover:bg-danger-bg hover:text-danger disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-text-muted">
                    <EntryBody entry={entry} />
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </DockShell>
  );
}
```

- [ ] **Step 4: Render it in the dock**

In `apps/devbench/src/App.tsx`, extend the dock switch from Task 4:

```tsx
        {chatOpen ? (
          dockPanel === "insert" && insertTarget ? (
            <InsertPanel target={insertTarget} onClose={() => setDockPanel("chat")} />
          ) : dockPanel === "pending" ? (
            <PendingPanel
              connectionId={activeConnectionId}
              onClose={() => setDockPanel("chat")}
              // DbTab watches the pending set and refetches when it empties
              // after an Apply, so nothing more is needed here.
              onApplied={() => {}}
            />
          ) : (
            <ChatDock onClose={() => setChatOpen(false)} />
          )
        ) : null}
```

Add `import { PendingPanel } from "./components/db/PendingPanel";` and read `activeConnectionId`:

```tsx
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
```

- [ ] **Step 5: Add the Pending button to the pane strip**

Spec §3: it lives in the pane strip, not the grid toolbar, and is **hidden entirely when the set is empty**.

In `apps/devbench/src/components/db/DbTab.tsx`, read the set near the other store selectors:

```tsx
  const pending = useAppStore((s) => s.pending);
```

In the pane strip (the `h-11` row that holds the table name and the Query console toggle), insert the button **before** the Query console button and move `ml-auto` onto it so the pair still sits right:

```tsx
            {pending.length > 0 ? (
              <SecondaryButton
                className="ml-auto h-7 gap-1.5"
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
```

The Query console button's own class currently starts with `ml-auto`. Change it to `ml-2` when the Pending button is present — simplest correct form is to make the console button's margin conditional:

```tsx
              className={`${pending.length > 0 ? "ml-2" : "ml-auto"} flex h-7.5 shrink-0 items-center gap-1.5 rounded-sm px-2.25 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text aria-pressed:bg-surface-2 aria-pressed:text-text`}
```

Add `import { SecondaryButton } from "../ui/SecondaryButton";` and read `dockPanel`:

```tsx
  const dockPanel = useAppStore((s) => s.dockPanel);
```

The accessible name of that button is `"Pending 1"` (its two spans' text joined), which is what the DbTab test asks for.

- [ ] **Step 6: Refetch when Apply empties the set**

Still in `DbTab.tsx`, add after the column-metadata effect. This is the other half of `onApplied`'s contract:

```tsx
  // Apply commits in the dock, which cannot reach this grid. When the set goes
  // from non-empty to empty by anything other than Discard, the rows on screen
  // are stale AND their staged overlay has just been cleared — so an applied
  // cell would visibly snap back to its pre-Apply value. Refetching is what
  // makes the grid agree with the database again.
  //
  // Discard all also empties the set, and also needs this: the staged overlay
  // disappearing is exactly the same repaint, and a refetch of unchanged rows
  // is cheap and always correct.
  const hadPendingRef = useRef(pending.length > 0);
  useEffect(() => {
    const had = hadPendingRef.current;
    hadPendingRef.current = pending.length > 0;
    if (!had || pending.length > 0) return;
    if (!table || !activeConnectionId) return;
    void fetchRows(table, activeConnectionId, filter, sort, page, limitRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test`
Expected: PASS — **+11** (10 in `PendingPanel.test.tsx`, 1 in `DbTab.test.tsx`) and **+1 file**, i.e. **480 passing / 50 files** carrying Task 4's numbers forward.

- [ ] **Step 8: Verify the build is clean**

Run: `cd apps/devbench && bun run build`
Expected: no `tsc` errors, no warnings.

- [ ] **Step 9: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/PendingPanel.tsx apps/devbench/src/components/db/PendingPanel.test.tsx apps/devbench/src/App.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): review and apply the staged set from the dock"
```

---

## Task 6: Cell edits stage instead of previewing — retiring the single-preview machinery (spec §15)

**Files:**
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: `stagedUpdateFor` from `../../lib/pendingChanges`; store `pending` / `stagePendingUpdate`
- Produces: no new exports. `CellEdit` narrows to `{ rowIndex: number; columnIndex: number; draft: string | null }`.

**This is the task the slice exists for.** Spec §15: `editGenerationRef`, the in-flight button disabling, rollback-on-arrival and the preview sweep exist solely to protect one live transaction. Staged intent holds none, so they go — and §18 requires that removal be *reasoned about*, not merely performed. The reasoning, to be re-checked in review:

> The bug those guards fixed was a **committed write reported as failed, and a leaked transaction**. Both were possible only because a preview opened a real transaction that outlived the UI that owned it. After this task, clicking ✓ mutates local state and returns synchronously — there is no request, no transaction, no id, and therefore no window in which a response can land against a component that has moved on. The failure mode is not merely unguarded; it is unreachable. The one remaining round trip is Apply, which is a single call the panel awaits and whose outcome it reports in full (Task 5).

**This task DELETES 9 existing tests and rewrites 2.** That is intended: they assert the behaviour of machinery that no longer exists. Net vitest delta for this task is **-5**. Do not "keep them passing" by preserving the machinery.

**Also fixes a live stacking bug found while planning this task.** `DataGrid` raises a row only for `fkCell` (`raisedRowIndex={fkCell?.rowIndex ?? null}`). The expanded cell editor is `z-20` *inside* a virtualized row, and every row carries a `transform`, which creates a stacking context — so the editor is sealed inside its own row and a later row paints over it, exactly the bug Slice 2 fixed for the FK popover and never fixed here. Raising the editing row too is the fix; Task 10 measures it with `document.elementFromPoint`.

- [ ] **Step 1: Delete the tests for the retired machinery**

In `apps/devbench/src/components/db/DbTab.test.tsx`, inside `describe("inline cell editing", …)`, delete these outright:

- `"rolling back an edit discards the draft and calls rollback_preview"`
- `"switching tables while a preview is open rolls back the abandoned preview instead of leaking it"`
- `"a failed preview reports the failure and keeps the draft editable rather than discarding it"`
- `"a failed commit reports the failure, does not apply the edit, and leaves the grid visible"`
- the entire nested `describe("interacting while a preview/commit request is still in flight", …)` block and all 5 tests inside it

**Keep** `"cells are not clickable to edit when the table has no single-column primary key"` and `"cells showing <unsupported type> are not editable even when the table has a primary key"` — those rules survive unchanged.

**Do not touch** `describe("query console", …)`. Its `"closing the console with an open, uncommitted preview rolls it back"` test uses `invokePreviewQuery`, which stays (spec §12, §15).

- [ ] **Step 2: Write the replacement tests**

Replace `"clicking an editable cell shows an input; previewing shows a diff; committing updates the grid"` and `"editing a NULL cell previews null rather than an empty string when the draft is untouched"` with the following, and add the four new ones, all inside `describe("inline cell editing", …)`:

```tsx
    it("clicking an editable cell shows an input; accepting stages the change without writing it", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      // If this is ever called, the write model has regressed to the retired one.
      const previewCell = vi.spyOn(tauriLib, "invokePreviewCellEdit");
      useAppStore.getState().discardAllPending();

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("pending"));

      const input = await screen.findByLabelText("Edit status");
      fireEvent.change(input, { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));

      expect(useAppStore.getState().pending).toEqual([
        {
          kind: "update", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "status", old_value: "pending", new_value: "shipped",
        },
      ]);
      expect(previewCell).not.toHaveBeenCalled();
    });

    // Spec §10: required, not decorative. A cell that snapped back to its
    // stored value would look like the click did nothing.
    it("renders a staged cell's pending value, marked as staged", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      useAppStore.getState().discardAllPending();

      renderDb(ORDERS);
      await screen.findByText("pending");

      act(() => {
        useAppStore.getState().stagePendingUpdate({
          kind: "update", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "status", old_value: "pending", new_value: "shipped",
        });
      });

      expect(await screen.findByText("shipped")).toBeTruthy();
      expect(screen.queryByText("pending")).toBeNull();
      expect(document.querySelector('[data-staged="true"]')).toBeTruthy();
    });

    // NULL and "" are different values on the wire, and an untouched draft of
    // a NULL cell means "still NULL", not "now the empty string".
    it("stages null rather than an empty string when a NULL cell's draft is untouched", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", null]], pk_column: "id",
      });
      useAppStore.getState().discardAllPending();

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("NULL"));
      await screen.findByLabelText("Edit status");
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));

      // Untouched draft: the value never differs from stored, so the diff
      // model correctly records nothing at all.
      expect(useAppStore.getState().pending).toEqual([]);
    });

    it("stages a real value over a NULL cell", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", null]], pk_column: "id",
      });
      useAppStore.getState().discardAllPending();

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("NULL"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));

      expect(useAppStore.getState().pending).toEqual([
        {
          kind: "update", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "status", old_value: null, new_value: "shipped",
        },
      ]);
    });

    it("cancelling an edit discards the draft and stages nothing", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      useAppStore.getState().discardAllPending();

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("pending"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));

      expect(useAppStore.getState().pending).toEqual([]);
      expect(screen.queryByLabelText("Edit status")).toBeNull();
      expect(screen.getByText("pending")).toBeTruthy();
    });

    // Spec §16, the text half of "staging a cell twice back to its stored
    // value leaves no pending change".
    it("typing a cell back to its stored value clears the pending change", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      useAppStore.getState().discardAllPending();

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("pending"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));
      expect(useAppStore.getState().pending).toHaveLength(1);

      // The staged value is what the cell now shows, so that is what gets clicked.
      fireEvent.click(await screen.findByText("shipped"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "pending" } });
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));

      expect(useAppStore.getState().pending).toEqual([]);
    });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test src/components/db/DbTab.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "button" and name "Stage change"`.

- [ ] **Step 4: Delete the preview machinery from `DbTab.tsx`**

Remove all of the following outright:

1. The `CellEdit` union's `"preview"` variant and its `pending` flag. It becomes:

```tsx
// A cell being edited. No phase and no in-flight flag: accepting an edit
// mutates local state and returns — there is no request to be in flight, and
// no transaction whose fate a response has to decide.
type CellEdit = { rowIndex: number; columnIndex: number; draft: string | null };
```

2. `isExpiredPreviewError` — its only caller is going.
3. `editGenerationRef` and its long comment block.
4. `editingRef` and the `useEffect` that syncs it.
5. `abandonEdit`.
6. The unmount effect `useEffect(() => () => abandonEdit(editingRef.current), [])`.
7. `previewEdit`, `commitEdit`, `rollbackEdit` in full.
8. `anyEditPending` in `renderCell`.
9. The `invokePreviewCellEdit`, `invokeCommitPreview` and `invokeRollbackPreview` imports **from `DbTab.tsx` only** — `QueryConsole.tsx` still imports all three and must not be touched.

Replace the two `abandonEdit(...)` calls in the table-switch effect and in `abandonEditForQueryChange` with plain state clearing:

```tsx
  // A query-shape change (sort, filter, page, limit, refresh) or a table switch
  // drops an open editor: its rowIndex and columnIndex are about to describe
  // different data. The PENDING SET is deliberately untouched — it is global by
  // design (spec §10) and keyed by primary key, not by row position, so it
  // survives every one of these.
  function abandonEditForQueryChange() {
    setEditing(null);
    setEditError(null);
    closeFk();
  }
```

In the table-switch effect, replace `abandonEdit(editingRef.current); setEditing(null); setEditError(null);` with `setEditing(null); setEditError(null);`.

- [ ] **Step 5: Stage instead of preview**

Add near the other handlers in `DbTab.tsx`:

```tsx
  const pending = useAppStore((s) => s.pending);
  const stagePendingUpdate = useAppStore((s) => s.stagePendingUpdate);

  /** The row's primary key value, or null when there is nothing safe to key a
   *  change by. Read from the CURRENT rows, so it is the stored value even
   *  when the cell beside it is showing a staged one. */
  function pkValueForRow(rowIndex: number): string | null {
    if (!tableRows?.pk_column) return null;
    const pkIndex = tableRows.columns.indexOf(tableRows.pk_column);
    return tableRows.rows[rowIndex]?.[pkIndex] ?? null;
  }

  function stageCell(rowIndex: number, columnIndex: number, next: string | null) {
    if (!table || !tableRows?.pk_column) return;
    const pkValue = pkValueForRow(rowIndex);
    if (pkValue === null) {
      setEditError("Can't stage a change to this row — its primary key value is NULL.");
      return;
    }
    setEditError(null);
    stagePendingUpdate({
      kind: "update",
      table,
      pk_column: tableRows.pk_column,
      pk_value: pkValue,
      column: tableRows.columns[columnIndex],
      // ALWAYS the stored value from `tableRows`, never the staged one. See
      // pendingChanges.ts: this is what makes the set a diff rather than a log,
      // and what the backend's IS NOT DISTINCT FROM guard compares against.
      old_value: tableRows.rows[rowIndex][columnIndex] ?? null,
      new_value: next,
    });
  }
```

- [ ] **Step 6: Rewrite `renderCell`**

Replace the preview branch and the editing branch, and wrap the result so a staged cell carries its marker:

```tsx
  function renderCell(rowIndex: number, columnIndex: number, value: string | null) {
    const column = tableRows?.columns[columnIndex] ?? "";
    const editable = isEditableCell(tableRows?.pk_column ?? null, column, value);
    const isEditingThisCell =
      editing !== null && editing.rowIndex === rowIndex && editing.columnIndex === columnIndex;

    const pkValue = pkValueForRow(rowIndex);
    const staged =
      table && pkValue !== null
        ? stagedUpdateFor(pending, table, pkValue, column)
        : ({ staged: false } as const);
    // The staged value is what the cell shows and what an edit of it starts
    // from — spec §10 requires it, and a checkbox that snapped back to its
    // stored value would look like the click did nothing.
    const shown = staged.staged ? staged.value : value;

    if (isEditingThisCell) {
      const stage = () => {
        stageCell(rowIndex, columnIndex, editing.draft);
        setEditing(null);
      };
      return (
        <div className={expandedEditorClass}>
          <input
            autoFocus
            aria-label={`Edit ${column}`}
            size={Math.min(Math.max((editing.draft ?? "").length + 1, 12), 60)}
            value={editing.draft ?? ""}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") stage();
              if (e.key === "Escape") setEditing(null);
            }}
            className="min-w-0 rounded border border-accent bg-bg px-1.5 py-0.75 text-xs text-text"
          />
          {/* "Stage change", not "Preview": it writes nothing, and calling it
              a preview would overstate what the button does in the other
              direction from the retired one, which understated it. */}
          <button
            type="button"
            aria-label="Stage change"
            onClick={stage}
            className={acceptButtonClass}
          >
            <CheckIcon />
          </button>
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={() => setEditing(null)}
            className={actionButtonClass}
          >
            <CrossIcon />
          </button>
        </div>
      );
    }

    const { className, kind } = cellDisplay(shown);
    const alignClass = kind === "number" && column === tableRows?.pk_column ? "" : className;

    const target = fkTargetOf(columnMeta, column);
    const followable = target !== null && canFollow(columnMeta, column, shown);
    const fkOpen =
      fkCell !== null && fkCell.rowIndex === rowIndex && fkCell.columnIndex === columnIndex;

    const valueButton = (
      <button
        type="button"
        disabled={!editable}
        title={staged.staged ? "Staged — not written until you Apply" : undefined}
        onClick={() => editable && startEdit(rowIndex, columnIndex, shown)}
        className={`group flex min-w-0 items-center gap-1 text-left ${
          followable ? "flex-1" : "w-full"
        } ${editable ? "hover:cursor-text hover:bg-surface-2" : ""}`}
      >
        <span className={`min-w-0 flex-1 truncate ${alignClass}`}>
          <CellValue value={shown} />
        </span>
        {editable ? (
          <span aria-hidden className="hidden shrink-0 text-[10.5px] text-text-faint group-hover:inline">
            ✎
          </span>
        ) : null}
      </button>
    );

    // Spec §10: an inset --warning left bar. Semantic colour for real state —
    // "changed but not written" — which is the only thing it is reserved for.
    // Absolutely positioned against the `relative` cell DataGrid already
    // provides for the expanded editor, so the grid needs no new prop and stays
    // ignorant of the pending set.
    const stagedBar = staged.staged ? (
      <span
        aria-hidden
        data-staged="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-warning"
      />
    ) : null;

    if (!followable || target === null || shown === null) {
      return (
        <>
          {stagedBar}
          {valueButton}
        </>
      );
    }

    return (
      <>
        {stagedBar}
        <div className="flex w-full min-w-0 items-center gap-1.5">
          {valueButton}
          <FkLinkButton
            target={target}
            onOpen={() => (fkOpen ? closeFk() : void openFk(rowIndex, columnIndex, column, shown))}
          />
          {fkOpen ? (
            <FkPopover
              target={target}
              row={fkRow}
              loading={fkLoading}
              error={fkError}
              onJump={() => handleJump(target, shown)}
              onClose={closeFk}
            />
          ) : null}
        </div>
      </>
    );
  }
```

Simplify `startEdit` to match the narrowed `CellEdit`:

```tsx
  function startEdit(rowIndex: number, columnIndex: number, currentValue: string | null) {
    setEditError(null);
    setEditing({ rowIndex, columnIndex, draft: currentValue });
  }
```

Add `stagedUpdateFor` to the `../../lib/pendingChanges` import.

- [ ] **Step 7: Raise the editing row too**

In `DbTab.tsx`'s `<DataGrid …>` props, change:

```tsx
                    raisedRowIndex={fkCell?.rowIndex ?? null}
```

to:

```tsx
                    // Both overlays need to escape their own row's stacking
                    // context. Every virtualized row carries a `transform`, so
                    // an overlay's own z-index is sealed inside it and a LATER
                    // row paints over it — the editor had this bug too, not
                    // just the FK popover. Raising the ROW is the only fix.
                    raisedRowIndex={fkCell?.rowIndex ?? editing?.rowIndex ?? null}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test`
Expected: PASS, with the suite **DOWN 5** from Task 5's number — 9 tests deleted, 4 added, 2 rewritten in place. Carrying Task 5's numbers forward that is **475 passing / 50 files**. A decrease here is correct; confirm the delta is exactly -5 and that no test outside `DbTab.test.tsx` changed.

- [ ] **Step 9: Verify the build is clean**

Run: `cd apps/devbench && bun run build`
Expected: no `tsc` errors, no warnings. An "unused import" error for `invokePreviewCellEdit` means Step 4.9 was missed.

- [ ] **Step 10: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): stage cell edits instead of holding a live preview"
```

---

## Task 7: Boolean toggling (spec §7)

**Files:**
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: `cellDisplay` from `./DataGrid` (already imported), `stageCell` from Task 6
- Produces: no new exports.

**Detection stays string-based, deliberately.** Spec §7 is explicit that replacing the `"true"`/`"false"` inference with the real column type "is a follow-up, not part of this design". Reading `cellDisplay(shown).kind` also means toggling works on the first paint, before `describe_columns` has resolved — metadata-gated toggling would leave the checkboxes inert for a beat on every table open.

**`DataGrid`'s own `CellValue` checkbox stays disabled.** It renders on the path with no `renderCell` (the query console's results), where there is no primary key and nothing to stage against. Only `DbTab`'s cell renders an interactive one.

- [ ] **Step 1: Write the failing tests**

Add to `apps/devbench/src/components/db/DbTab.test.tsx`, inside `describe("inline cell editing", …)`:

```tsx
    // Spec §7: toggling IS the edit — no text editor, no confirm/cancel.
    it("toggles a boolean in place and stages it, with no editor in between", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "paid"], rows: [["1", "false"]], pk_column: "id",
      });
      useAppStore.getState().discardAllPending();

      renderDb(ORDERS);
      const box = (await screen.findByRole("checkbox", { name: "paid" })) as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(false);

      fireEvent.click(box);

      expect(useAppStore.getState().pending).toEqual([
        {
          kind: "update", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "paid", old_value: "false", new_value: "true",
        },
      ]);
      expect(screen.queryByLabelText("Edit paid")).toBeNull();
      // The staged value is drawn, or the click would look like a no-op.
      expect((screen.getByRole("checkbox", { name: "paid" }) as HTMLInputElement).checked).toBe(true);
    });

    // Spec §16, the boolean half of "staging a cell twice back to its stored
    // value leaves no pending change".
    it("toggling a boolean twice leaves no pending change", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "paid"], rows: [["1", "false"]], pk_column: "id",
      });
      useAppStore.getState().discardAllPending();

      renderDb(ORDERS);
      const box = await screen.findByRole("checkbox", { name: "paid" });
      fireEvent.click(box);
      expect(useAppStore.getState().pending).toHaveLength(1);
      fireEvent.click(screen.getByRole("checkbox", { name: "paid" }));

      expect(useAppStore.getState().pending).toEqual([]);
    });

    it("renders a boolean read-only when the table has no single-column primary key", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "paid"], rows: [["1", "true"]], pk_column: null,
      });

      renderDb(ORDERS);
      const box = (await screen.findByRole("checkbox", { name: "paid" })) as HTMLInputElement;
      expect(box.disabled).toBe(true);
    });

    // Spec §7 calls this a hard constraint: the three states must stay
    // distinct, so NULL keeps its italic text rather than becoming a third
    // checkbox appearance nobody can name.
    it("keeps NULL visually distinct from false in a boolean column", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "paid"], rows: [["1", null], ["2", "false"]], pk_column: "id",
      });

      renderDb(ORDERS);
      expect(await screen.findByText("NULL")).toBeTruthy();
      expect(screen.getAllByRole("checkbox", { name: "paid" })).toHaveLength(1);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test src/components/db/DbTab.test.tsx`
Expected: FAIL — the checkbox found is `DataGrid`'s disabled one, so `expect(box.disabled).toBe(false)` fails.

- [ ] **Step 3: Render an interactive checkbox in `renderCell`**

In `DbTab.tsx`'s `renderCell`, immediately after `const { className, kind } = cellDisplay(shown);`, insert:

```tsx
    // Spec §7: a boolean is the one type whose whole value space fits in a
    // control, so the checkbox IS the editor — no text field, no confirm or
    // cancel. NULL is not handled here: it falls through to the italic NULL
    // text below, which is what keeps the three states distinct.
    if (kind === "bool-true" || kind === "bool-false") {
      const checked = kind === "bool-true";
      return (
        <>
          {staged.staged ? (
            <span
              aria-hidden
              data-staged="true"
              className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-warning"
            />
          ) : null}
          <input
            type="checkbox"
            checked={checked}
            disabled={!editable}
            aria-label={column}
            title={editable ? "Toggle — staged until you Apply" : "Read-only"}
            onChange={() => stageCell(rowIndex, columnIndex, checked ? "false" : "true")}
            className="mx-auto block size-3.5 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent disabled:opacity-50"
          />
        </>
      );
    }
```

Note this sits **after** the `isEditingThisCell` branch, so a boolean can never open the text editor, and **after** `shown` is resolved, so it draws the staged value.

`stagedBar` is declared below this point in the function, which is why this branch inlines its own marker rather than referencing it. If you prefer, hoist `stagedBar` above both branches — but do not move `shown`, which both depend on.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test`
Expected: PASS — **+4**, i.e. **479 passing / 50 files** carrying Task 6's numbers forward.

- [ ] **Step 5: Verify the build is clean**

Run: `cd apps/devbench && bun run build`
Expected: no `tsc` errors, no warnings.

- [ ] **Step 6: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): make the boolean checkbox the editor"
```

---

## Task 8: Row delete (spec §11)

**Files:**
- Modify: `apps/devbench/src/components/db/DataGrid.tsx`
- Modify: `apps/devbench/src/components/db/DataGrid.test.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: `hasStagedDelete` from `../../lib/pendingChanges`; store `togglePendingDelete`
- Produces: `DataGridProps.renderRowActions?: (rowIndex: number) => ReactNode`

**Why a hook rather than a `onDeleteRow` prop:** `DataGrid` also renders the query console's results, which have no primary key and nothing to stage against. A slot keeps the grid ignorant of the pending set, exactly as `renderCell` already does — and the existing TSV/JSON copy buttons stay, since §15 does not retire them.

**Accepted, and deliberately not built:** a row staged for deletion is marked by its own action button (`aria-pressed`, danger colour) and by its entry in the Pending panel, not by striking the whole row through. Row-level treatment would mean new `DataGrid` surface for a state the panel already reports.

- [ ] **Step 1: Write the failing tests**

Add to `apps/devbench/src/components/db/DataGrid.test.tsx`:

```tsx
  it("renders caller-supplied row actions against the data row index", () => {
    render(
      <DataGrid
        columns={["id"]}
        rows={[["1"], ["2"]]}
        renderRowActions={(rowIndex) => (
          <button type="button" aria-label={`Act on row ${rowIndex}`}>
            x
          </button>
        )}
      />,
    );
    expect(screen.getByRole("button", { name: "Act on row 0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Act on row 1" })).toBeTruthy();
    // The copy actions are not retired by this slice and must survive.
    expect(screen.getAllByRole("button", { name: "Copy row as JSON" })).toHaveLength(2);
  });
```

Add to `apps/devbench/src/components/db/DbTab.test.tsx`, inside `describe("DbTab", …)`:

```tsx
  it("stages a row delete and toggles it back off", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["42", "pending"]], pk_column: "id",
    });
    useAppStore.getState().discardAllPending();

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: "Stage delete of row 42" }));

    expect(useAppStore.getState().pending).toEqual([
      { kind: "delete", table: ORDERS, pk_column: "id", pk_value: "42" },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Undo staged delete of row 42" }));
    expect(useAppStore.getState().pending).toEqual([]);
  });

  // Spec §11: it requires a single-column primary key — the same rule that
  // already governs whether a cell is editable. Without one there is no safe
  // WHERE target, so the action must be absent rather than disabled-and-lying.
  it("offers no delete action when the table has no single-column primary key", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["42", "pending"]], pk_column: null,
    });

    renderDb(ORDERS);
    await screen.findByText("pending");
    expect(screen.queryByRole("button", { name: /stage delete/i })).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test src/components/db`
Expected: FAIL — `Unable to find an accessible element … "Act on row 0"`.

- [ ] **Step 3: Add the slot to `DataGrid`**

In `apps/devbench/src/components/db/DataGrid.tsx`, add to `DataGridProps`:

```tsx
  /** Extra controls appended to the row's actions column — DbTab plugs the
   *  stage-delete toggle in here. Given the DATA row index, exactly like
   *  `renderCell`, so a reorder or a filter can never redirect an action to a
   *  different row than the one it was drawn on. */
  renderRowActions?: (rowIndex: number) => ReactNode;
```

Destructure it in the component signature beside `renderCell`, then append it inside the actions cell:

```tsx
                      <div role="cell" className="flex items-center px-2">
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
                        {renderRowActions ? renderRowActions(dataRowIndex) : null}
                      </div>
```

- [ ] **Step 4: Supply the action from `DbTab`**

Add a trash glyph beside the other icons in `DbTab.tsx`:

```tsx
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
    </svg>
  );
}
```

Read the action near the other store selectors:

```tsx
  const togglePendingDelete = useAppStore((s) => s.togglePendingDelete);
```

Add to the `<DataGrid …>` props:

```tsx
                    renderRowActions={(rowIndex) => {
                      // Spec §11: a delete needs a single-column primary key,
                      // the same rule that governs whether a cell is editable.
                      const pkColumn = tableRows?.pk_column;
                      if (!table || !pkColumn) return null;
                      const pkValue = pkValueForRow(rowIndex);
                      if (pkValue === null) return null;
                      const staged = hasStagedDelete(pending, table, pkValue);
                      return (
                        <button
                          type="button"
                          // Named by the row it acts on: one of these is drawn
                          // per row, and identical names would make every one
                          // of them indistinguishable to a screen reader.
                          aria-label={
                            staged
                              ? `Undo staged delete of row ${pkValue}`
                              : `Stage delete of row ${pkValue}`
                          }
                          aria-pressed={staged}
                          onClick={() => togglePendingDelete(table, pkColumn, pkValue)}
                          className={`px-1 ${
                            staged ? "text-danger" : "text-text-faint hover:text-danger"
                          }`}
                        >
                          <TrashIcon />
                        </button>
                      );
                    }}
```

Add `hasStagedDelete` to the `../../lib/pendingChanges` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test`
Expected: PASS — **+3**, i.e. **482 passing / 50 files** carrying Task 7's numbers forward.

- [ ] **Step 6: Verify the build is clean**

Run: `cd apps/devbench && bun run build`
Expected: no `tsc` errors, no warnings.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/DataGrid.tsx apps/devbench/src/components/db/DataGrid.test.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): stage a row delete from the actions column"
```

---

## Task 9: Delete `preview_cell_edit` (spec §15)

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/query.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Modify: `apps/devbench/src/lib/tauri.ts`

**Interfaces:**
- Removes: `preview_cell_edit_impl`, the `preview_cell_edit` command, `invokePreviewCellEdit`
- Keeps, untouched: `preview_state`, `PendingPreviewRegistry`, the sweep, `preview_query`, `preview_state`'s timeout, `commit_preview`, `rollback_preview`. `QueryConsole.tsx` is their live caller (spec §12).

**Do this last of the code tasks**, once nothing calls it. Task 6 removed the only frontend caller; this removes the command itself.

**It carries a real bug out with it.** `preview_cell_edit_impl` builds `SET "{column}" = $1` with the value bound as `TEXT` and never cast. Postgres has no assignment cast from `text`, so that statement errors on any non-text column — and all five of its tests edit a `text` column, so it never showed. `apply_changes` casts (Task 1, verified fact 1). Nothing is being lost here except the defect.

- [ ] **Step 1: Delete the implementation, the command and their tests**

In `apps/devbench/src-tauri/src/commands/query.rs`:

1. Delete `pub async fn preview_cell_edit_impl(…)` in full, including its `#[allow(clippy::too_many_arguments)]`.
2. Delete `#[tauri::command] pub async fn preview_cell_edit(…)` in full, including its `#[allow(clippy::too_many_arguments)]`.
3. Delete these five tests from the `#[cfg(test)] mod tests` block:
   - `preview_cell_edit_rejects_a_malicious_pk_column`
   - `preview_cell_edit_rejects_a_malicious_column`
   - `preview_cell_edit_updates_exactly_the_matched_row`
   - `preview_cell_edit_updates_a_text_primary_key_row`
   - `preview_cell_edit_errors_when_the_primary_key_value_matches_no_row`
4. Narrow the line-7 import. `get_column_type` and `validate_identifier_labeled` were used **only** inside `preview_cell_edit_impl`; leaving them imported is a warning, and the baseline is 0 warnings. `cell_to_string` still has callers at lines ~105, ~314 and ~324:

```rust
use crate::commands::db::cell_to_string;
```

If the test module's helpers (`public`, `local_dev_input`, `raw_pool`) become unused after step 3, delete those too — check by compiling, do not guess.

- [ ] **Step 2: Unregister the command**

In `apps/devbench/src-tauri/src/main.rs`, delete this line from `tauri::generate_handler![…]`:

```rust
            commands::query::preview_cell_edit,
```

- [ ] **Step 3: Delete the invoke wrapper**

In `apps/devbench/src/lib/tauri.ts`, delete `invokePreviewCellEdit` in full. Leave `invokePreviewQuery`, `invokeCommitPreview` and `invokeRollbackPreview` — `QueryConsole.tsx` imports all three.

- [ ] **Step 4: Verify nothing still refers to it**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections/apps/devbench
grep -rn "preview_cell_edit\|invokePreviewCellEdit" src src-tauri/src src-tauri/tests scripts
```

Expected: no output. A hit in `DbTab.tsx` means Task 6 was left incomplete.

- [ ] **Step 5: Run both suites**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS — **-5** from Task 1's number, i.e. **244 passed, 1 ignored** (lib) and **6 passed** (`smoke_test`) if your baseline was 242. Run `cargo test`, not `cargo test --lib`: `tests/smoke_test.rs` compiles the command surface, and this task changes it.

Run: `cd apps/devbench && bun run test`
Expected: unchanged at **482 passing / 50 files**.

- [ ] **Step 6: Verify there are no new warnings**

Run: `cd apps/devbench/src-tauri && cargo build 2>&1 | grep -c warning`
Expected: `0`. An unused-import warning means Step 1.4 was skipped.

Run: `cd apps/devbench && bun run build`
Expected: no `tsc` errors, no warnings.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/src/commands/query.rs apps/devbench/src-tauri/src/main.rs apps/devbench/src/lib/tauri.ts
git commit -m "refactor(devbench): retire the single-preview cell-edit path"
```

---

## Task 10: Spec reconciliation and the browser measurement gate

**Files:**
- Modify: `apps/devbench/scripts/fk-stub.js`
- Modify: `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md`

jsdom has no layout engine, so everything in this task is measured in a real browser and **reported as numbers**. "Looks right" is not a result. If a measurement fails, fix the code and re-measure — do not relax the pass condition.

- [ ] **Step 1: Extend the IPC stub**

`apps/devbench/scripts/fk-stub.js` already serves 260 rows over 12 columns with an FK on `user_id`. Two changes:

1. Give `META` the shapes the insert panel needs to be exercised — a database-assigned column, a required column, a defaulted column and a nullable one. Replace the `META` definition with:

```js
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
```

2. Add the new command to `HANDLERS`, beside `get_referenced_row`:

```js
    // Echoes success. The gate measures the UI around Apply, not the write —
    // a stub that reported a conflict would exercise the error path instead.
    apply_changes: (args) => ({ applied: (args.changes ?? []).length, conflict: null }),
```

- [ ] **Step 2: Start the app and load it with the stub**

```bash
cd apps/devbench && bun run dev
```

Drive the page with Playwright (the `playwright` MCP browser tools, or a script using the `npx playwright` already on this machine). Inject `scripts/fk-stub.js` with `addInitScript` **before** navigating to `http://localhost:5173`, then wait for `[role="table"]`.

Record: the viewport size used, and how many rows and columns the grid reports.

- [ ] **Step 3: Re-measure the four regression-critical behaviours**

They are constraints on every task in this plan, and this slice rewrote `renderCell` and the actions column.

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
    headerDelta: after.th - before.th,
    bodyDelta: after.td - before.td,
    renderedRows: rows().length - 1,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    rowHeights: [...new Set(rows().slice(1).map(r => r.getBoundingClientRect().height))],
  };
})()
```

Pass: `headerDelta === bodyDelta`; `renderedRows > 0`; `docScrollWidth === docClientWidth`; `rowHeights` is exactly `[33]`. The trash button added to the actions column is the thing most likely to have broken the row height — that is why it is measured here rather than assumed.

- [ ] **Step 4: Measure the toolbar with the Insert button present**

Spec §2 requires the toolbar to stay **one row** and collapse to icons below 620px of its own inline size. Slice 3 adds a button to it, which is exactly the kind of change that makes it wrap.

```js
(() => {
  const bar = document.querySelector('[role="table"] .\\@container');
  const kids = [...bar.children].filter(el => el.getBoundingClientRect().width > 0);
  const tops = [...new Set(kids.map(el => Math.round(el.getBoundingClientRect().top)))];
  return {
    barWidth: bar.getBoundingClientRect().width,
    barHeight: bar.getBoundingClientRect().height,
    distinctTops: tops,
    insertPresent: !!bar.querySelector('button[title="Insert row"]'),
  };
})()
```

Pass: `distinctTops.length === 1` (one row, nothing wrapped) and `insertPresent === true`. Record `barHeight`, then narrow the window until `barWidth < 620` and re-run: `distinctTops.length` must still be `1`, and the Insert label must be hidden while its `title` survives.

- [ ] **Step 5: Measure the cell editor's escape from its row's stacking context**

This is the bug Task 6 fixed. **Use `document.elementFromPoint`, never a z-index comparison.** In Slice 2 the z-index read correctly while the popover was actually unclickable behind the cells, because each virtualized row's `transform` creates a stacking context — the computed z-index was true and irrelevant.

Click a `status` cell in a row near the middle of the viewport (not the last rendered row — a later sibling has to exist for the test to mean anything), then:

```js
(() => {
  const editor = document.querySelector('input[aria-label^="Edit "]').closest('div');
  const r = editor.getBoundingClientRect();
  const points = [
    [r.left + 8, r.top + r.height / 2],
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.right - 8, r.top + r.height / 2],
  ];
  return points.map(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return { x: Math.round(x), y: Math.round(y), insideEditor: editor.contains(hit), hit: hit && hit.tagName };
  });
})()
```

Pass: `insideEditor === true` at **all three** points. A `false` at the right-hand point is the classic signature — the editor spills over the columns to its right, and that overhang is what a later row paints across.

- [ ] **Step 6: Measure the staged-cell marker**

Spec §10 calls it required, not decorative. Toggle a `paid` checkbox, then:

```js
(() => {
  const bar = document.querySelector('[data-staged="true"]');
  if (!bar) return { found: false };
  const s = getComputedStyle(bar);
  const r = bar.getBoundingClientRect();
  const cell = bar.parentElement.getBoundingClientRect();
  return {
    found: true,
    width: r.width,
    height: Math.round(r.height),
    background: s.backgroundColor,
    warningToken: getComputedStyle(document.documentElement).getPropertyValue('--warning').trim(),
    flushLeft: Math.round(r.left - cell.left),
    spansCell: Math.round(r.height) === Math.round(cell.height),
  };
})()
```

Pass: `found === true`; `width` is 2; `flushLeft === 0`; `spansCell === true`; and `background` resolves to the same colour as the `--warning` token — record both and confirm they match. A marker that resolved to `--danger` or to a transparent value would look like a rendering artefact rather than staged state.

- [ ] **Step 7: Measure the dock swapping occupants without changing width**

Spec §16 lists this explicitly. Record the width with chat open, click Insert in the toolbar, record again, stage the insert (which switches to Pending), record again:

```js
(() => {
  const dock = document.querySelector('aside[aria-label]');
  return {
    label: dock.getAttribute('aria-label'),
    width: dock.getBoundingClientRect().width,
    chatVar: getComputedStyle(document.documentElement).getPropertyValue('--w-chat').trim(),
  };
})()
```

Pass: all three readings report the **same** `width` and the same `chatVar`, with `label` changing from `AI Assistant` to `Insert row` to `Pending changes`. Then drag the resize handle in the Pending panel and confirm `--w-chat` still moves — that is what proves the extracted `DockShell` kept the behaviour rather than merely compiling.

- [ ] **Step 8: Measure the insert panel's generated fields**

```js
(() => {
  const dock = document.querySelector('aside[aria-label="Insert row"]');
  const fields = [...dock.querySelectorAll('input, select')].map(el => ({
    tag: el.tagName,
    type: el.type,
    readOnly: !!el.readOnly,
    placeholder: el.placeholder || null,
  }));
  const save = [...dock.querySelectorAll('button')].find(b => /stage insert/i.test(b.textContent));
  return { fields, saveDisabled: save.disabled, docScrollWidth: document.documentElement.scrollWidth };
})()
```

Pass: the `id` field is `readOnly === true`; `paid` is a `SELECT`; `amount` and `quantity` are `type === "number"`; `status` carries the placeholder `'pending'::text` and `created_at` carries `now()`; `saveDisabled === true` while the required text columns are empty, and `false` once they are filled. `docScrollWidth` must still equal `document.documentElement.clientWidth` — a dock panel is not allowed to widen the page.

- [ ] **Step 9: Record every number in the plan**

Append a `## Measured results` section to this plan file with the viewport used and the actual readings from Steps 3–8. Numbers, not "passed". A future reader has to be able to tell whether a later change moved something without re-deriving what it used to be.

- [ ] **Step 10: Reconcile the spec**

In `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md`:

1. **§10** — the `PendingChange` sketch says `table: string` and `values: Record<…>`. Record what was built and why, immediately below the type block:

```markdown
Implementation note (Slice 3): `table` is a validated `QualifiedTable`
(`{ schema, name }`), not a plain string — for the reason this section already
gives for splitting the primary key into `pkColumn` + `pkValue`: a pre-joined
string is a string that ends up interpolated into SQL. Field names on the wire
are snake_case (`pk_column`, `old_value`, `previewed_effect`), matching serde
and `TableRows`'s existing `pk_column`. `values` stays a JSON object and
deserializes into a `BTreeMap`, so the generated column list and VALUES list
are built from one deterministic order.
```

2. **§13** — record `apply_changes`'s real signature and the cast rule:

```markdown
apply_changes(connection_id, changes: Vec<PendingChange>) -> ApplyOutcome

struct ConflictReport {
  index: usize,            // position in the submitted set
  table: String,           // "public.orders", for display only
  description: String,     // "id = 42"
  column: Option<String>,  // None for a delete
  expected: Option<String>,
  found: Option<String>,
  row_missing: bool,       // the PK matched no row — distinct from found: None,
                           // which means the row is there holding NULL
}
```

and, beside the `UPDATE … IS NOT DISTINCT FROM` example:

```markdown
Every bound value is cast to its column's catalog type (`$1::int4`), never the
column to text. sqlx binds parameters as TEXT and Postgres has no assignment
cast from text, so an uncast `SET "n" = $1` is a hard error on any non-text
column; casting the column instead would be sargable-destroying on the keyed
side. The type comes from the catalog and is identifier-validated before
interpolation.
```

3. **§17** — mark Slice 3 planned:

```markdown
Slice 3: `docs/superpowers/plans/2026-08-02-table-view-slice-3-writes.md`.
Slice 4 is not planned yet.
```

4. **§15** — record that the retirement reasoning was discharged, replacing the "must be re-checked in review" clause with what the re-check concluded (see Task 6's preamble; copy that paragraph in).

- [ ] **Step 11: Final full verification**

All three, from a clean tree:

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections/apps/devbench && bun run test
```

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections/apps/devbench && bun run build
```

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections/apps/devbench/src-tauri && cargo test
```

Expected against the baseline measured at the top of this plan (445/46 vitest; 242+1 ignored lib and 6 smoke cargo):
- vitest **482 passing / 50 files** (+13 +3 +8 +11 −5 +4 +3)
- build clean, 0 warnings
- cargo **244 passed, 1 ignored** (lib) and **6 passed** (`smoke_test`) (+7 −5)

Reconcile against your own re-measured baseline, not these absolutes. Run `cargo test`, not `cargo test --lib`.

- [ ] **Step 12: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/scripts/fk-stub.js docs/superpowers/specs/2026-08-02-devbench-table-view-design.md docs/superpowers/plans/2026-08-02-table-view-slice-3-writes.md
git commit -m "test(devbench): measure the write UI in a real browser, reconcile the spec"
```

---

## Self-review notes

Checked while writing, recorded so a reader does not have to re-derive them:

- **Spec coverage.** §9 → Task 4. §10 → Tasks 1, 2, 5, 6. §11 → Task 8. §15 → Tasks 6 and 9. §7's toggling → Task 7. §1's dock slot → Tasks 3, 4, 5. §13's `apply_changes` → Task 1. §16's Rust list → Task 1's seven tests; its vitest list → Tasks 2, 4, 6, 7; its browser list → Task 10.
- **Deliberately out of scope, with reasons in the constraints:** §13's per-`(connection, table, filter)` count cache (nothing is complaining about the cost yet, and it would add an invalidation path); §12's Run query / Add to pending UI (Slice 4 — but the `sql` variant of the type and its Apply arm are built, because Apply must handle whatever the set holds); §3a/§3b rail and query tabs (Slice 4); §7's replacement of string-based boolean detection (the spec itself defers it).
- **Type consistency.** `PendingChange`'s field names are snake_case on both sides. `pk_column` / `pk_value` / `old_value` / `new_value` / `previewed_effect` / `row_missing` are spelled identically in `db_apply.rs`, `pendingChanges.ts`, every test and every panel. `stagedUpdateFor` is the one staged-value lookup and is called by Task 6's `renderCell` and nothing else. `stageCell` (Task 6) is the one staging call site and is reused unchanged by Task 7.
- **Known gap this plan does not close:** spec §18's "staged values are not re-queried" still holds — a cell staged to a value that no longer matches the active filter stays visible. That is the accepted behaviour, not an oversight.

---

## Measured results

Task 10's browser gate, run against Chromium 1234 (Playwright 1.62.1, headless)
on the Vite dev server with `scripts/fk-stub.js` injected via `addInitScript`.
Numbers, not verdicts — a later change that moves one of these should be
visible as a moved number.

**Viewport:** 1440 × 900 CSS px, `deviceScaleFactor: 1`. Step 4 alone also
reads at 1600 × 900, because at 1440 the dock already squeezes the toolbar
below its own collapse threshold and the labels would never be seen expanded.

**Fixture as loaded:** 12 data columns + 1 actions column, `aria-rowcount="100"`
(page 1 of 3 over the stub's 260 rows), 24 rows rendered by the virtualizer.
Zero console errors across the whole run.

### Step 3 — the four regression-critical behaviours

| reading | value |
| --- | --- |
| `headerDelta` | −400 |
| `bodyDelta` | −400 (equal — header and body track together) |
| `renderedRows` | 24 |
| `docScrollWidth` / `docClientWidth` | 1440 / 1440 (equal — the page does not scroll horizontally) |
| `rowHeights` | `[33]` — one value, so the trash button did not change row height |

### Step 4 — the toolbar with the Insert button present

| reading | 1600 × 900 | 1440 × 900 |
| --- | --- | --- |
| `barWidth` (border box) | 788 | 628 |
| toolbar content box (what `@container` reads) | 772 | 612 |
| `barHeight` | 37 | 37 |
| distinct child centres | `[127]` | `[127]` |
| occupied band / tallest child | 26 / 26 | 26 / 26 |
| `insertPresent` | true | true |
| Insert `title` | `Insert row` | `Insert row` |
| Insert `.tb-label` display / width | `block` / 35.7px | `none` / 0px |

One row on both sides of the threshold: every visible child shares centre y=127
and the whole band is 26px, the height of the tallest child, so nothing wrapped
— and `barHeight` stays 37 either way.

Two notes on the instrument, because the brief's snippet reads differently than
it intends:

- `distinctTops` is `[114, 119, 127, 115]` at **both** widths and always will
  be. The bar is `items-center`, so children of different heights (26px
  buttons, the 16px divider, the 0px spacer, the 24px pager) legitimately have
  different `top`s on a single row. Distinct **centres** (and the band-vs-
  tallest-child comparison above) is what actually distinguishes one row from
  two; `distinctTops.length === 1` would only hold if every child were the same
  height.
- The 620px threshold is on the toolbar's **content** box, which `px-2` makes
  16px narrower than `getBoundingClientRect().width`. `barWidth` 628 is already
  collapsed (content 612). `globals.css` records the same measurement.

### Step 5 — the cell editor's escape from its row's stacking context

Measured with `document.elementFromPoint`, never a z-index comparison. Edited
the `status` cell of the 13th rendered row (ordinal 12 of 24, **11 later
sibling rows** below it — the later siblings are what make the test mean
anything).

| reading | value |
| --- | --- |
| editor `aria-label` | `Edit status` |
| cell rect | left 751, right 891 (140 wide) |
| editor rect | left 751, right 930 (179 wide, 34 tall) |
| overhang past the cell's right edge | **39px** — the editor does spill over the columns to its right |
| editing row's computed `z-index` | 20 (the row is raised, not the overlay) |
| hit at (759, 589) — left | `insideEditor: true`, DIV |
| hit at (841, 589) — centre | `insideEditor: true`, INPUT |
| hit at (922, 589) — **right, over the overhang** | `insideEditor: true`, DIV |

All three points land inside the editor. The right-hand point is the one that
would read `false` if a later row painted across the overhang.

### Step 6 — the staged-cell marker

Toggled a `paid` checkbox, then measured the `[data-staged="true"]` bar.

| reading | value |
| --- | --- |
| `width` | 2 |
| `height` / cell height | 32 / 32 → `spansCell: true` |
| `flushLeft` | 0 |
| `background` | `rgb(227, 164, 56)` |
| `--warning` token | `#e3a438`, resolving to `rgb(227, 164, 56)` — **same colour** |

### Step 7 — the dock swapping occupants without changing width

| occupant | `aria-label` | width | `--w-chat` |
| --- | --- | --- | --- |
| chat | `AI Assistant` | 320 | `320px` |
| insert | `Insert row` | 320 | `320px` |
| pending | `Pending changes` | 320 | `320px` |

Then dragging the Pending panel's resize handle 80px left: `--w-chat` moved
`320px` → `400px` and the panel measured 400 — so `DockShell`'s extraction kept
the resize behaviour, not just the compile.

Instrument note: `document.querySelector('aside[aria-label]')` returns the
**Sessions sidebar** (`aria-label="Sessions"`, 240px), which is the first
`<aside>` in the document. The dock is the last one; the readings above are the
last `<aside>`, and the full list was captured at every step to prove which is
which.

### Step 8 — the insert panel's generated fields

Fields in `describe_columns` order, one per stub column:

| column | control | notes |
| --- | --- | --- |
| `id` | `INPUT` text | **`readOnly: true`**, placeholder `auto` |
| `user_id` | `INPUT` text | required |
| `status` | `INPUT` text | placeholder **`'pending'::text`** |
| `amount` | `INPUT` **`number`** | required |
| `paid` | **`SELECT`** | required |
| `created_at` | `INPUT` text | placeholder **`now()`** |
| `notes` | `INPUT` text | placeholder `NULL` (nullable) |
| `region`, `channel`, `sku`, `reference` | `INPUT` text | required |
| `quantity` | `INPUT` **`number`** | required |

`Stage insert` is `disabled: true` with the required columns empty and
`disabled: false` once they are filled. `docScrollWidth` 1440 = `docClientWidth`
1440 with the panel open — the dock does not widen the page.
