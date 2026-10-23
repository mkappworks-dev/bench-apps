# Schema Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify every table by `(schema, name)` instead of by name alone, so a table in a non-public schema resolves correctly and same-named tables in different schemas stop colliding.

**Architecture:** A `QualifiedTable` newtype with private fields and a validating constructor replaces the bare `table: &str` parameter throughout the Postgres data path. It deserializes through `serde(try_from)`, so the IPC boundary cannot construct one without validation. Catalog lookups gain the `table_schema` predicate they never had. SQLite's `watched_tables` gains a schema column; the frontend carries `{schema, name}` through tab state and grid-layout keys.

**Tech Stack:** Rust + sqlx (Postgres + SQLite), Tauri 2 commands, serde, React 18, vitest + @testing-library/react.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-devbench-schema-qualification-design.md`.
- **No user-visible change.** Anyone working solely in `public` must see identical behavior. This plan ships correctness for non-public schemas and nothing else.
- Identifiers are **validated then double-quoted** before interpolation. Values remain bound parameters — never interpolated.
- Baselines to keep green: `cd apps/devbench && bun run test` (**388 passing / 43 files**), `bun run build` (runs `tsc`), `cd apps/devbench/src-tauri && cargo test --lib` (**213 passing, 1 ignored**). All grow as tasks add tests.
- Postgres for Rust tests: container `devbench-test-pg`, `localhost:5432`, `postgres`/`postgres`, database `devbench_test`. `docker start devbench-test-pg` if unreachable. Don't modify roles or auth.
- **Expected mid-plan inconsistency:** Task 2 changes the Tauri command signatures; the frontend catches up in Tasks 4–5. Between them the *app* is inconsistent at runtime while *both test suites stay green* (frontend tests mock `invoke`). This is expected in a compiler-driven refactor — do not add a compatibility shim to paper over it.
- Out of scope, belongs to plan 2b: foreign keys, `describe_columns`, `get_referenced_row`, retiring `inferFamily`, and replacing `db_filter`'s `::text`/`::numeric` casts with real column types. Do not start them or "improve" them in passing.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src-tauri/src/commands/qualified_table.rs` | The `QualifiedTable` newtype: validation, quoting, wire deserialization. Pure; no DB access. |
| `src-tauri/migrations/0007_watched_tables_schema.sql` | Rebuilds `watched_tables` with a `table_schema` column. |

**Modified**

| File | Change |
|---|---|
| `src-tauri/src/commands/mod.rs` | Register `qualified_table`. |
| `src-tauri/src/commands/db.rs` | `validate_identifier` gains a labelled variant; catalog lookups gain the schema predicate; query impls and commands take `QualifiedTable`. |
| `src-tauri/src/commands/query.rs` | Cell edit takes `QualifiedTable`. |
| `src-tauri/src/commands/correlation.rs` | Snapshot takes `QualifiedTable`. |
| `src-tauri/src/commands/watched.rs` | Stores and returns `(schema, name)`. |
| `src/lib/tauri.ts` | `QualifiedTable` type; every table-taking wrapper uses it. |
| `src/components/db/SchemaTree.tsx` | Selects and compares by qualified identity. |
| `src/components/db/DbTab.tsx` | Holds `{schema, name}`; tab state and layout key carry schema. |

---

## Task 1: The `QualifiedTable` newtype

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/qualified_table.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/commands/db.rs`

**Interfaces:**
- Consumes: `crate::commands::db::validate_identifier`
- Produces: `QualifiedTable::new(schema, name) -> Result<Self, String>`, `.quoted() -> String`, `.schema() -> &str`, `.name() -> &str`; `db::validate_identifier_labeled(kind, identifier) -> Result<(), String>`

This task is a pure addition — nothing calls it yet, so the tree compiles clean throughout.

- [ ] **Step 1: Give `validate_identifier` a labelled variant**

`validate_identifier`'s messages are hardcoded to "table name", which would make a rejected *schema* report the wrong noun. In `apps/devbench/src-tauri/src/commands/db.rs`, replace the existing function with these two:

```rust
/// Validates that a table or column identifier is a legitimate Postgres
/// identifier. Allows only ASCII alphanumeric characters and underscores.
pub(crate) fn validate_identifier(identifier: &str) -> Result<(), String> {
    validate_identifier_labeled("table name", identifier)
}

/// Same rules, but the caller names what it is validating. A rejected schema
/// reporting "table name contains invalid characters" sends the reader to the
/// wrong half of the input.
pub(crate) fn validate_identifier_labeled(kind: &str, identifier: &str) -> Result<(), String> {
    if identifier.is_empty() {
        return Err(format!("{kind} cannot be empty"));
    }
    if identifier.len() > 63 {
        return Err(format!("{kind} exceeds maximum Postgres identifier length (63)"));
    }
    if !identifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!(
            "{kind} contains invalid characters; only alphanumeric and underscore allowed: {identifier}"
        ));
    }
    Ok(())
}
```

Every existing caller of `validate_identifier` keeps working unchanged.

- [ ] **Step 2: Register the module**

In `apps/devbench/src-tauri/src/commands/mod.rs`, add alongside the existing entries (the list is alphabetical):

```rust
pub mod qualified_table;
```

- [ ] **Step 3: Write the failing tests**

Create `apps/devbench/src-tauri/src/commands/qualified_table.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_both_parts_separately() {
        let t = QualifiedTable::new("public", "orders").unwrap();
        assert_eq!(t.quoted(), "\"public\".\"orders\"");
    }

    #[test]
    fn exposes_its_parts() {
        let t = QualifiedTable::new("alt", "orders").unwrap();
        assert_eq!(t.schema(), "alt");
        assert_eq!(t.name(), "orders");
    }

    // The schema is new attack surface: before this type existed, nothing
    // validated it because nothing carried it.
    #[test]
    fn rejects_an_injection_payload_in_the_schema() {
        let result = QualifiedTable::new("public\"; DROP TABLE users; --", "orders");
        assert!(result.is_err(), "a schema is an identifier and must be validated");
    }

    #[test]
    fn rejects_an_injection_payload_in_the_name() {
        let result = QualifiedTable::new("public", "orders\"; DROP TABLE users; --");
        assert!(result.is_err());
    }

    // The error must name which half was wrong, or the reader checks the
    // wrong input.
    #[test]
    fn names_the_offending_part_in_the_error() {
        let err = QualifiedTable::new("bad-schema", "orders").unwrap_err();
        assert!(err.contains("schema"), "expected the error to name the schema, got: {err}");

        let err = QualifiedTable::new("public", "bad-table").unwrap_err();
        assert!(err.contains("table"), "expected the error to name the table, got: {err}");
    }

    #[test]
    fn rejects_empty_parts() {
        assert!(QualifiedTable::new("", "orders").is_err());
        assert!(QualifiedTable::new("public", "").is_err());
    }

    // Deserialization is the real boundary. A plain derive would let the
    // frontend populate the fields directly and skip validation entirely,
    // which would make the type's guarantee fiction.
    #[test]
    fn deserializing_runs_the_validating_constructor() {
        let ok: Result<QualifiedTable, _> =
            serde_json::from_str(r#"{"schema":"public","name":"orders"}"#);
        assert_eq!(ok.unwrap().quoted(), "\"public\".\"orders\"");

        let bad: Result<QualifiedTable, _> =
            serde_json::from_str(r#"{"schema":"public","name":"orders\"; DROP TABLE users; --"}"#);
        assert!(bad.is_err(), "an invalid identifier must fail deserialization");
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::qualified_table`
Expected: compile error — `QualifiedTable` not found.

- [ ] **Step 5: Write the implementation**

Insert above the `#[cfg(test)]` block in `qualified_table.rs`:

```rust
use serde::Deserialize;

use crate::commands::db::validate_identifier_labeled;

/// A schema-qualified table. Fields are private and the only constructor
/// validates both identifiers, so an unvalidated `QualifiedTable` cannot
/// exist anywhere in the process — including one that arrived over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "QualifiedTableWire")]
pub struct QualifiedTable {
    schema: String,
    name: String,
}

impl QualifiedTable {
    pub fn new(schema: &str, name: &str) -> Result<Self, String> {
        validate_identifier_labeled("schema name", schema)?;
        validate_identifier_labeled("table name", name)?;
        Ok(Self { schema: schema.to_string(), name: name.to_string() })
    }

    /// `"public"."orders"` — the only path by which a table reaches SQL.
    pub fn quoted(&self) -> String {
        format!("\"{}\".\"{}\"", self.schema, self.name)
    }

    pub fn schema(&self) -> &str {
        &self.schema
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

/// The wire shape, deserialized then funnelled through `new` so validation
/// cannot be bypassed by populating fields directly.
#[derive(Deserialize)]
struct QualifiedTableWire {
    schema: String,
    name: String,
}

impl TryFrom<QualifiedTableWire> for QualifiedTable {
    type Error = String;

    fn try_from(wire: QualifiedTableWire) -> Result<Self, Self::Error> {
        QualifiedTable::new(&wire.schema, &wire.name)
    }
}

impl std::fmt::Display for QualifiedTable {
    /// Unquoted `public.orders`, for error messages — never for SQL.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.schema, self.name)
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::qualified_table`
Expected: `test result: ok. 7 passed`

- [ ] **Step 7: Run the full Rust suite**

Run: `cd apps/devbench/src-tauri && cargo test --lib`
Expected: all pass, 213 → 220.

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/src/commands
git commit -m "feat(devbench): add a validated QualifiedTable newtype"
```

---

## Task 2: Qualify the Postgres data path

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/db.rs`
- Modify: `apps/devbench/src-tauri/src/commands/query.rs`
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`

**Interfaces:**
- Consumes: `QualifiedTable` (Task 1)
- Produces: `get_primary_key_column(pool, &QualifiedTable)`, `get_column_type(pool, &QualifiedTable, column)`, `list_table_rows_impl(pool, &QualifiedTable, filter, order_by, limit, offset)`, `count_table_rows_impl(pool, &QualifiedTable, filter)`, `snapshot_table(pool, &QualifiedTable, pk_col)`, `preview_cell_edit_impl(..., table: &QualifiedTable, ...)`; Tauri commands `list_table_rows` / `count_table_rows` / `preview_cell_edit` take `table: QualifiedTable`

This task is one unit because Rust's type system makes it one: changing `get_column_type`'s signature breaks `query.rs` in the same compile, and `get_primary_key_column`'s breaks `correlation.rs`. Splitting it would require temporary `QualifiedTable::new("public", table)` shims — exactly the parallel-old-and-new path the spec's sequencing section rejects. Work through the steps in order and let the compiler enumerate the breakage.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `apps/devbench/src-tauri/src/commands/db.rs`:

```rust
    fn public(name: &str) -> crate::commands::qualified_table::QualifiedTable {
        crate::commands::qualified_table::QualifiedTable::new("public", name).unwrap()
    }

    // The catalog lookups matched on table_name alone, so a table name present
    // in two schemas resolved by luck. This is the defect the whole refactor
    // exists to remove.
    #[tokio::test]
    async fn a_table_name_present_in_two_schemas_resolves_by_schema() {
        let pool = test_pool().await;
        sqlx::query("CREATE SCHEMA IF NOT EXISTS alt").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS public.dup").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS alt.dup").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE public.dup (id serial PRIMARY KEY, tag text)")
            .execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE alt.dup (other_id serial PRIMARY KEY, tag text)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO public.dup (tag) VALUES ('p1'), ('p2')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO alt.dup (tag) VALUES ('a1')")
            .execute(&pool).await.unwrap();

        let alt_dup = crate::commands::qualified_table::QualifiedTable::new("alt", "dup").unwrap();

        // Rows come from the right physical table.
        let p = list_table_rows_impl(&pool, &public("dup"), &[], &[], 200, 0).await.unwrap();
        assert_eq!(p.rows.len(), 2);
        let a = list_table_rows_impl(&pool, &alt_dup, &[], &[], 200, 0).await.unwrap();
        assert_eq!(a.rows.len(), 1);

        // Counts too.
        assert_eq!(count_table_rows_impl(&pool, &public("dup"), &[]).await.unwrap(), 2);
        assert_eq!(count_table_rows_impl(&pool, &alt_dup, &[]).await.unwrap(), 1);

        // And the PK lookup, which previously saw two candidate rows and
        // reported a composite key.
        assert_eq!(get_primary_key_column(&pool, &public("dup")).await.unwrap(), "id");
        assert_eq!(get_primary_key_column(&pool, &alt_dup).await.unwrap(), "other_id");

        sqlx::query("DROP TABLE public.dup").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE alt.dup").execute(&pool).await.unwrap();
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::db`
Expected: compile errors — `list_table_rows_impl` etc. expect `&str`, not `&QualifiedTable`.

- [ ] **Step 3: Qualify the catalog lookups**

In `db.rs`, replace both functions:

```rust
pub async fn get_primary_key_column(
    pool: &PgPool,
    table: &crate::commands::qualified_table::QualifiedTable,
) -> Result<String, String> {
    let rows = sqlx::query(
        "SELECT kcu.column_name FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name \
         WHERE tc.constraint_type = 'PRIMARY KEY' \
           AND tc.table_name = $1 AND tc.table_schema = $2",
    )
    .bind(table.name())
    .bind(table.schema())
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to look up primary key for {table}: {e}"))?;

    match rows.len() {
        0 => Err(format!("table {table} has no single-column primary key — not watchable")),
        1 => Ok(rows[0].get::<String, _>("column_name")),
        _ => Err(format!("table {table} has a composite primary key — not watchable")),
    }
}

pub(crate) async fn get_column_type(
    pool: &PgPool,
    table: &crate::commands::qualified_table::QualifiedTable,
    column: &str,
) -> Result<String, String> {
    let row = sqlx::query(
        "SELECT udt_name FROM information_schema.columns \
         WHERE table_name = $1 AND column_name = $2 AND table_schema = $3",
    )
    .bind(table.name())
    .bind(column)
    .bind(table.schema())
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("failed to look up type for {table}.{column}: {e}"))?
    .ok_or_else(|| format!("no such column {column} on table {table}"))?;
    Ok(row.get::<String, _>("udt_name"))
}
```

The `{table}` interpolations in the error strings use the `Display` impl from Task 1, which renders unquoted `public.orders`.

- [ ] **Step 4: Qualify the query impls**

In `db.rs`, change both signatures and their SQL. Note the `validate_identifier(table)?` line **disappears** — the type already guarantees it:

```rust
pub async fn list_table_rows_impl(
    pool: &PgPool,
    table: &crate::commands::qualified_table::QualifiedTable,
    filter: &[crate::commands::db_filter::FilterCondition],
    order_by: &[SortTerm],
    limit: i64,
    offset: i64,
) -> Result<TableRows, String> {
    // The table is validated by construction. Sort columns are not.
    for term in order_by {
        validate_identifier(&term.column)?;
    }

    let pk_column = get_primary_key_column(pool, table).await.ok();

    let compiled = crate::commands::db_filter::compile_filter(filter, 1)?;
    let limit_index = compiled.params.len() + 1;
    let offset_index = compiled.params.len() + 2;

    let mut sql = format!("SELECT * FROM {}{}", table.quoted(), compiled.where_sql);
```

The rest of the function body is unchanged. Then:

```rust
pub async fn count_table_rows_impl(
    pool: &PgPool,
    table: &crate::commands::qualified_table::QualifiedTable,
    filter: &[crate::commands::db_filter::FilterCondition],
) -> Result<i64, String> {
    let compiled = crate::commands::db_filter::compile_filter(filter, 1)?;
    let sql = format!("SELECT COUNT(*) AS n FROM {}{}", table.quoted(), compiled.where_sql);
```

The rest of that body is unchanged too.

- [ ] **Step 5: Update the Tauri commands**

In `db.rs`, change the `table` parameter type on both commands. Serde's `try_from` runs validation during deserialization, so an invalid identifier fails before the body executes:

```rust
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn list_table_rows(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
    table: crate::commands::qualified_table::QualifiedTable,
    filter: Option<Vec<crate::commands::db_filter::FilterCondition>>,
    order_by: Option<Vec<SortTerm>>,
    limit: i64,
    offset: i64,
) -> Result<TableRows, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    list_table_rows_impl(
        &pool,
        &table,
        &filter.unwrap_or_default(),
        &order_by.unwrap_or_default(),
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn count_table_rows(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
    table: crate::commands::qualified_table::QualifiedTable,
    filter: Option<Vec<crate::commands::db_filter::FilterCondition>>,
) -> Result<i64, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    count_table_rows_impl(&pool, &table, &filter.unwrap_or_default()).await
}
```

- [ ] **Step 6: Qualify the cell-edit path**

In `apps/devbench/src-tauri/src/commands/query.rs`, change `preview_cell_edit_impl`'s `table` parameter from `table: &str` to:

```rust
    table: &crate::commands::qualified_table::QualifiedTable,
```

Delete its `validate_identifier(table)?;` line (keep the `pk_column` and `column` ones), and change the UPDATE:

```rust
    let sql = format!(
        "UPDATE {} SET \"{column}\" = $1 WHERE \"{pk_column}\" = $2::{pk_type}",
        table.quoted()
    );
```

Then change the `preview_cell_edit` Tauri command in the same file so its `table` parameter is `crate::commands::qualified_table::QualifiedTable` and it passes `&table`.

- [ ] **Step 7: Qualify the correlation snapshot**

In `apps/devbench/src-tauri/src/commands/correlation.rs`, change the snapshot function's `table: &str` to:

```rust
    table: &crate::commands::qualified_table::QualifiedTable,
```

Delete its `validate_identifier(table)?;` line (keep `validate_identifier(pk_col)?;`), update the comment above it to say the table is validated by construction, and change the SQL:

```rust
    let sql = format!(
        "SELECT \"{pk_col}\"::text as pk, md5(t::text) as hash FROM {} t",
        table.quoted()
    );
```

- [ ] **Step 8: Fix every remaining call site the compiler names**

Run: `cd apps/devbench/src-tauri && cargo build 2>&1 | grep -E "^error" | head -40`

Work through each error. Call sites inside test modules pass `&public("orders")` using the helper from Step 1; production call sites construct the table from whatever schema they now carry. Repeat until the build is clean.

- [ ] **Step 9: Run the tests**

Run: `cd apps/devbench/src-tauri && cargo test --lib`
Expected: all pass, including `a_table_name_present_in_two_schemas_resolves_by_schema`. 220 → 221.

- [ ] **Step 10: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/src
git commit -m "feat(devbench): resolve tables by schema across the Postgres data path"
```

---

## Task 3: Persist the schema with watched tables

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0007_watched_tables_schema.sql`
- Modify: `apps/devbench/src-tauri/src/commands/watched.rs`

**Interfaces:**
- Consumes: `QualifiedTable` (Task 1)
- Produces: `list_watched_tables_impl(pool, connection_id) -> Result<Vec<QualifiedTable>, String>`, `set_watched_table_impl(pool, connection_id, &QualifiedTable, watched)`; command `list_watched_tables` returns `Vec<QualifiedTable>` serialized as `{schema, name}`

- [ ] **Step 1: Write the migration**

Create `apps/devbench/src-tauri/migrations/0007_watched_tables_schema.sql`:

```sql
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
```

- [ ] **Step 2: Write the failing test**

`watched.rs` already has a `mod tests` block whose helper is `db()`, returning `(tempfile::TempDir, LocalDb)` — bind the `TempDir` as `_dir` so it outlives the test and the temp database isn't deleted mid-run. Add:

```rust
    fn qt(schema: &str, name: &str) -> crate::commands::qualified_table::QualifiedTable {
        crate::commands::qualified_table::QualifiedTable::new(schema, name).unwrap()
    }

    // Watching the same table name in two schemas must produce two rows, not
    // one — the composite primary key is what makes that possible.
    #[tokio::test]
    async fn the_same_name_in_two_schemas_watches_independently() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", &qt("public", "dup"), true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", &qt("alt", "dup"), true).await.unwrap();

        let watched = list_watched_tables_impl(&db.pool, "default").await.unwrap();
        assert_eq!(watched.len(), 2);

        // Unwatching one leaves the other.
        set_watched_table_impl(&db.pool, "default", &qt("alt", "dup"), false).await.unwrap();
        let watched = list_watched_tables_impl(&db.pool, "default").await.unwrap();
        assert_eq!(watched, vec![qt("public", "dup")]);
    }
```

The existing tests in this module call `set_watched_table_impl` with a bare `&str`; update each to `&qt("public", "…")` when the signature changes in Step 4.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::watched`
Expected: compile error — the impls take `&str`, not `&QualifiedTable`.

- [ ] **Step 4: Qualify the store**

In `watched.rs`, replace both impls. The `validate_identifier` call disappears — the type guarantees it:

```rust
use crate::commands::qualified_table::QualifiedTable;

pub async fn list_watched_tables_impl(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Vec<QualifiedTable>, String> {
    let rows = sqlx::query(
        "SELECT table_schema, table_name FROM watched_tables \
         WHERE connection_id = ? ORDER BY table_schema, table_name",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to list watched tables: {e}"))?;

    // A stored row was validated before it was written, but it is re-validated
    // on the way out: the database file is editable by hand, and this value is
    // interpolated into SQL downstream.
    rows.iter()
        .map(|r| QualifiedTable::new(&r.get::<String, _>("table_schema"), &r.get::<String, _>("table_name")))
        .collect()
}

pub async fn set_watched_table_impl(
    pool: &SqlitePool,
    connection_id: &str,
    table: &QualifiedTable,
    watched: bool,
) -> Result<(), String> {
    if watched {
        sqlx::query(
            "INSERT OR IGNORE INTO watched_tables (connection_id, table_schema, table_name) \
             VALUES (?, ?, ?)",
        )
        .bind(connection_id)
        .bind(table.schema())
        .bind(table.name())
        .execute(pool)
        .await
        .map_err(|e| format!("failed to watch {table}: {e}"))?;
    } else {
        sqlx::query(
            "DELETE FROM watched_tables \
             WHERE connection_id = ? AND table_schema = ? AND table_name = ?",
        )
        .bind(connection_id)
        .bind(table.schema())
        .bind(table.name())
        .execute(pool)
        .await
        .map_err(|e| format!("failed to unwatch {table}: {e}"))?;
    }
    Ok(())
}
```

`QualifiedTable` needs `Serialize` for the command's return type — add `Serialize` to its derive list in `qualified_table.rs`. It serializes as `{"schema": "...", "name": "..."}`, matching the wire shape it deserializes from.

- [ ] **Step 5: Update the commands**

In `watched.rs`, change `list_watched_tables`'s return type to `Result<Vec<QualifiedTable>, String>` and `set_watched_table`'s `table: String` parameter to `table: QualifiedTable`, passing `&table` to the impl.

- [ ] **Step 6: Fix the call sites the compiler names**

Run: `cd apps/devbench/src-tauri && cargo build 2>&1 | grep -E "^error" | head -20`

`correlation.rs` reads the watched list to decide what to snapshot and now receives `QualifiedTable` values it can pass straight through. Fix each error until clean.

- [ ] **Step 7: Run the tests**

Run: `cd apps/devbench/src-tauri && cargo test --lib`
Expected: all pass, 221 → 222.

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri
git commit -m "feat(devbench): store the schema alongside each watched table"
```

---

## Task 4: Frontend wrappers

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Modify: `apps/devbench/src/lib/tauri.test.ts`

**Interfaces:**
- Consumes: Task 2 and 3's command payload shapes
- Produces: `QualifiedTable { schema: string; name: string }`; `invokeListTableRows(connectionId, table: QualifiedTable, options?)`, `invokeCountTableRows(connectionId, table: QualifiedTable, filter?)`, `invokeListWatchedTables(connectionId): Promise<QualifiedTable[]>`, `invokeSetWatchedTable(connectionId, table: QualifiedTable, watched)`, `invokePreviewCellEdit(connectionId, table: QualifiedTable, ...)`

- [ ] **Step 1: Write the failing test**

Add to `apps/devbench/src/lib/tauri.test.ts` (this file's helper for reading the last call is `lastInvoke()`, which returns `[command, payload]`):

```ts
describe("qualified table wrappers", () => {
  beforeEach(() => {
    invoked.mockClear();
    invoked.mockResolvedValue({ columns: [], rows: [], pk_column: null });
  });

  it("sends the table as a {schema, name} object", async () => {
    await invokeListTableRows("c1", { schema: "alt", name: "orders" }, { limit: 25 });
    expect(lastInvoke()[1]).toEqual({
      connectionId: "c1",
      table: { schema: "alt", name: "orders" },
      filter: [],
      orderBy: [],
      limit: 25,
      offset: 0,
    });
  });

  it("sends the same table shape to the count", async () => {
    invoked.mockResolvedValue(0);
    await invokeCountTableRows("c1", { schema: "alt", name: "orders" });
    expect(lastInvoke()[1]).toEqual({
      connectionId: "c1",
      table: { schema: "alt", name: "orders" },
      filter: [],
    });
  });

  it("sends the same table shape when watching", async () => {
    invoked.mockResolvedValue(undefined);
    await invokeSetWatchedTable("c1", { schema: "public", name: "orders" }, true);
    expect(lastInvoke()[1]).toEqual({
      connectionId: "c1",
      table: { schema: "public", name: "orders" },
      watched: true,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/lib/tauri.test.ts`
Expected: FAIL — the payload still carries a bare string.

- [ ] **Step 3: Add the type and update the wrappers**

In `apps/devbench/src/lib/tauri.ts`, add the type next to the other shared shapes:

```ts
/** Wire-compatible with the Rust `QualifiedTable`. A table's full identity —
 *  a bare name is ambiguous once more than one schema is in play. */
export interface QualifiedTable {
  schema: string;
  name: string;
}
```

Then change each wrapper's `table: string` parameter to `table: QualifiedTable`, passing it straight through in the payload — `invokeListTableRows`, `invokeCountTableRows`, `invokeSetWatchedTable`, `invokePreviewCellEdit`. Change `invokeListWatchedTables`'s return type to `Promise<QualifiedTable[]>`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test src/lib/tauri.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`tsc` will now report errors in `DbTab.tsx` and `SchemaTree.tsx`, which Task 5 fixes — do not fix them here, and do not run `bun run build` expecting it to be clean.

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/lib
git commit -m "feat(devbench): send tables as {schema, name} over IPC"
```

---

## Task 5: Frontend table identity

**Files:**
- Modify: `apps/devbench/src/components/db/SchemaTree.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`
- Modify: `apps/devbench/src/components/db/SchemaTree.test.tsx`

**Interfaces:**
- Consumes: `QualifiedTable` (Task 4)
- Produces: `SchemaTree` props `selected: QualifiedTable | null`, `watchedTables: Set<string>` keyed by `"schema.name"`, `onSelectTable: (table: QualifiedTable) => void`; `DbTab` tab state `{ table: { schema, name } }`

- [ ] **Step 1: Write the failing test**

Add to `apps/devbench/src/components/db/DbTab.test.tsx`:

```tsx
  it("fetches the selected table with its schema", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });

    renderDb({ schema: "alt", name: "orders" });

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        { schema: "alt", name: "orders" },
        expect.anything(),
      ),
    );
  });

  // A tab persisted before schemas existed stores a bare string. Resolving it
  // to public keeps the tab open across the upgrade instead of blanking it.
  it("reads a legacy bare table name as public", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });

    renderDb("orders" as unknown as tauriLib.QualifiedTable);

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        { schema: "public", name: "orders" },
        expect.anything(),
      ),
    );
  });
```

Adjust `renderDb`'s signature so it passes its argument through as the tab's `table` state — check the helper's current shape at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/DbTab.test.tsx`
Expected: FAIL — the call carries a bare string.

- [ ] **Step 3: Normalize legacy tab state in `DbTab`**

In `apps/devbench/src/components/db/DbTab.tsx`, change the prop type from `table: string | null` to `table: QualifiedTable | string | null`, and normalize once at the top of the component:

```tsx
/** Tab state persisted before schemas existed holds a bare name. Treat it as
 *  public rather than dropping the selection — the same assumption migration
 *  0007 makes for watched tables, for the same reason. */
function normalizeTable(table: QualifiedTable | string | null): QualifiedTable | null {
  if (table === null) return null;
  return typeof table === "string" ? { schema: "public", name: table } : table;
}
```

Use the normalized value everywhere the component currently uses `table`. Change `onPatchState` to write the object form, so a tab is rewritten to the new shape the first time it is touched.

- [ ] **Step 4: Carry the schema in the layout key**

In `DbTab.tsx`, change the layout key so two same-named tables in different schemas keep separate layouts:

```tsx
const layoutKey = `${activeConnectionId}:${table.schema}.${table.name}`;
```

Legacy keys are left to orphan — the cost is a one-time reset of saved column widths, pins and hidden columns, and `readLayout` already falls back to `EMPTY_LAYOUT` on a miss.

- [ ] **Step 5: Select qualified tables in `SchemaTree`**

In `apps/devbench/src/components/db/SchemaTree.tsx`, change the props:

```tsx
  selected: QualifiedTable | null;
  /** Keyed `"schema.name"` — a bare name can't distinguish two schemas. */
  watchedTables: Set<string>;
  onSelectTable: (table: QualifiedTable) => void;
```

In the list, compare and select on the full identity rather than the name:

```tsx
{tables.map((t) => {
  const key = `${t.schema}.${t.name}`;
  const isSelected = selected?.schema === t.schema && selected?.name === t.name;
  return (
    <div key={key} className={/* unchanged, using isSelected */}>
      <button
        type="button"
        aria-label={`Browse ${key}`}
        aria-current={isSelected}
        onClick={() => onSelectTable({ schema: t.schema, name: t.name })}
        className="flex-1 truncate text-left"
      >
        {t.name}
      </button>
      {/* watch toggle: key the watched lookup off `key`, and pass
          { schema: t.schema, name: t.name } to the toggle handler */}
```

The visible label stays `t.name` — the tree already groups by schema, so qualifying the label would be redundant. Only the accessible name carries the full identity, which is what makes two same-named rows distinguishable to assistive tech.

- [ ] **Step 6: Fix every remaining type error**

Run: `cd apps/devbench && bun run build 2>&1 | head -30`

Work through each `tsc` error — the watched-set construction, the toggle handler, and `SchemaTree.test.tsx`'s props are the expected ones. Repeat until clean.

- [ ] **Step 7: Run the full suite**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: all green, 388 → 393.

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src
git commit -m "feat(devbench): identify the selected table by schema and name"
```

---

## Task 6: End-to-end verification

**Files:**
- No source changes expected unless a check fails.

- [ ] **Step 1: Confirm both suites and the build**

```bash
cd apps/devbench && bun run test && bun run build
cd src-tauri && cargo test --lib
```

Expected: 393 frontend / 222 Rust, both clean. Record the actual numbers.

- [ ] **Step 2: Verify the collision end-to-end against a real database**

The unit test covers the impls; this confirms the whole path including the command layer and the store.

```bash
docker exec devbench-test-pg psql -U postgres -d devbench_test -c \
  "CREATE SCHEMA IF NOT EXISTS alt;
   DROP TABLE IF EXISTS public.dup; DROP TABLE IF EXISTS alt.dup;
   CREATE TABLE public.dup (id serial PRIMARY KEY, tag text);
   CREATE TABLE alt.dup (other_id serial PRIMARY KEY, tag text);
   INSERT INTO public.dup (tag) VALUES ('p1'),('p2');
   INSERT INTO alt.dup (tag) VALUES ('a1');"
```

Then run the app (`cd apps/devbench && bun run dev`, driven with the Playwright Tauri-stub approach from the Slice 1 plan's Task 13 if a real Tauri shell isn't available), select each `dup` in turn, and confirm: the grid shows 2 rows for `public.dup` and 1 for `alt.dup`; the pager's count matches each; and watching both produces two independent entries.

Record what you observed. Clean up:

```bash
docker exec devbench-test-pg psql -U postgres -d devbench_test -c \
  "DROP TABLE public.dup; DROP TABLE alt.dup; DROP SCHEMA alt;"
```

- [ ] **Step 3: Confirm no user-visible change for public-only work**

Select a table in `public`, and confirm sort, filter, paging, column pin/hide, cell edit and watch all behave exactly as before. This plan's whole claim is that it changes nothing for anyone working in `public`; that claim needs checking, not assuming.

- [ ] **Step 4: Commit any fixes**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench
git commit -m "fix(devbench): correct schema qualification against end-to-end checks"
```

---

## Self-Review

**1. Spec coverage.**

| Spec section | Task |
|---|---|
| §3 `QualifiedTable`, private fields, validating constructor | 1 |
| §3.1 Deserialization routes through the constructor | 1 |
| §4 Catalog lookups gain the schema predicate | 2 |
| §4 Query impls and commands take `QualifiedTable` | 2 |
| §4 `list_tables_impl` unchanged | — (no task touches it, as intended) |
| §5 Migration `0007`, `'public'` backfill with its rationale | 3 |
| §6 `tauri.ts` wrappers | 4 |
| §6 `SchemaTree` passes the whole object up | 5 |
| §6 `DbTab` holds `{schema, name}` | 5 |
| §6 Tab state legacy bare string → `public` | 5 |
| §6 Layout keys carry schema, legacy keys orphan | 5 |
| §7 Cross-schema collision test | 2 (unit), 6 (end-to-end) |
| §7 Schema-position injection rejected | 1 |
| §7 Deserialization rejects an invalid identifier | 1 |
| §7 Existing rows land on `public` | 3 |
| §8 Sequencing | Task order |

Two additions the spec didn't anticipate, both folded into Task 1: `validate_identifier`'s messages were hardcoded to "table name" and would misreport a rejected schema, so it gained a labelled variant; and `QualifiedTable` needs `Serialize` (Task 3, Step 4) because `list_watched_tables` now returns it.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the code. Task 6 has no new source by design — it is a verification gate, and its steps name the exact commands and observations rather than saying "check it works."

**3. Type consistency.** Checked across tasks:
- `QualifiedTable::new(schema, name) -> Result<Self, String>` — Task 1 produces; Tasks 2 and 3 consume with that exact argument order.
- `.quoted()` returns `"schema"."name"` — used identically in `db.rs`, `query.rs` and `correlation.rs`.
- `.schema()` / `.name()` — bound in that order in every catalog query; note `get_column_type` binds name as `$1` and schema as `$3` to keep `column` at `$2`.
- TS `QualifiedTable { schema, name }` (Task 4) matches the Rust wire shape `{schema, name}` (Task 1) field-for-field, in both directions, since the type both deserializes and serializes.
- `watchedTables: Set<string>` keyed `"schema.name"` — Task 5 constructs and reads it with the same expression.
