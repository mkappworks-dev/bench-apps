# Table View Slice 2 — Foreign Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a foreign key followable — a link icon on every FK cell, a popover showing the referenced row, and a jump that lands on that row in its own table.

**Architecture:** One `information_schema` + `pg_catalog` query per table yields every column's type, nullability, default, database-assigned flag and FK target in a single round trip (`describe_columns`), serving both this slice's link icons and Slice 3's insert panel. `get_referenced_row` resolves the target server-side from the referencing `(table, column)` pair, so the frontend never names an arbitrary table to read. On the frontend, `DbTab` fetches the metadata once per table and hands it to the grid; the jump is a pinned `column = value` filter applied through the existing table-switch path.

**Tech Stack:** Rust + sqlx (Postgres 17), Tauri 2 commands, React 18, Zustand, Tailwind v4, vitest + @testing-library/react, Playwright for anything positional.

**Spec:** `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` (§8 foreign keys, §13 backend commands, §5 columns, §17 slices).

## Global Constraints

- Visual source of truth: `docs/mockups/devbench-db-connections.html` (runnable; serve with `python3 -m http.server 8899` from `docs/mockups`). The FK parts are its `.fk-link` / `.fk-pop` rules and `renderFkPopover()`.
- Type scale from the mockup: `--fs-xs: 10.5px`, `--fs-sm: 12px`, `--fs-md: 13.5px`.
- Column and table identifiers are **validated** with `validate_identifier_labeled(kind, identifier)` before interpolation — the untyped `validate_identifier` wrapper was dropped in `d41bfed`, and every caller now names what it is validating so a rejected value sends the reader to the right input. Filter and lookup **values are always bound parameters** — never interpolated.
- jsdom has no layout engine. Never assert layout in vitest, and never write a test that appears to check layout but asserts nothing. Anything positional is verified in a real browser via Playwright with `getComputedStyle` / `getBoundingClientRect`, reporting measured numbers.
- **Baseline to keep green, measured on this worktree at `15ad0c3`:**
  - `cd apps/devbench && bun run test` → **407 passing / 44 files**
  - Concurrent sessions have moved this number three times while this plan was being written (402 → 406 → 407).
    **Re-measure immediately before each task and reconcile against that**, rather than trusting the absolute
    numbers below — they are a check, not an authority. If your measured baseline differs, the per-task delta
    (+11, +13, +1, +2, +8) is what must hold.
  - `cd apps/devbench && bun run build` → clean (runs `tsc` then `vite build`)
  - `cd apps/devbench/src-tauri && cargo test` → **228 passing, 1 ignored** (lib) and **6 passing** (`smoke_test`)
  - Run `cargo test`, **not** `cargo test --lib`. `--lib` does not compile `tests/*.rs` at all. Slice 2a used it as
    its gate and `tests/smoke_test.rs` sat broken through three tasks before anything noticed — it had stopped
    compiling the moment a command signature changed. `--lib` is fine for focused iteration on one module; it is
    not a suite gate. The repo's own README and PR template already say `cargo test`.
- Postgres for Rust tests: `localhost:5432`, `postgres`/`postgres`, db `devbench_test`, from this repo's own
  `docker-compose.yml` (`docker compose up -d postgres`). The container `devbench-test-pg` named in earlier plans
  no longer exists. `test_pool()` hardcodes port 5432 with no `PGPORT` override, so if another project holds 5432
  (`openstem-postgres` did during Slice 2a) that port must be freed first. Don't modify roles or auth.
- **There is no seeded schema.** `docker-compose.yml` creates an empty `devbench_test`; every Rust test in this codebase creates and drops its own fixtures (see `db.rs`'s `orders_for_test`, `dup_ipc`, `alt_ipc`). Follow that. Because cargo runs tests in one process against one shared database concurrently, **every test must use fixture names unique to itself** — two tests sharing `fk_orders` will race and fail intermittently.
- Tauri commands are registered in **`src-tauri/src/main.rs`** (`tauri::generate_handler![…]`), not `lib.rs`. The Slice 1 plan said `lib.rs`; that was wrong.
- These four grid behaviours are regression-critical and must still hold after every task: sticky header stays aligned with body columns under horizontal scroll; virtualization keeps rendering rows; horizontal scroll stays contained (`document.documentElement.scrollWidth === clientWidth`); NULL stays visually distinct from `<unsupported type>`.
- `renderCell` must keep receiving the **data** column index and the **unfiltered** row index. A reorder or filter that shifts either sends an edit to the wrong cell. Both are covered by existing tests in `DataGrid.test.tsx` and `DbTab.test.tsx`; keep them passing.
- Accessibility must not regress: accessible names on buttons, `aria-sort` on sorted headers, `aria-pressed` where present. The FK popover needs a real dialog role and an accessible name.
- **Out of scope for this plan — do not start these, and do not "improve" them in passing:** insert panel, row delete, pending changes, boolean *toggling* (Slice 3); rail segments and queries-as-tabs (Slice 4).
- **Leave the query console drawer exactly as it is.** Slice 4 removes it. Tasks 6–8 rewrite parts of `DbTab`, which holds `consoleOpen` and renders `<QueryConsole>` — leave both untouched.
- **`cellDisplay`'s boolean value-sniffing in `DataGrid.tsx` stays.** Spec §7 defers replacing it ("that is a follow-up, not part of this design"); it only matters once booleans become interactive in Slice 3. This slice replaces `inferFamily` — the *filter operator* inference named in §17 — and nothing else.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src-tauri/src/commands/db_columns.rs` | `ColumnInfo` / `ForeignKeyRef`, `describe_columns`, `get_referenced_row`. Column metadata and FK resolution; sits beside `db_filter.rs`. |
| `src/components/db/grid/columnMeta.ts` | TS mirror of `ColumnInfo`, udt→family mapping, per-column lookups. Pure. |
| `src/components/db/grid/FkPopover.tsx` | The always-visible link button and the referenced-row popover. |

**Modified**

| File | Change |
|---|---|
| `src-tauri/src/commands/mod.rs` | Register `db_columns`. |
| `src-tauri/src/main.rs` | Register `describe_columns` and `get_referenced_row`. |
| `src/lib/tauri.ts` | `invokeDescribeColumns`, `invokeGetReferencedRow`, re-export the metadata types. |
| `src/components/db/grid/types.ts` | `inferFamily` deleted (replaced by the real column type). |
| `src/components/db/grid/ColumnsPopover.tsx` | `Reset layout` moves into the footer's empty right slot. |
| `src/components/db/grid/GridToolbar.tsx` | Passes `onReset` to `ColumnsPopover`. |
| `src/components/db/DataGrid.tsx` | The full-width `Reset layout` strip and `layoutIsCustomised` are deleted. |
| `src/components/db/DbTab.tsx` | Fetches column metadata; real filter families; FK link + popover in `renderCell`; the jump. |
| `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` | §5 documents Reset layout; §13 corrects the `describe_columns` query source and `is_identity`'s meaning. |

---

## Task 1: `describe_columns` (Rust)

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/db_columns.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Modify: `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` (§13, §17)

**Interfaces:**
- Consumes: `crate::commands::qualified_table::QualifiedTable` (`::new`, `.schema()`, `.name()`, `.quoted()`), `crate::connection_registry::ConnectionRegistry`, `crate::local_db::LocalDb`, `crate::secrets::SecretStore`
- Produces:
  - `pub struct ForeignKeyRef { pub schema: String, pub table: String, pub column: String }` (Serialize + Deserialize + PartialEq)
  - `pub struct ColumnInfo { pub name: String, pub udt: String, pub nullable: bool, pub default_expr: Option<String>, pub is_identity: bool, pub references: Option<ForeignKeyRef> }` (Serialize + PartialEq)
  - `pub async fn describe_columns_impl(pool: &PgPool, table: &QualifiedTable) -> Result<Vec<ColumnInfo>, String>`
  - `const DESCRIBE_COLUMNS_SQL: &str` — private to this module. It holds the
    whole-table description query. **It is not `FK_TARGET_SQL`**: Task 2 defines
    that separately for a different, single-column query, and giving this one
    that name would both misdescribe its contents and collide with Task 2.
  - Tauri command `describe_columns(connection_id, table)`

- [ ] **Step 1: Register the new module**

In `apps/devbench/src-tauri/src/commands/mod.rs`, add alongside `pub mod db_filter;`:

```rust
pub mod db_columns;
```

Keep the list alphabetical: `db_columns` goes between `db` and `db_filter`.

- [ ] **Step 2: Write the failing tests**

Create `apps/devbench/src-tauri/src/commands/db_columns.rs` containing only this
test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Each test module in this codebase builds its own pool (see db.rs:326 and
    // correlation.rs:432); there is no shared helper to import.
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

    fn find<'a>(cols: &'a [ColumnInfo], name: &str) -> &'a ColumnInfo {
        cols.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no column {name}"))
    }

    // Fixture names are unique per test on purpose: cargo runs these
    // concurrently against one shared database, so two tests sharing a table
    // name would race and fail intermittently.
    #[tokio::test]
    async fn reports_type_nullability_default_and_identity() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS dc_meta").execute(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE dc_meta (
               id serial PRIMARY KEY,
               status text NOT NULL DEFAULT 'pending',
               amount numeric,
               paid boolean DEFAULT false,
               created_at timestamptz NOT NULL DEFAULT now()
             )",
        )
        .execute(&pool).await.unwrap();

        let cols = describe_columns_impl(&pool, &public("dc_meta")).await.unwrap();

        // Order is the table's own column order, which is what the insert
        // panel renders its fields in.
        assert_eq!(
            cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["id", "status", "amount", "paid", "created_at"],
        );

        let id = find(&cols, "id");
        assert_eq!(id.udt, "int4");
        assert!(!id.nullable);
        // A serial is not an IDENTITY column, but the database still assigns
        // its value. Reporting it as user-editable would put an editable `id`
        // field in every insert form.
        assert!(id.is_identity, "a serial column is database-assigned");
        assert!(id.default_expr.as_deref().unwrap().starts_with("nextval("));

        let status = find(&cols, "status");
        assert_eq!(status.udt, "text");
        assert!(!status.nullable);
        assert!(!status.is_identity);
        assert_eq!(status.default_expr.as_deref(), Some("'pending'::text"));

        let amount = find(&cols, "amount");
        assert_eq!(amount.udt, "numeric");
        assert!(amount.nullable);
        assert_eq!(amount.default_expr, None);

        assert_eq!(find(&cols, "paid").udt, "bool");
        assert_eq!(find(&cols, "created_at").udt, "timestamptz");
        assert_eq!(find(&cols, "created_at").default_expr.as_deref(), Some("now()"));

        sqlx::query("DROP TABLE dc_meta").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn reports_the_foreign_key_target_per_column() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS dc_fk_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS dc_fk_customers").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE dc_fk_customers (id serial PRIMARY KEY, email text)")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE dc_fk_orders (
               id serial PRIMARY KEY,
               customer_id int NOT NULL REFERENCES dc_fk_customers(id),
               status text
             )",
        )
        .execute(&pool).await.unwrap();

        let cols = describe_columns_impl(&pool, &public("dc_fk_orders")).await.unwrap();

        assert_eq!(
            find(&cols, "customer_id").references,
            Some(ForeignKeyRef {
                schema: "public".into(),
                table: "dc_fk_customers".into(),
                column: "id".into(),
            }),
        );
        // A column with no key must report None, or every cell in the grid
        // would sprout a link icon.
        assert_eq!(find(&cols, "status").references, None);
        assert_eq!(find(&cols, "id").references, None);

        sqlx::query("DROP TABLE dc_fk_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE dc_fk_customers").execute(&pool).await.unwrap();
    }

    // The reason this query reads pg_catalog rather than
    // information_schema.constraint_column_usage: that view reports a
    // constraint's referenced columns with no ordinal, so a two-column key
    // cross-joins — measured against Postgres 17.9, `ck_a` comes back claiming
    // BOTH `dc_ck.a` and `dc_ck.b`. Through a LEFT JOIN onto
    // information_schema.columns that also duplicates the column rows, so a
    // 4-column table would describe as 6 columns. conkey[i] <-> confkey[i]
    // pairs by ordinal exactly.
    #[tokio::test]
    async fn pairs_a_composite_foreign_key_by_ordinal_not_by_cross_join() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS dc_ck_items").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS dc_ck").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE dc_ck (a int, b int, PRIMARY KEY (a, b))")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE dc_ck_items (
               id serial PRIMARY KEY,
               ck_a int, ck_b int,
               FOREIGN KEY (ck_a, ck_b) REFERENCES dc_ck(a, b)
             )",
        )
        .execute(&pool).await.unwrap();

        let cols = describe_columns_impl(&pool, &public("dc_ck_items")).await.unwrap();

        // One row per column — not one row per (column x referenced column).
        assert_eq!(cols.len(), 3, "a 3-column table must describe as 3 columns");
        assert_eq!(find(&cols, "ck_a").references.as_ref().unwrap().column, "a");
        assert_eq!(find(&cols, "ck_b").references.as_ref().unwrap().column, "b");

        sqlx::query("DROP TABLE dc_ck_items").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE dc_ck").execute(&pool).await.unwrap();
    }

    // Two tables can hold the same column name in different schemas; the
    // description must be of the table that was asked for.
    #[tokio::test]
    async fn describes_the_named_schemas_table_not_a_same_named_one() {
        let pool = test_pool().await;
        sqlx::query("CREATE SCHEMA IF NOT EXISTS dc_alt").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS public.dc_dup").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS dc_alt.dc_dup").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE public.dc_dup (id serial PRIMARY KEY, only_here text)")
            .execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE dc_alt.dc_dup (other_id serial PRIMARY KEY, elsewhere int)")
            .execute(&pool).await.unwrap();

        let p = describe_columns_impl(&pool, &public("dc_dup")).await.unwrap();
        assert_eq!(p.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["id", "only_here"]);

        let a = describe_columns_impl(&pool, &QualifiedTable::new("dc_alt", "dc_dup").unwrap())
            .await.unwrap();
        assert_eq!(a.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["other_id", "elsewhere"]);

        sqlx::query("DROP TABLE public.dc_dup").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE dc_alt.dc_dup").execute(&pool).await.unwrap();
        sqlx::query("DROP SCHEMA dc_alt").execute(&pool).await.unwrap();
    }

    // An unknown table is an empty description, not an error: the grid asks
    // for metadata for whatever table is selected, and a table dropped out
    // from under it must degrade to "no metadata", not to a broken tab.
    #[tokio::test]
    async fn an_unknown_table_describes_as_no_columns() {
        let pool = test_pool().await;
        let cols = describe_columns_impl(&pool, &public("dc_no_such_table")).await.unwrap();
        assert!(cols.is_empty());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd apps/devbench/src-tauri && cargo test --lib db_columns 2>&1 | tail -20
```

Expected: compilation errors — `cannot find function describe_columns_impl`,
`cannot find type ColumnInfo`, `cannot find type ForeignKeyRef`.

- [ ] **Step 4: Write the implementation**

Insert this **above** the `#[cfg(test)] mod tests` block in
`apps/devbench/src-tauri/src/commands/db_columns.rs`:

```rust
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use tauri::State;

use crate::commands::qualified_table::QualifiedTable;
use crate::connection_registry::ConnectionRegistry;
use crate::local_db::LocalDb;
use crate::secrets::SecretStore;

/// Where one column points. Always a single column: a composite key
/// contributes one `ForeignKeyRef` per member column, each paired to its own
/// opposite number, so following any one of them is still a single-column
/// lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForeignKeyRef {
    pub schema: String,
    pub table: String,
    pub column: String,
}

/// Everything the grid and the insert panel need to know about one column,
/// from one query. Fetched once per table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    /// Postgres physical type name (`pg_type.typname`): `int4`, `text`,
    /// `bool`, `timestamptz`. The same vocabulary `get_column_type` returns.
    pub udt: String,
    pub nullable: bool,
    pub default_expr: Option<String>,
    /// "The database assigns this value" — true for a `GENERATED ... AS
    /// IDENTITY` column, a `GENERATED ALWAYS` computed column, AND a `serial`
    /// (whose default is a `nextval(...)` call). Deliberately broader than
    /// `information_schema.is_identity`, which is false for a serial: spec §9
    /// renders all three read-only with "assigned by the database", and a
    /// literal reading would put an editable `id` field in every insert form.
    pub is_identity: bool,
    pub references: Option<ForeignKeyRef>,
}

// Every projected column is cast to `text` rather than left as
// information_schema's `sql_identifier`/`character_data` domains or
// pg_catalog's `name` — sqlx decodes by type OID, and a domain carries its own
// OID rather than its base type's.
//
// The FK half reads pg_catalog, not information_schema's constraint views:
// `constraint_column_usage` reports a constraint's referenced columns without
// an ordinal, so a two-column key cross-joins into four rows and each
// referencing column claims both referenced columns. `conkey[i]` <->
// `confkey[i]` pairs by position exactly. `DISTINCT ON` picks one target when a
// column carries more than one FK constraint (legal in Postgres), so a column
// can never duplicate its own row.
const DESCRIBE_COLUMNS_SQL: &str = "\
SELECT
  c.column_name::text    AS column_name,
  c.udt_name::text       AS udt_name,
  c.is_nullable = 'YES'  AS nullable,
  c.column_default::text AS column_default,
  (c.is_identity = 'YES'
     OR c.is_generated = 'ALWAYS'
     OR COALESCE(c.column_default LIKE 'nextval(%', false)) AS db_assigned,
  fk.ref_schema, fk.ref_table, fk.ref_column
FROM information_schema.columns c
LEFT JOIN (
  SELECT DISTINCT ON (src_ns.nspname, src.relname, src_att.attname)
    src_ns.nspname::text  AS src_schema,
    src.relname::text     AS src_table,
    src_att.attname::text AS src_column,
    tgt_ns.nspname::text  AS ref_schema,
    tgt.relname::text     AS ref_table,
    tgt_att.attname::text AS ref_column
  FROM pg_constraint con
  JOIN pg_class     src    ON src.oid = con.conrelid
  JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
  JOIN pg_class     tgt    ON tgt.oid = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
  JOIN LATERAL generate_subscripts(con.conkey, 1) AS k(i) ON TRUE
  JOIN pg_attribute src_att ON src_att.attrelid = con.conrelid  AND src_att.attnum = con.conkey[k.i]
  JOIN pg_attribute tgt_att ON tgt_att.attrelid = con.confrelid AND tgt_att.attnum = con.confkey[k.i]
  WHERE con.contype = 'f'
  ORDER BY src_ns.nspname, src.relname, src_att.attname, con.conname
) fk
  ON  fk.src_schema = c.table_schema
  AND fk.src_table  = c.table_name
  AND fk.src_column = c.column_name
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position";

pub async fn describe_columns_impl(
    pool: &PgPool,
    table: &QualifiedTable,
) -> Result<Vec<ColumnInfo>, String> {
    let rows = sqlx::query(DESCRIBE_COLUMNS_SQL)
        .bind(table.schema())
        .bind(table.name())
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to describe {table}: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| {
            // ref_table is NULL for every column without a key, and the three
            // ref_* columns are NULL or non-NULL together — they come from one
            // LEFT JOIN — so one of them decides whether there is a target.
            let ref_table: Option<String> = r.get("ref_table");
            ColumnInfo {
                name: r.get("column_name"),
                udt: r.get("udt_name"),
                nullable: r.get("nullable"),
                default_expr: r.get("column_default"),
                is_identity: r.get("db_assigned"),
                references: ref_table.map(|table| ForeignKeyRef {
                    schema: r.get("ref_schema"),
                    table,
                    column: r.get("ref_column"),
                }),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn describe_columns(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
    table: QualifiedTable,
) -> Result<Vec<ColumnInfo>, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    describe_columns_impl(&pool, &table).await
}
```

- [ ] **Step 5: Register the command**

In `apps/devbench/src-tauri/src/main.rs`, inside `tauri::generate_handler![…]`,
add directly after `commands::db::count_table_rows,`:

```rust
            commands::db_columns::describe_columns,
```

- [ ] **Step 5b: Correct the spec's account of this query**

Spec §13's comment describes a join this implementation deliberately does not
make, and names a field whose meaning is broader than it reads. Leaving it
would send the next reader to a query that mis-pairs composite keys.

In `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` §13,
replace the comment and struct at the top of the code block:

```rust
// One query serving two features: information_schema.columns joined to the FK
// constraint views yields type/nullable/default/identity AND the referenced
// table/column per column. Fetched once per table.
describe_columns(connection_id, table) -> Vec<ColumnInfo>

struct ColumnInfo {
  name: String, udt: String, nullable: bool,
  default_expr: Option<String>, is_identity: bool,
  references: Option<ForeignKeyRef>,   // { schema, table, column }
}
```

with:

```rust
// One query serving two features: information_schema.columns for
// type/nullable/default/identity, LEFT JOINed to a pg_catalog subquery for the
// referenced table/column per column. Fetched once per table.
//
// pg_catalog rather than information_schema's constraint views because
// constraint_column_usage reports a constraint's referenced columns with no
// ordinal: a two-column key cross-joins, so each referencing column claims
// every referenced column, and the LEFT JOIN duplicates the column rows on top
// of that. pg_constraint.conkey[i] <-> confkey[i] pairs by position exactly.
describe_columns(connection_id, table) -> Vec<ColumnInfo>

struct ColumnInfo {
  name: String, udt: String, nullable: bool,
  default_expr: Option<String>,
  is_identity: bool,                   // "the database assigns this": IDENTITY,
                                       // GENERATED ALWAYS, or a serial's
                                       // nextval() default. Broader than
                                       // information_schema.is_identity, which
                                       // is false for a serial — §9 renders all
                                       // three read-only, and a literal reading
                                       // would put an editable id in every
                                       // insert form.
  references: Option<ForeignKeyRef>,   // { schema, table, column }
}
```

Then, in §17, replace the line:

```markdown
**The implementation plan covers Slice 1 only.** Slices 2 and 3 get their own
plans once Slice 1 is merged and its assumptions have survived contact.
```

with:

```markdown
**Each slice gets its own plan, written once its predecessor has survived
contact.** Slice 1: `docs/superpowers/plans/2026-08-02-table-view-slice-1-toolbar.md`.
Slice 2: `docs/superpowers/plans/2026-08-02-table-view-slice-2-foreign-keys.md`.
Slices 3 and 4 are not planned yet.
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
docker start devbench-test-pg
cd apps/devbench/src-tauri && cargo test --lib db_columns 2>&1 | tail -20
```

Expected: 5 passing.

Then the whole suite, which must be the baseline plus these 5:

```bash
cd apps/devbench/src-tauri && cargo test 2>&1 | tail -20
```

Expected: the measured lib baseline **+ 5**, 1 ignored (228 + 5 = 233 if the baseline is unchanged). Report both.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/src/commands/db_columns.rs apps/devbench/src-tauri/src/commands/mod.rs apps/devbench/src-tauri/src/main.rs docs/superpowers/specs/2026-08-02-devbench-table-view-design.md
git commit -m "feat(devbench): describe a table's columns, types and foreign keys in one query"
```

---

## Task 2: `get_referenced_row` (Rust)

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/db_columns.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `ForeignKeyRef` and the pg_catalog FK pairing from Task 1; `crate::commands::db::{TableRows, cell_to_string, get_column_type, get_primary_key_column, validate_identifier_labeled}`
- Produces:
  - `pub async fn get_referenced_row_impl(pool: &PgPool, table: &QualifiedTable, column: &str, value: &str) -> Result<Option<TableRows>, String>`
  - `pub(crate) async fn fk_target_of(pool: &PgPool, table: &QualifiedTable, column: &str) -> Result<Option<ForeignKeyRef>, String>`
  - Tauri command `get_referenced_row(connection_id, table, column, value)`

The `table` and `column` arguments are the **referencing** pair — the cell the
user clicked. The target is resolved server-side rather than sent by the
frontend, so the command can only ever read a table this table genuinely points
at.

- [ ] **Step 1: Write the failing tests**

Append these to the existing `mod tests` block in
`apps/devbench/src-tauri/src/commands/db_columns.rs`:

```rust
    #[tokio::test]
    async fn fetches_the_row_a_foreign_key_points_at() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS gr_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS gr_customers").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE gr_customers (id serial PRIMARY KEY, email text, status text)")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE gr_orders (
               id serial PRIMARY KEY,
               customer_id int NOT NULL REFERENCES gr_customers(id)
             )",
        )
        .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO gr_customers (email, status) VALUES ('grace@example.com', 'active')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO gr_orders (customer_id) VALUES (1)").execute(&pool).await.unwrap();

        let found = get_referenced_row_impl(&pool, &public("gr_orders"), "customer_id", "1")
            .await
            .unwrap()
            .expect("customer 1 exists");

        assert_eq!(found.columns, vec!["id", "email", "status"]);
        assert_eq!(found.rows.len(), 1, "a key points at exactly one row");
        assert_eq!(
            found.rows[0],
            vec![Some("1".to_string()), Some("grace@example.com".to_string()), Some("active".to_string())],
        );
        assert_eq!(found.pk_column.as_deref(), Some("id"));

        sqlx::query("DROP TABLE gr_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE gr_customers").execute(&pool).await.unwrap();
    }

    // Spec §8: a key pointing nowhere is a fact to state, not an error and not
    // an empty card. `Ok(None)` is what lets the popover say "No matching row
    // in ..." rather than rendering a failure.
    #[tokio::test]
    async fn a_key_pointing_nowhere_is_none_not_an_error() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS gr_dangling_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS gr_dangling_customers").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE gr_dangling_customers (id serial PRIMARY KEY, email text)")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE gr_dangling_orders (
               id serial PRIMARY KEY,
               customer_id int REFERENCES gr_dangling_customers(id)
             )",
        )
        .execute(&pool).await.unwrap();

        // 4242 is a legal value for the column and simply matches nothing.
        let missing =
            get_referenced_row_impl(&pool, &public("gr_dangling_orders"), "customer_id", "4242")
                .await
                .unwrap();
        assert!(missing.is_none(), "no matching row must be Ok(None), not Err");

        sqlx::query("DROP TABLE gr_dangling_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE gr_dangling_customers").execute(&pool).await.unwrap();
    }

    // Nothing in the UI can reach this — the link icon only renders on a
    // column that has a target — so it is a programming error and must say so
    // rather than silently returning None, which would read as "no such row".
    #[tokio::test]
    async fn a_column_with_no_foreign_key_is_an_error() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS gr_plain").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE gr_plain (id serial PRIMARY KEY, note text)")
            .execute(&pool).await.unwrap();

        let err = get_referenced_row_impl(&pool, &public("gr_plain"), "note", "x")
            .await
            .unwrap_err();
        assert!(err.contains("note"), "the error must name the column, got: {err}");
        assert!(err.contains("foreign key"), "the error must say what is missing, got: {err}");

        sqlx::query("DROP TABLE gr_plain").execute(&pool).await.unwrap();
    }

    // The value arrives from the frontend as a string, because every grid cell
    // is a string by the time it is rendered. It must never be interpolated —
    // it is bound and cast to the referenced column's own type.
    #[tokio::test]
    async fn the_lookup_value_is_bound_not_interpolated() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS gr_inject_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS gr_inject_customers").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE gr_inject_customers (id text PRIMARY KEY, email text)")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE gr_inject_orders (
               id serial PRIMARY KEY,
               customer_id text REFERENCES gr_inject_customers(id)
             )",
        )
        .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO gr_inject_customers (id, email) VALUES ('usr_88', 'a@b.c')")
            .execute(&pool).await.unwrap();

        // If this were interpolated it would end the string literal and drop a
        // table. Bound, it is simply a value that matches nothing.
        let payload = "usr_88'; DROP TABLE gr_inject_customers; --";
        let found =
            get_referenced_row_impl(&pool, &public("gr_inject_orders"), "customer_id", payload)
                .await
                .unwrap();
        assert!(found.is_none());

        // The proof it was bound: the table the payload named is still there.
        let survived = get_referenced_row_impl(&pool, &public("gr_inject_orders"), "customer_id", "usr_88")
            .await
            .unwrap();
        assert!(survived.is_some(), "the referenced table must still exist");

        sqlx::query("DROP TABLE gr_inject_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE gr_inject_customers").execute(&pool).await.unwrap();
    }

    // The jump needs the target's schema, not just its name — the referenced
    // table may live in a different schema than the referencing one.
    #[tokio::test]
    async fn resolves_a_target_in_another_schema() {
        let pool = test_pool().await;
        sqlx::query("CREATE SCHEMA IF NOT EXISTS gr_ref").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS public.gr_xs_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS gr_ref.gr_xs_customers").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE gr_ref.gr_xs_customers (id serial PRIMARY KEY, email text)")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE public.gr_xs_orders (
               id serial PRIMARY KEY,
               customer_id int REFERENCES gr_ref.gr_xs_customers(id)
             )",
        )
        .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO gr_ref.gr_xs_customers (email) VALUES ('cross@example.com')")
            .execute(&pool).await.unwrap();

        let target = fk_target_of(&pool, &public("gr_xs_orders"), "customer_id").await.unwrap();
        assert_eq!(
            target,
            Some(ForeignKeyRef {
                schema: "gr_ref".into(),
                table: "gr_xs_customers".into(),
                column: "id".into(),
            }),
        );

        let found = get_referenced_row_impl(&pool, &public("gr_xs_orders"), "customer_id", "1")
            .await.unwrap().expect("the cross-schema row exists");
        assert_eq!(found.rows[0][1], Some("cross@example.com".to_string()));

        sqlx::query("DROP TABLE public.gr_xs_orders").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE gr_ref.gr_xs_customers").execute(&pool).await.unwrap();
        sqlx::query("DROP SCHEMA gr_ref").execute(&pool).await.unwrap();
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/devbench/src-tauri && cargo test --lib db_columns 2>&1 | tail -20
```

Expected: compilation errors — `cannot find function get_referenced_row_impl`,
`cannot find function fk_target_of`.

- [ ] **Step 3: Write the implementation**

Add to the `use` block at the top of `db_columns.rs`:

```rust
use crate::commands::db::{
    cell_to_string, get_column_type, get_primary_key_column, validate_identifier_labeled, TableRows,
};
```

Then add, above the test module:

```rust
// The single-column form of DESCRIBE_COLUMNS_SQL's FK subquery. Same
// conkey[i] <-> confkey[i] ordinal pairing, narrowed to one column so the
// popover does not describe a whole table to follow one key.
pub(crate) const FK_TARGET_SQL: &str = "\
SELECT
  tgt_ns.nspname::text  AS ref_schema,
  tgt.relname::text     AS ref_table,
  tgt_att.attname::text AS ref_column
FROM pg_constraint con
JOIN pg_class     src    ON src.oid = con.conrelid
JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
JOIN pg_class     tgt    ON tgt.oid = con.confrelid
JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
JOIN LATERAL generate_subscripts(con.conkey, 1) AS k(i) ON TRUE
JOIN pg_attribute src_att ON src_att.attrelid = con.conrelid  AND src_att.attnum = con.conkey[k.i]
JOIN pg_attribute tgt_att ON tgt_att.attrelid = con.confrelid AND tgt_att.attnum = con.confkey[k.i]
WHERE con.contype = 'f'
  AND src_ns.nspname = $1
  AND src.relname    = $2
  AND src_att.attname = $3
ORDER BY con.conname
LIMIT 1";

pub(crate) async fn fk_target_of(
    pool: &PgPool,
    table: &QualifiedTable,
    column: &str,
) -> Result<Option<ForeignKeyRef>, String> {
    let row = sqlx::query(FK_TARGET_SQL)
        .bind(table.schema())
        .bind(table.name())
        .bind(column)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("failed to resolve the foreign key on {table}.{column}: {e}"))?;

    Ok(row.map(|r| ForeignKeyRef {
        schema: r.get("ref_schema"),
        table: r.get("ref_table"),
        column: r.get("ref_column"),
    }))
}

/// The referenced row for one cell. `table` and `column` name the cell the
/// user clicked — the *referencing* side — and the target is resolved from the
/// catalog here rather than accepted from the caller, so this command can only
/// read a table the named one actually points at.
pub async fn get_referenced_row_impl(
    pool: &PgPool,
    table: &QualifiedTable,
    column: &str,
    value: &str,
) -> Result<Option<TableRows>, String> {
    validate_identifier_labeled("column", column)?;

    let target = fk_target_of(pool, table, column)
        .await?
        .ok_or_else(|| format!("column {column} on table {table} has no foreign key to follow"))?;

    // Rebuilding the target through the validating constructor rather than
    // formatting the catalog strings straight into SQL: it is the only path by
    // which a table reaches a query anywhere else in this codebase, and
    // keeping it so means there is no second, weaker path to audit.
    let target_table = QualifiedTable::new(&target.schema, &target.table)?;
    validate_identifier_labeled("referenced column", &target.column)?;

    // Cast the bound value to the referenced column's own type rather than
    // casting the column — `WHERE col::text = $1` is non-sargable and forces a
    // seq scan even on the indexed key this lookup exists to use. Same shape
    // as query.rs's cell-edit path.
    let target_type = get_column_type(pool, &target_table, &target.column).await?;
    validate_identifier_labeled("referenced column type", &target_type)?;

    let sql = format!(
        "SELECT * FROM {} WHERE \"{}\" = $1::{} LIMIT 1",
        target_table.quoted(),
        target.column,
        target_type,
    );

    let row = sqlx::query(&sql)
        .bind(value)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("failed to read {target_table}: {e}"))?;

    let Some(row) = row else { return Ok(None) };

    use sqlx::Column as _;
    let columns: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
    let values = (0..columns.len()).map(|i| cell_to_string(&row, i)).collect();

    // The popover does not use pk_column, but TableRows carries it and every
    // other producer fills it the same way — leaving it None here would make
    // the type mean something different depending on who built it.
    let pk_column = get_primary_key_column(pool, &target_table).await.ok();

    Ok(Some(TableRows { columns, rows: vec![values], pk_column }))
}

#[tauri::command]
pub async fn get_referenced_row(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
    table: QualifiedTable,
    column: String,
    value: String,
) -> Result<Option<TableRows>, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    get_referenced_row_impl(&pool, &table, &column, &value).await
}
```

- [ ] **Step 4: Register the command**

In `apps/devbench/src-tauri/src/main.rs`, directly after
`commands::db_columns::describe_columns,`:

```rust
            commands::db_columns::get_referenced_row,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/devbench/src-tauri && cargo test --lib db_columns 2>&1 | tail -20
```

Expected: 10 passing.

```bash
cd apps/devbench/src-tauri && cargo test 2>&1 | tail -20
```

Expected: the measured lib baseline **+ 10**, 1 ignored (228 + 10 = 238 if unchanged). Report both.

- [ ] **Step 6: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/src/commands/db_columns.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): fetch the row a foreign key points at"
```

---

## Task 3: Frontend column metadata and Tauri wrappers

**Files:**
- Create: `apps/devbench/src/components/db/grid/columnMeta.ts`
- Create: `apps/devbench/src/components/db/grid/columnMeta.test.ts`
- Modify: `apps/devbench/src/lib/tauri.ts`

**Interfaces:**
- Consumes: `ColumnFamily` from `./types` (Slice 1); the Rust `ColumnInfo` wire shape from Task 1; `get_referenced_row` from Task 2
- Produces:
  - `interface ForeignKeyRef { schema: string; table: string; column: string }`
  - `interface ColumnInfo { name: string; udt: string; nullable: boolean; default_expr: string | null; is_identity: boolean; references: ForeignKeyRef | null }`
  - `familyOfUdt(udt: string): ColumnFamily`
  - `columnInfoOf(meta: ColumnInfo[], column: string): ColumnInfo | null`
  - `familyOfColumn(meta: ColumnInfo[], column: string): ColumnFamily`
  - `fkTargetOf(meta: ColumnInfo[], column: string): ForeignKeyRef | null`
  - `canFollow(meta: ColumnInfo[], column: string, value: string | null): boolean`
  - `describeTarget(target: ForeignKeyRef): string`
  - `invokeDescribeColumns(connectionId, table): Promise<ColumnInfo[]>`
  - `invokeGetReferencedRow(connectionId, table, column, value): Promise<TableRows | null>`

This task is purely additive — `inferFamily` stays until Task 6 replaces its
only call site, so nothing is left half-wired between tasks.

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/db/grid/columnMeta.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  canFollow,
  columnInfoOf,
  describeTarget,
  familyOfColumn,
  familyOfUdt,
  fkTargetOf,
  type ColumnInfo,
} from "./columnMeta";

function col(name: string, udt: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    udt,
    nullable: true,
    default_expr: null,
    is_identity: false,
    references: null,
    ...extra,
  };
}

const META: ColumnInfo[] = [
  col("id", "int4", { nullable: false, is_identity: true, default_expr: "nextval('o_id_seq'::regclass)" }),
  col("user_id", "text", {
    nullable: false,
    references: { schema: "public", table: "users", column: "id" },
  }),
  col("amount", "numeric"),
  col("paid", "bool", { default_expr: "false" }),
  col("created_at", "timestamptz", { nullable: false, default_expr: "now()" }),
  col("notes", "text"),
];

describe("familyOfUdt", () => {
  it("maps a boolean column to the boolean operator set", () => {
    expect(familyOfUdt("bool")).toBe("boolean");
  });

  // Spec §4 gives numerics and dates one operator set, because > and < mean
  // something for both. The family names the operator set, not a JS type.
  it("maps numerics and dates alike to the ordered operator set", () => {
    for (const udt of ["int2", "int4", "int8", "float8", "numeric", "money"]) {
      expect(familyOfUdt(udt)).toBe("number");
    }
    for (const udt of ["date", "timestamp", "timestamptz", "time", "timetz"]) {
      expect(familyOfUdt(udt)).toBe("number");
    }
  });

  it("falls back to text for anything it does not recognise", () => {
    expect(familyOfUdt("text")).toBe("text");
    expect(familyOfUdt("uuid")).toBe("text");
    expect(familyOfUdt("jsonb")).toBe("text");
  });
});

describe("familyOfColumn", () => {
  // This is the whole point of the slice's type work: Slice 1 sniffed the
  // family out of a sample value, so a text column holding "42" offered
  // numeric operators and a text column holding "true" offered boolean ones.
  it("reads the real type rather than sniffing a value", () => {
    expect(familyOfColumn(META, "amount")).toBe("number");
    expect(familyOfColumn(META, "paid")).toBe("boolean");
    // Its VALUES are digits, but the column is text — `contains` belongs here,
    // `>` does not.
    expect(familyOfColumn(META, "user_id")).toBe("text");
  });

  // Metadata can be missing: an older server, a permissions error, or the
  // first render before the fetch lands. Text is the safe default — its
  // operator set is the one that works on any column.
  it("defaults to text when the column has no metadata", () => {
    expect(familyOfColumn(META, "not_a_column")).toBe("text");
    expect(familyOfColumn([], "amount")).toBe("text");
  });
});

describe("fkTargetOf and canFollow", () => {
  it("reports a target only for a column that has one", () => {
    expect(fkTargetOf(META, "user_id")).toEqual({ schema: "public", table: "users", column: "id" });
    expect(fkTargetOf(META, "notes")).toBeNull();
    expect(fkTargetOf(META, "id")).toBeNull();
  });

  it("follows a real value on a keyed column", () => {
    expect(canFollow(META, "user_id", "usr_88")).toBe(true);
  });

  // Spec §8: the icon describes data you can follow. These two follow nowhere.
  it("does not follow NULL or an undecodable value", () => {
    expect(canFollow(META, "user_id", null)).toBe(false);
    expect(canFollow(META, "user_id", "<unsupported type>")).toBe(false);
  });

  it("does not follow a column with no key", () => {
    expect(canFollow(META, "notes", "anything")).toBe(false);
  });
});

describe("columnInfoOf and describeTarget", () => {
  it("finds a column by name", () => {
    expect(columnInfoOf(META, "paid")?.udt).toBe("bool");
    expect(columnInfoOf(META, "missing")).toBeNull();
  });

  it("renders a target as schema.table.column", () => {
    expect(describeTarget({ schema: "public", table: "users", column: "id" })).toBe("public.users.id");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/devbench && bun run test columnMeta 2>&1 | tail -15
```

Expected: FAIL — `Failed to resolve import "./columnMeta"`.

- [ ] **Step 3: Create the module**

Create `apps/devbench/src/components/db/grid/columnMeta.ts`:

```ts
import type { ColumnFamily } from "./types";

/** Wire-compatible with the Rust `ForeignKeyRef`. */
export interface ForeignKeyRef {
  schema: string;
  table: string;
  column: string;
}

/** Wire-compatible with the Rust `ColumnInfo`. Field names are snake_case
 *  because serde emits them exactly as written, the same way `TableRows`
 *  already carries `pk_column`. */
export interface ColumnInfo {
  name: string;
  /** Postgres physical type name: `int4`, `text`, `bool`, `timestamptz`. */
  udt: string;
  nullable: boolean;
  default_expr: string | null;
  /** The database assigns this value — identity, generated, or serial. */
  is_identity: boolean;
  references: ForeignKeyRef | null;
}

const BOOLEAN_UDTS = new Set(["bool"]);

/** Spec §4 gives numerics and dates one operator set, because `>` and `<`
 *  answer something for both. The family names the operator set it selects,
 *  not a JavaScript type — which is why a timestamp lands under "number". */
const ORDERED_UDTS = new Set([
  "int2", "int4", "int8", "float4", "float8", "numeric", "money",
  "date", "timestamp", "timestamptz", "time", "timetz",
]);

export function familyOfUdt(udt: string): ColumnFamily {
  if (BOOLEAN_UDTS.has(udt)) return "boolean";
  if (ORDERED_UDTS.has(udt)) return "number";
  return "text";
}

export function columnInfoOf(meta: ColumnInfo[], column: string): ColumnInfo | null {
  return meta.find((c) => c.name === column) ?? null;
}

/** Text is the fallback rather than an error: metadata is absent on the first
 *  render and after a failed describe, and text's operators work on any
 *  column, so the filter stays usable instead of disappearing. */
export function familyOfColumn(meta: ColumnInfo[], column: string): ColumnFamily {
  const info = columnInfoOf(meta, column);
  return info ? familyOfUdt(info.udt) : "text";
}

export function fkTargetOf(meta: ColumnInfo[], column: string): ForeignKeyRef | null {
  return columnInfoOf(meta, column)?.references ?? null;
}

/** Spec §8: the link icon marks a value you can follow. NULL follows nowhere,
 *  and `<unsupported type>` is not the value — it is the grid reporting it
 *  could not decode one, so there is nothing to look up. */
export function canFollow(meta: ColumnInfo[], column: string, value: string | null): boolean {
  return fkTargetOf(meta, column) !== null && value !== null && value !== "<unsupported type>";
}

export function describeTarget(target: ForeignKeyRef): string {
  return `${target.schema}.${target.table}.${target.column}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/devbench && bun run test columnMeta 2>&1 | tail -10
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Add the Tauri wrappers**

In `apps/devbench/src/lib/tauri.ts`, directly below the existing
`invokeCountTableRows` function, add:

```ts
export type { ColumnInfo, ForeignKeyRef } from "../components/db/grid/columnMeta";
import type { ColumnInfo } from "../components/db/grid/columnMeta";

export function invokeDescribeColumns(
  connectionId: string,
  table: QualifiedTable,
): Promise<ColumnInfo[]> {
  return invoke("describe_columns", { connectionId, table });
}

/** `null` means the key points at no row — spec §8's "No matching row in …",
 *  which is a fact to report, not a failure. */
export function invokeGetReferencedRow(
  connectionId: string,
  table: QualifiedTable,
  column: string,
  value: string,
): Promise<TableRows | null> {
  return invoke("get_referenced_row", { connectionId, table, column, value });
}
```

- [ ] **Step 6: Run the full suite and the type check**

```bash
cd apps/devbench && bun run test 2>&1 | tail -5 && bun run build 2>&1 | tail -5
```

Expected: **418 passing / 45 files** (407 baseline + 11), build clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/grid/columnMeta.ts apps/devbench/src/components/db/grid/columnMeta.test.ts apps/devbench/src/lib/tauri.ts
git commit -m "feat(devbench): carry real column types and foreign-key targets to the frontend"
```

---

## Task 4: The FK link button and popover

**Files:**
- Create: `apps/devbench/src/components/db/grid/FkPopover.tsx`
- Create: `apps/devbench/src/components/db/grid/FkPopover.test.tsx`

**Interfaces:**
- Consumes: `ForeignKeyRef`, `describeTarget` from `./columnMeta` (Task 3); `cellDisplay` from `../DataGrid`; `TableRows` from `../../../lib/tauri`
- Produces:
  - `FkLinkButton({ target, onOpen }: { target: ForeignKeyRef; onOpen: () => void })`
  - `FkPopover({ target, row, loading, error, onJump, onClose }: { target: ForeignKeyRef; row: TableRows | null; loading: boolean; error: string | null; onJump: () => void; onClose: () => void })`

The popover is a presentation component: the fetch, its loading and error
states, and what the jump does all live in `DbTab` (Tasks 7 and 8). Keeping it
dumb is what makes every one of its states testable without a Tauri stub.

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/db/grid/FkPopover.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FkLinkButton, FkPopover } from "./FkPopover";
import type { ForeignKeyRef } from "./columnMeta";

const TARGET: ForeignKeyRef = { schema: "public", table: "users", column: "id" };

const ROW = {
  columns: ["id", "email", "status"],
  rows: [["usr_88", "grace@example.com", "active"]] as (string | null)[][],
  pk_column: "id",
};

function renderPopover(overrides: Partial<Parameters<typeof FkPopover>[0]> = {}) {
  const props = {
    target: TARGET,
    row: ROW,
    loading: false,
    error: null,
    onJump: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<FkPopover {...props} />);
  return props;
}

describe("FkLinkButton", () => {
  // Spec §8: "always visible — it is information about the data, not an
  // affordance for a hover state." A hover-revealed class would make the
  // presence of a key invisible until you happen to point at the cell.
  it("names the target it points at, without needing a hover", () => {
    render(<FkLinkButton target={TARGET} onOpen={vi.fn()} />);
    const button = screen.getByRole("button", { name: /public\.users\.id/ });
    expect(button.className).not.toMatch(/invisible|opacity-0|group-hover/);
  });

  it("opens on click", async () => {
    const onOpen = vi.fn();
    render(<FkLinkButton target={TARGET} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: /public\.users\.id/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("FkPopover", () => {
  it("is a dialog with an accessible name naming the referenced table", () => {
    renderPopover();
    expect(screen.getByRole("dialog", { name: /public\.users/ })).toBeInTheDocument();
  });

  it("heads with the fully qualified target column", () => {
    renderPopover();
    expect(screen.getByText("public.users.id")).toBeInTheDocument();
  });

  it("lists the referenced row as label and value pairs", () => {
    renderPopover();
    for (const label of ROW.columns) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("usr_88")).toBeInTheDocument();
    expect(screen.getByText("grace@example.com")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  // Spec §8: "A referenced row that no longer exists shows 'No matching row in
  // public.users' rather than an empty popover."
  it("says where the row is missing from rather than showing an empty card", () => {
    renderPopover({ row: null });
    expect(screen.getByText("No matching row in public.users.")).toBeInTheDocument();
  });

  it("reports a failed lookup as an alert, not as a missing row", () => {
    renderPopover({ row: null, error: "connection refused" });
    expect(screen.getByRole("alert")).toHaveTextContent("connection refused");
    expect(screen.queryByText(/No matching row/)).not.toBeInTheDocument();
  });

  it("shows a loading state instead of claiming the row is missing", () => {
    renderPopover({ row: null, loading: true });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/No matching row/)).not.toBeInTheDocument();
  });

  it("offers open and close actions with real names", async () => {
    const props = renderPopover();
    await userEvent.click(screen.getByRole("button", { name: /open public\.users/i }));
    expect(props.onJump).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    const props = renderPopover();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("closes when the pointer goes down outside it", async () => {
    const props = renderPopover();
    await userEvent.click(document.body);
    expect(props.onClose).toHaveBeenCalled();
  });

  // The trigger's own click toggles the popover. If a pointerdown on it also
  // closed here, the toggle would reopen what this just dismissed and the
  // popover would never close by clicking its own icon.
  it("leaves a pointer down on the trigger to the trigger", async () => {
    const props = renderPopover();
    const { container } = render(<FkLinkButton target={TARGET} onOpen={vi.fn()} />);
    const trigger = container.querySelector("[data-fk-trigger]") as HTMLElement;
    await userEvent.click(trigger);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  // A NULL in the referenced row must not read as the string "NULL" — the
  // same distinction the grid keeps (regression-critical constraint 4).
  it("keeps NULL visually distinct in the referenced row", () => {
    renderPopover({
      row: { columns: ["id", "notes"], rows: [["usr_88", null]], pk_column: "id" },
    });
    const nullCell = screen.getByText("NULL");
    expect(nullCell.className).toMatch(/italic/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/devbench && bun run test FkPopover 2>&1 | tail -15
```

Expected: FAIL — `Failed to resolve import "./FkPopover"`.

- [ ] **Step 3: Write the component**

Create `apps/devbench/src/components/db/grid/FkPopover.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { cellDisplay } from "../DataGrid";
import { describeTarget, type ForeignKeyRef } from "./columnMeta";
import type { TableRows } from "../../../lib/tauri";

/** The mockup's `I.link`. */
function LinkIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

/** The mockup's `I.openIn`. */
function OpenInIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * Spec §8: always visible. No `invisible`/`group-hover` classes here on
 * purpose — whether a column has a foreign key is a fact about the schema, and
 * hiding it until hover would mean you have to already suspect a key exists to
 * discover that it does.
 */
export function FkLinkButton({ target, onOpen }: { target: ForeignKeyRef; onOpen: () => void }) {
  const label = describeTarget(target);
  return (
    <button
      type="button"
      data-fk-trigger
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Show referenced row in ${label}`}
      title={label}
      className="shrink-0 rounded-sm p-px text-text-faint hover:bg-surface hover:text-text"
    >
      <LinkIcon />
    </button>
  );
}

const actionButtonClass =
  "grid size-5 shrink-0 place-items-center rounded-sm text-text-faint hover:bg-surface-2 hover:text-text";

export function FkPopover({
  target,
  row,
  loading,
  error,
  onJump,
  onClose,
}: {
  target: ForeignKeyRef;
  /** `null` with no error and not loading means the key points nowhere. */
  row: TableRows | null;
  loading: boolean;
  error: string | null;
  onJump: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const targetTable = `${target.schema}.${target.table}`;

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const node = event.target as Node | null;
      // The trigger's own click already toggles this popover; closing here
      // first would make that toggle reopen what the user just dismissed.
      // Same guard GridToolbar uses for its own popovers.
      if (node instanceof Element && node.closest("[data-fk-trigger]")) return;
      if (ref.current?.contains(node)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Referenced row in ${targetTable}`}
      // z-20 is deliberate: above sibling cells (pinned cells are z-10) and
      // below DataGrid's z-30 sticky header, which must keep covering anything
      // scrolled up under it. Positioned against the cell, which DataGrid
      // already marks `relative` for the inline editor.
      className="absolute left-0 top-full z-20 mt-1 min-w-70 rounded-lg border border-border bg-surface shadow-lg"
    >
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2 font-mono text-xs text-text">
        <LinkIcon />
        <span className="truncate">{describeTarget(target)}</span>
        <span className="ml-auto flex gap-0.5">
          <button
            type="button"
            onClick={onJump}
            aria-label={`Open ${targetTable} at this row`}
            title={`Open ${targetTable} at this row`}
            className={actionButtonClass}
          >
            <OpenInIcon />
          </button>
          <button type="button" onClick={onClose} aria-label="Close referenced row" className={actionButtonClass}>
            <CloseIcon />
          </button>
        </span>
      </div>

      <div className="px-2.5 pb-2.5 pt-1.5">
        {loading ? (
          <div className="py-0.75 text-xs text-text-faint">Loading…</div>
        ) : error ? (
          // A failed lookup is not the same fact as a key pointing nowhere,
          // and saying "no matching row" when the query never ran would be a
          // guess presented as a finding.
          <div role="alert" className="py-0.75 text-xs text-danger">
            {error}
          </div>
        ) : row === null || row.rows.length === 0 ? (
          <div className="py-0.75 text-xs text-text-faint">No matching row in {targetTable}.</div>
        ) : (
          row.columns.map((column, index) => {
            const value = row.rows[0][index] ?? null;
            const { text, className } = cellDisplay(value);
            return (
              <div key={column} className="flex gap-3 py-0.75 font-mono text-xs">
                <span className="min-w-24 shrink-0 text-text-faint">{column}</span>
                {/* cellDisplay carries the grid's own NULL / unsupported
                    treatment, so the popover cannot drift into rendering a
                    real NULL the same as the string "NULL". */}
                <span className={`min-w-0 flex-1 truncate text-text-muted ${className}`}>{text}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/devbench && bun run test FkPopover 2>&1 | tail -10
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Run the full suite**

```bash
cd apps/devbench && bun run test 2>&1 | tail -5 && bun run build 2>&1 | tail -5
```

Expected: **431 passing / 46 files** (418 + 13), build clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/grid/FkPopover.tsx apps/devbench/src/components/db/grid/FkPopover.test.tsx
git commit -m "feat(devbench): add the foreign-key link icon and referenced-row popover"
```

---

## Task 5: Move "Reset layout" into the Columns popover

**Files:**
- Modify: `apps/devbench/src/components/db/grid/ColumnsPopover.tsx`
- Modify: `apps/devbench/src/components/db/grid/ColumnsPopover.test.tsx`
- Modify: `apps/devbench/src/components/db/grid/GridToolbar.tsx`
- Modify: `apps/devbench/src/components/db/DataGrid.tsx:314-337`
- Modify: `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` (§5)

**Interfaces:**
- Consumes: `GridLayout`, `EMPTY_LAYOUT` from `./gridLayout`; `SecondaryButton` from `../../ui/SecondaryButton`
- Produces: `ColumnsPopover` gains a required `onReset: () => void` prop. `GridToolbar` supplies it as `() => onLayoutChange(EMPTY_LAYOUT)`. `DataGrid` loses `layoutIsCustomised` and its full-width strip.

**Why this task exists.** `DataGrid.tsx:327-337` renders a conditional
full-width "Reset layout" strip below the toolbar. It appears in neither the
mockup, the spec, nor any plan — it survives from the pre-toolbar filter bar.
The Columns popover footer already has `Show all` on the left and an empty right
slot (`<span />` at `ColumnsPopover.tsx:60`), which is exactly where a
layout-wide reset belongs: beside the narrower reset that sits next to it.

The two are not redundant. `Show all` un-hides columns and leaves widths, order
and pins alone; `Reset layout` clears all four. The footer is where their scopes
are legible side by side.

- [ ] **Step 1: Write the failing test**

Replace the whole of `apps/devbench/src/components/db/grid/ColumnsPopover.test.tsx`
with:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColumnsPopover } from "./ColumnsPopover";
import { EMPTY_LAYOUT, type GridLayout } from "./gridLayout";

const COLUMNS = ["id", "status", "amount"];

function renderPopover(layout: Partial<GridLayout> = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(
    <ColumnsPopover
      columns={COLUMNS}
      layout={{ ...EMPTY_LAYOUT, ...layout }}
      onChange={onChange}
      onReset={onReset}
    />,
  );
  return { onChange, onReset };
}

describe("ColumnsPopover", () => {
  // Hidden columns stay listed, or hiding one would remove the only control
  // that brings it back.
  it("lists every column, hidden ones included", () => {
    renderPopover({ hidden: ["status"] });
    expect(screen.getByRole("checkbox", { name: "Show id" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show status" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show amount" })).toBeChecked();
  });

  it("hides a visible column", async () => {
    const { onChange } = renderPopover();
    await userEvent.click(screen.getByRole("checkbox", { name: "Show status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: ["status"] }));
  });

  it("shows a hidden column again", async () => {
    const { onChange } = renderPopover({ hidden: ["status", "amount"] });
    await userEvent.click(screen.getByRole("checkbox", { name: "Show status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: ["amount"] }));
  });

  it("toggles a pin and reports its pressed state", async () => {
    const { onChange } = renderPopover({ pinned: ["id"] });
    expect(screen.getByRole("button", { name: "Unfreeze id" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Freeze status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pinned: ["id", "status"] }));
  });

  // Show all is narrow on purpose: it un-hides, and leaves widths, order and
  // pins exactly as the user set them.
  it("un-hides every column without touching widths, order or pins", async () => {
    const { onChange } = renderPopover({ hidden: ["status"], pinned: ["id"], widths: { id: 200 } });
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onChange).toHaveBeenCalledWith({
      widths: { id: 200 },
      order: [],
      pinned: ["id"],
      hidden: [],
    });
  });

  // The wider reset lives beside it, in the footer's other slot — it used to
  // be a full-width strip of its own below the toolbar, which appeared in
  // neither the mockup nor the spec.
  it("offers a full layout reset in the footer", async () => {
    const { onReset } = renderPopover({ hidden: ["status"], pinned: ["id"], widths: { id: 200 } });
    await userEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(onReset).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/devbench && bun run test ColumnsPopover 2>&1 | tail -15
```

Expected: FAIL — `Unable to find an accessible element with the role "button"
and name "Reset layout"`. The TypeScript error for the missing `onReset` prop
surfaces at `bun run build`.

- [ ] **Step 3: Add the reset to the popover footer**

In `apps/devbench/src/components/db/grid/ColumnsPopover.tsx`, add `onReset` to
the props:

```tsx
export function ColumnsPopover({
  columns,
  layout,
  onChange,
  onReset,
}: {
  columns: string[];
  layout: GridLayout;
  onChange: (layout: GridLayout) => void;
  /** Clears widths, order, pins and hidden together — the wider sibling of
   *  "Show all", which only un-hides. */
  onReset: () => void;
}) {
```

and replace the footer (the `<div className="mt-3 …">` block ending in
`<span />`) with:

```tsx
      <div className="mt-3 flex items-center justify-between gap-2">
        <SecondaryButton className="h-6.5" onClick={() => onChange({ ...layout, hidden: [] })}>
          Show all
        </SecondaryButton>
        <SecondaryButton className="h-6.5" onClick={onReset}>
          Reset layout
        </SecondaryButton>
      </div>
```

Both are secondary and both are 26px, set by the row rather than by either
button — spec §14's rule for popover footers.

- [ ] **Step 4: Supply it from the toolbar**

In `apps/devbench/src/components/db/grid/GridToolbar.tsx`, extend the
`gridLayout` import to include `EMPTY_LAYOUT`:

```tsx
import { EMPTY_LAYOUT, exportColumnOrder, type GridLayout } from "./gridLayout";
```

and pass the handler where `ColumnsPopover` is rendered:

```tsx
          {open === "columns" ? (
            <ColumnsPopover
              columns={columns}
              layout={layout}
              onChange={onLayoutChange}
              onReset={() => onLayoutChange(EMPTY_LAYOUT)}
            />
          ) : null}
```

- [ ] **Step 5: Delete the strip from DataGrid**

In `apps/devbench/src/components/db/DataGrid.tsx`, delete the
`layoutIsCustomised` constant (lines 314-317):

```tsx
  const layoutIsCustomised =
    effectiveLayout.order.length > 0 ||
    effectiveLayout.pinned.length > 0 ||
    Object.keys(effectiveLayout.widths).length > 0;
```

and the block that used it (lines 327-337), so that `{toolbar}` is followed
directly by `<div className="overflow-hidden rounded-b-lg">`:

```tsx
      {toolbar}
      {layoutIsCustomised ? (
        <div className="flex items-center justify-end border-b border-border bg-surface px-3 py-1.5">
          <button
            type="button"
            onClick={() => updateLayout(EMPTY_LAYOUT)}
            className="shrink-0 rounded-sm px-2 py-0.5 text-xs text-text-faint hover:bg-surface-2 hover:text-text"
          >
            Reset layout
          </button>
        </div>
      ) : null}
```

`EMPTY_LAYOUT` is still imported by `DataGrid.tsx` for its `layout` prop
default (line 146), so leave the import alone.

- [ ] **Step 6: Document it in the spec**

In `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md`, in §5
(`## 5. Columns`), append after the existing final paragraph ("A hidden column
is hidden from the grid only…"):

```markdown
The dropdown's footer carries two resets, and their scopes differ. **Show all**
un-hides every column and leaves widths, order and pins as they are. **Reset
layout** clears all four back to the default. Both are secondary buttons at the
footer's own 26px.

Reset layout previously sat in a full-width strip of its own below the toolbar,
left over from the filter bar this design replaces. A control that only ever
appears once you have customised something, in a strip that exists only to hold
it, is worse than the same control living permanently beside the narrower reset
it belongs with.
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/devbench && bun run test ColumnsPopover 2>&1 | tail -10
```

Expected: PASS, 6 tests.

```bash
cd apps/devbench && bun run test 2>&1 | tail -5 && bun run build 2>&1 | tail -5
```

Expected: **432 passing / 46 files**. The file already holds 5 tests and this
rewrite leaves it with 6, so the net is +1, not +6 — the rewrite reorganises the
existing coverage rather than adding to it. Build clean. If `DataGrid.test.tsx`
asserted on the strip this would fail here; it does not — there is no existing
test naming "Reset layout".

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/grid/ColumnsPopover.tsx apps/devbench/src/components/db/grid/ColumnsPopover.test.tsx apps/devbench/src/components/db/grid/GridToolbar.tsx apps/devbench/src/components/db/DataGrid.tsx docs/superpowers/specs/2026-08-02-devbench-table-view-design.md
git commit -m "refactor(devbench): move Reset layout into the Columns popover footer"
```

---

## Task 6: Real column types drive the filter operators

**Files:**
- Modify: `apps/devbench/src/components/db/DbTab.tsx` (imports; new state; new effect; `familyOfColumn` at 586-596)
- Modify: `apps/devbench/src/components/db/grid/types.ts` (delete `inferFamily`)
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: `invokeDescribeColumns` (Task 3), `familyOfColumn`, `type ColumnInfo` (Task 3)
- Produces: `DbTab` holds `columnMeta: ColumnInfo[]`, refetched once per `(connection, table)`, and passes `familyOf={(column) => familyOfColumn(columnMeta, column)}` to `GridToolbar`. `inferFamily` no longer exists.

Spec §17 names this the deliberate temporary duplication Slice 1 accepted:
Slice 1 sniffed a column's family from a sample value, so a text column holding
`4821` offered `>` and `<`, and a text column holding `true` offered `is true`.
This replaces it with the type Postgres reports.

**Scope guard.** `cellDisplay`'s boolean sniffing in `DataGrid.tsx:61` is a
different inference and **stays** — spec §7 defers it explicitly. Do not touch
it. `consoleOpen` and `<QueryConsole>` in this same file are Slice 4's; leave
them alone.

- [ ] **Step 1: Write the failing test**

In `apps/devbench/src/components/db/DbTab.test.tsx`, add to the `beforeEach`
block, after the `invokeCountTableRows` line:

```tsx
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([]);
```

Then add these two tests inside `describe("DbTab", …)`:

```tsx
  it("describes the selected table's columns once, with its schema", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });
    const describeColumns = vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([]);

    renderDb({ schema: "alt", name: "orders" });

    await waitFor(() =>
      expect(describeColumns).toHaveBeenCalledWith("c1", { schema: "alt", name: "orders" }),
    );
    // The schema does not change when the page or the filter does, so this is
    // fetched per table, not per query.
    expect(describeColumns).toHaveBeenCalledTimes(1);
  });

  // Slice 1 inferred the family from a sample value. A text column whose
  // values happen to be digits was offered `>` and `<`, which SQL will happily
  // run on text with results nobody wants.
  it("offers filter operators from the real column type, not from the values", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["ref_code"], rows: [["4821"]], pk_column: null,
    });
    const describeColumns = vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([
      {
        name: "ref_code",
        udt: "text",
        nullable: true,
        default_expr: null,
        is_identity: false,
        references: null,
      },
    ]);

    renderDb(ORDERS);
    await waitFor(() => expect(describeColumns).toHaveBeenCalled());
    await screen.findByText("4821");

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add filter" }));

    await waitFor(() => {
      const operators = screen.getByRole("combobox", { name: "Filter operator, condition 1" });
      expect([...operators.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
        "=", "≠", "contains", "starts with", "is null", "is not null",
      ]);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/devbench && bun run test DbTab 2>&1 | tail -20
```

Expected: FAIL — `invokeDescribeColumns` is never called (the first test), and
the operator list reads `["=", "≠", ">", "<", "is null", "is not null"]`
because `inferFamily("4821")` returns `"number"` (the second).

- [ ] **Step 3: Fetch the metadata in DbTab**

In `apps/devbench/src/components/db/DbTab.tsx`, replace the `./grid/types`
import (line 6):

```tsx
import { inferFamily, type ColumnFamily } from "./grid/types";
```

with:

```tsx
import { familyOfColumn, type ColumnInfo } from "./grid/columnMeta";
```

and add `invokeDescribeColumns` to the existing `../../lib/tauri` import list,
after `invokeCountTableRows`:

```tsx
  invokeDescribeColumns,
```

Add the state beside `lastKnownColumns` (after line 96):

```tsx
  // Column types, defaults and foreign-key targets for the selected table.
  // Fetched once per table — the schema does not change when the page or the
  // filter does.
  const [columnMeta, setColumnMeta] = useState<ColumnInfo[]>([]);
```

Add this effect directly **after** the existing table-switch effect (the one
ending at line 261 with its `eslint-disable-next-line` and dependency array):

```tsx
  // Its own effect rather than a call inside fetchRows: the metadata is per
  // table, and fetchRows also runs on every page, sort, filter and refresh.
  useEffect(() => {
    if (!table || !activeConnectionId) {
      setColumnMeta([]);
      return;
    }
    let cancelled = false;
    invokeDescribeColumns(activeConnectionId, table)
      .then((meta) => {
        if (!cancelled) setColumnMeta(meta);
      })
      .catch(() => {
        // No metadata degrades to text operators and no link icons, which is
        // a usable grid. Taking the tab down because the catalog query failed
        // would be worse than the feature simply being absent.
        if (!cancelled) setColumnMeta([]);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the identity string for the same reason the fetch effect above
    // is: a legacy string prop is re-wrapped into a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table ? tableKey(table) : null, activeConnectionId]);
```

- [ ] **Step 4: Use the real family**

Replace `familyOfColumn` in `apps/devbench/src/components/db/DbTab.tsx`
(lines 586-596) — the whole comment block and function:

```tsx
  // Samples the first NON-NULL value in the column across the fetched page,
  // not just row 0 — a NULL there would report the column as text and offer
  // "contains"/"starts with" where "is true"/"is false" belong. Still a
  // heuristic; Slice 2 replaces the whole thing with describe_columns' real
  // type metadata.
  function familyOfColumn(column: string): ColumnFamily {
    const index = tableRows?.columns.indexOf(column) ?? -1;
    if (index < 0) return "text";
    const sample = (tableRows?.rows ?? []).map((row) => row[index]).find((v) => v !== null);
    return inferFamily(sample ?? null);
  }
```

with:

```tsx
  // The real Postgres type, not a guess from a sample value. Before the
  // metadata lands (and if it never does) every column reads as text, whose
  // operators are the ones that work on anything.
  const familyOf = (column: string) => familyOfColumn(columnMeta, column);
```

and change the `GridToolbar` prop at line 724 from:

```tsx
                        familyOf={familyOfColumn}
```

to:

```tsx
                        familyOf={familyOf}
```

- [ ] **Step 5: Delete the inference it replaced**

In `apps/devbench/src/components/db/grid/types.ts`, delete `inferFamily` and
retarget the comment above `ColumnFamily`. Replace:

```ts
/** Slice 1 infers the family from the value, as the grid already does.
 *  Slice 2 replaces this with the real type from `describe_columns`. */
export type ColumnFamily = "text" | "number" | "boolean";
```

with:

```ts
/** Which operator set a column gets. Resolved from the column's real Postgres
 *  type — see `familyOfUdt` in `./columnMeta`. "number" covers dates too:
 *  spec §4 gives numerics and dates one operator set. */
export type ColumnFamily = "text" | "number" | "boolean";
```

and delete this function entirely:

```ts
export function inferFamily(sampleValue: string | null): ColumnFamily {
  if (sampleValue === "true" || sampleValue === "false") return "boolean";
  if (sampleValue !== null && /^-?\d+(\.\d+)?$/.test(sampleValue)) return "number";
  return "text";
}
```

There is no `types.test.ts`, so nothing else references it. Confirm with:

```bash
cd apps/devbench && grep -rn "inferFamily" src/
```

Expected: no output.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/devbench && bun run test DbTab 2>&1 | tail -10
```

Expected: PASS, the file's existing tests plus 2.

```bash
cd apps/devbench && bun run test 2>&1 | tail -5 && bun run build 2>&1 | tail -5
```

Expected: **434 passing / 46 files** (432 + 2), build clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx apps/devbench/src/components/db/grid/types.ts
git commit -m "feat(devbench): pick filter operators from the real column type"
```

---

## Task 7: Follow a foreign key from the grid

**Files:**
- Modify: `apps/devbench/src/components/db/DbTab.tsx` (imports; FK state; `renderCell` at 463-584; the table-switch effect at 233-261)
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: `FkLinkButton`, `FkPopover` (Task 4); `canFollow`, `fkTargetOf`, `type ForeignKeyRef` (Task 3); `invokeGetReferencedRow` (Task 3); `readLayout`, `writeLayout` (already imported by `DbTab`)
- Produces: nothing consumed by a later task — this is the slice's payload. Task 8 measures it.

**Why icon, popover and jump are one task.** A popover whose primary action
does nothing is not something a reviewer can accept on its own, and the jump is
about twenty lines on top of the state the popover already needs.

**The two traps in this task**

1. **The link button must be a sibling of the value button, never nested
   inside it.** A `<button>` inside a `<button>` is invalid HTML, and the
   click would bubble straight into the cell editor.
2. **Jumping to the table you are already on.** A self-referencing key
   (`employees.manager_id → employees.id`) does not change `table`, so the
   table-switch effect never fires and the pinned filter would never be
   applied. That case is handled explicitly below and has its own test.

- [ ] **Step 1: Write the failing test**

In `apps/devbench/src/components/db/DbTab.test.tsx`, add this block inside
`describe("DbTab", …)`:

```tsx
  const FK_META = [
    {
      name: "id",
      udt: "int4",
      nullable: false,
      default_expr: null,
      is_identity: true,
      references: null,
    },
    {
      name: "user_id",
      udt: "text",
      nullable: false,
      default_expr: null,
      is_identity: false,
      references: { schema: "public", table: "users", column: "id" },
    },
  ];

  function mockFkTable(rows: (string | null)[][] = [["1", "usr_88"]]) {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "user_id"], rows, pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue(FK_META);
  }

  // Spec §8: the icon marks a column with a target, and only such a column.
  it("shows a link icon only on cells in a column with a foreign key", async () => {
    mockFkTable();
    renderDb(ORDERS);

    const link = await screen.findByRole("button", { name: /public\.users\.id/ });
    expect(link).toBeInTheDocument();
    // One keyed column, one row: exactly one icon. `id` has no target.
    expect(screen.getAllByRole("button", { name: /Show referenced row/ })).toHaveLength(1);
  });

  it("shows no link icon on a NULL foreign key", async () => {
    mockFkTable([["1", null]]);
    renderDb(ORDERS);

    await screen.findByText("NULL");
    expect(screen.queryByRole("button", { name: /Show referenced row/ })).not.toBeInTheDocument();
  });

  it("fetches and shows the referenced row when the icon is clicked", async () => {
    mockFkTable();
    const referenced = vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id", "email"],
      rows: [["usr_88", "grace@example.com"]],
      pk_column: "id",
    });

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));

    // The referencing pair is what goes over the wire; the backend resolves
    // the target from the catalog.
    await waitFor(() =>
      expect(referenced).toHaveBeenCalledWith("c1", ORDERS, "user_id", "usr_88"),
    );
    expect(await screen.findByRole("dialog", { name: /public\.users/ })).toBeInTheDocument();
    expect(await screen.findByText("grace@example.com")).toBeInTheDocument();
  });

  // Spec §8: an unenforced or broken key states where the row is missing from.
  it("says no matching row when the key points nowhere", async () => {
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue(null);

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));

    expect(await screen.findByText("No matching row in public.users.")).toBeInTheDocument();
  });

  // Spec §8: "switches the grid to public.users with a pinned id = usr_88
  // filter, clearing sort, pins and hidden columns."
  it("jumps to the referenced table with a pinned filter on that row", async () => {
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id", "email"], rows: [["usr_88", "grace@example.com"]], pk_column: "id",
    });
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows");

    render(<DbTabHarness initialTable={ORDERS} />);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));
    await screen.findByRole("dialog", { name: /public\.users/ });
    fireEvent.click(screen.getByRole("button", { name: /open public\.users at this row/i }));

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        { schema: "public", name: "users" },
        expect.objectContaining({
          filter: [{ column: "id", op: "eq", value: "usr_88", enabled: true }],
          orderBy: [],
          offset: 0,
        }),
      ),
    );
  });

  it("clears pins and hidden columns on the table it jumps to", async () => {
    localStorage.setItem(
      "devbench.grid-layout.c1:public.users",
      JSON.stringify({ widths: { id: 200 }, order: ["email", "id"], pinned: ["id"], hidden: ["email"] }),
    );
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id", "email"], rows: [["usr_88", "grace@example.com"]], pk_column: "id",
    });

    render(<DbTabHarness initialTable={ORDERS} />);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));
    await screen.findByRole("dialog", { name: /public\.users/ });
    fireEvent.click(screen.getByRole("button", { name: /open public\.users at this row/i }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("devbench.grid-layout.c1:public.users")!);
      // A hidden column could hide the very column you jumped to see.
      expect(saved.hidden).toEqual([]);
      expect(saved.pinned).toEqual([]);
      // Widths and order describe how wide a column is, not which rows you are
      // looking at — no reason for a jump to throw them away.
      expect(saved.widths).toEqual({ id: 200 });
      expect(saved.order).toEqual(["email", "id"]);
    });
  });

  // A self-referencing key does not change `table`, so the table-switch effect
  // never fires. Without the same-table branch the pinned filter is set on a
  // ref and then silently dropped.
  it("applies the pinned filter when the key points at the table already open", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "manager_id"], rows: [["e2", "e1"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([
      { name: "id", udt: "text", nullable: false, default_expr: null, is_identity: false, references: null },
      {
        name: "manager_id", udt: "text", nullable: true, default_expr: null, is_identity: false,
        references: { schema: "public", table: "orders", column: "id" },
      },
    ]);
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id"], rows: [["e1"]], pk_column: "id",
    });
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows");

    render(<DbTabHarness initialTable={ORDERS} />);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));
    await screen.findByRole("dialog", { name: /public\.orders/ });
    fireEvent.click(screen.getByRole("button", { name: /open public\.orders at this row/i }));

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        ORDERS,
        expect.objectContaining({
          filter: [{ column: "id", op: "eq", value: "e1", enabled: true }],
        }),
      ),
    );
  });

  it("closes the popover when the jump lands", async () => {
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id"], rows: [["usr_88"]], pk_column: "id",
    });

    render(<DbTabHarness initialTable={ORDERS} />);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));
    await screen.findByRole("dialog", { name: /public\.users/ });
    fireEvent.click(screen.getByRole("button", { name: /open public\.users at this row/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /public\.users/ })).not.toBeInTheDocument(),
    );
  });
```

Add `localStorage.clear();` to the `beforeEach` block if it is not already
there, so the pins/hidden test cannot be polluted by a neighbour.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/devbench && bun run test DbTab 2>&1 | tail -20
```

Expected: FAIL — `Unable to find an accessible element with the role "button"
and name /Show referenced row/`.

- [ ] **Step 3: Add the imports and the FK state**

In `apps/devbench/src/components/db/DbTab.tsx`, extend the `./grid/columnMeta`
import from Task 6:

```tsx
import { canFollow, familyOfColumn, fkTargetOf, type ColumnInfo, type ForeignKeyRef } from "./grid/columnMeta";
```

and add, next to the other `./grid/*` imports:

```tsx
import { FkLinkButton, FkPopover } from "./grid/FkPopover";
```

Add `invokeGetReferencedRow` to the `../../lib/tauri` import list.

Add this state after `columnMeta` (Task 6's addition):

```tsx
  // Which cell's FK popover is open, and what the lookup for it returned.
  // Keyed by cell rather than by value: the same value can appear in several
  // rows, and only the one that was clicked should open.
  const [fkCell, setFkCell] = useState<{ rowIndex: number; columnIndex: number } | null>(null);
  const [fkRow, setFkRow] = useState<TableRows | null>(null);
  const [fkLoading, setFkLoading] = useState(false);
  const [fkError, setFkError] = useState<string | null>(null);
  // Same shape as requestIdRef: a slow lookup that lands after the popover has
  // closed (or reopened on another cell) must not paint its row into it.
  const fkRequestRef = useRef(0);
  // A jump parks its pinned filter here for the table-switch effect to pick
  // up. Declared with the other refs rather than beside handleJump because the
  // table-switch effect above closes over it — a `const` declared after that
  // effect would still work (the callback runs after render), but reading the
  // component top-to-bottom should not require knowing that.
  const pendingJumpRef = useRef<{ key: string; filter: FilterCondition[] } | null>(null);
```

- [ ] **Step 4: Add the open, close and jump handlers**

Add these functions after `abandonEditForQueryChange` (line 284):

```tsx
  function closeFk() {
    fkRequestRef.current++;
    setFkCell(null);
    setFkRow(null);
    setFkError(null);
    setFkLoading(false);
  }

  async function openFk(rowIndex: number, columnIndex: number, column: string, value: string) {
    if (!table || !activeConnectionId) return;
    const requestId = ++fkRequestRef.current;
    setFkCell({ rowIndex, columnIndex });
    setFkRow(null);
    setFkError(null);
    setFkLoading(true);
    try {
      const referenced = await invokeGetReferencedRow(activeConnectionId, table, column, value);
      if (requestId !== fkRequestRef.current) return;
      setFkRow(referenced);
    } catch (err) {
      if (requestId !== fkRequestRef.current) return;
      // A failed lookup is not the same fact as a key pointing nowhere.
      // Reporting it as "no matching row" would turn an outage into a claim
      // about the data.
      setFkError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === fkRequestRef.current) setFkLoading(false);
    }
  }

  // Spec §8: the jump is a table switch plus a pinned `column = value` filter.
  // A filter rather than an offset means it lands on the row under any sort or
  // page size, with no positional query.
  //
  // The filter cannot simply be handed to setFilter: the table-switch effect
  // clears filter, sort, page and limit on every table change, and would wipe
  // it a render later. It is parked in pendingJumpRef and consumed there.
  function handleJump(target: ForeignKeyRef, value: string) {
    if (!activeConnectionId) return;
    const targetTable: QualifiedTable = { schema: target.schema, name: target.table };
    const targetKey = tableKey(targetTable);
    const jumpFilter: FilterCondition[] = [
      { column: target.column, op: "eq", value, enabled: true },
    ];

    // Pins and hidden columns describe a view of this table that the jump is
    // not asking for — and a hidden column could hide the very column being
    // jumped to. Widths and order are left alone: they say how wide a column
    // is, not which rows you are looking at.
    const targetLayoutKey = `${activeConnectionId}:${targetKey}`;
    const targetLayout = readLayout(targetLayoutKey);
    const clearedLayout = { ...targetLayout, pinned: [], hidden: [] };

    closeFk();

    if (table && targetKey === tableKey(table)) {
      // A self-referencing key. `table` does not change, so the table-switch
      // effect never runs — apply the jump here or the filter is parked and
      // then dropped.
      abandonEditForQueryChange();
      updateLayout(clearedLayout);
      setSort([]);
      setPage(0);
      setFilter(jumpFilter);
      void fetchRows(table, activeConnectionId, jumpFilter, [], 0, limitRef.current);
      return;
    }

    // Written before the switch: the next render recomputes layoutKey, sees it
    // changed, and re-reads storage — which is where it will find this.
    writeLayout(targetLayoutKey, clearedLayout);
    pendingJumpRef.current = { key: targetKey, filter: jumpFilter };
    onPatchState({ table: targetTable });
  }
```

- [ ] **Step 5: Let the table-switch effect consume a parked jump**

In the table-switch effect (lines 233-261), replace `setFilter([]);` and the
fetch call so the effect reads:

```tsx
    abandonEdit(editingRef.current);
    setEditing(null);
    setEditError(null);
    closeFk();
    setSort([]);
    setPage(0);
    // A jump parks its pinned filter here rather than calling setFilter, which
    // this effect would clear a render later. Anything else starts unfiltered.
    const jump = pendingJumpRef.current;
    const jumpFilter =
      jump && table && jump.key === tableKey(table) ? jump.filter : [];
    pendingJumpRef.current = null;
    setFilter(jumpFilter);
    setLimit(100);
    limitRef.current = 100;
    setTotal(0);
    setTableRows(null);
    setLastKnownColumns([]);
    setError(null);
    if (table && activeConnectionId) {
      void fetchRows(table, activeConnectionId, jumpFilter, [], 0, 100);
    } else {
      requestIdRef.current++;
      setLoading(false);
    }
```

- [ ] **Step 6: Render the icon and the popover in `renderCell`**

In `renderCell`, replace the final `return (` block (lines 563-583) with:

```tsx
    const target = fkTargetOf(columnMeta, column);
    const followable = target !== null && canFollow(columnMeta, column, value);
    const fkOpen =
      fkCell !== null && fkCell.rowIndex === rowIndex && fkCell.columnIndex === columnIndex;

    const valueButton = (
      <button
        type="button"
        disabled={!editable || anyEditPending}
        onClick={() => editable && startEdit(rowIndex, columnIndex, value)}
        className={`group flex min-w-0 items-center gap-1 text-left ${
          followable ? "flex-1" : "w-full"
        } ${editable ? "hover:cursor-text hover:bg-surface-2" : ""}`}
      >
        <span className={`min-w-0 flex-1 truncate ${alignClass}`}>
          <CellValue value={value} />
        </span>
        {/* Decorative hover affordance (mirrors the mockup's `::after`
            pencil) — a real DOM node marked `aria-hidden` rather than CSS
            generated content, so it can never bleed into the button's
            accessible name the way `::after` text sometimes does. */}
        {editable ? (
          <span aria-hidden className="hidden shrink-0 text-[10.5px] text-text-faint group-hover:inline">
            ✎
          </span>
        ) : null}
      </button>
    );

    if (!followable || target === null || value === null) return valueButton;

    // The link is a SIBLING of the value button, never nested in it: a button
    // inside a button is invalid HTML, and the click would bubble into the
    // cell editor and open it underneath the popover.
    return (
      <div className="flex w-full min-w-0 items-center gap-1.5">
        {valueButton}
        <FkLinkButton target={target} onOpen={() => void openFk(rowIndex, columnIndex, column, value)} />
        {fkOpen ? (
          <FkPopover
            target={target}
            row={fkRow}
            loading={fkLoading}
            error={fkError}
            onJump={() => handleJump(target, value)}
            onClose={closeFk}
          />
        ) : null}
      </div>
    );
```

`rowIndex` here is still the **unfiltered** row index and `columnIndex` still
the **data** column index — `renderCell`'s contract is unchanged, and
`openFk`/`handleJump` only ever read `column` and `value`, which were resolved
from those same indices at the top of the function.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/devbench && bun run test DbTab 2>&1 | tail -10
```

Expected: PASS, the file's existing tests plus 8.

```bash
cd apps/devbench && bun run test 2>&1 | tail -5 && bun run build 2>&1 | tail -5
```

Expected: **442 passing / 46 files** (434 + 8), build clean.

Then confirm the regression-critical grid tests specifically:

```bash
cd apps/devbench && bun run test DataGrid 2>&1 | tail -8
```

Expected: PASS — in particular the two that pin `renderCell`'s indices.

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx
git commit -m "feat(devbench): follow a foreign key to its row and jump to its table"
```

---

## Task 8: Browser measurement gate

**Files:**
- Create: `apps/devbench/scripts/fk-stub.js` (the injected IPC stub — kept as a file so the next slice can reuse it)
- No source changes expected unless a measurement fails.

This task exists because jsdom has no layout engine and cannot see any of it.
**Every claim below must be backed by a number read out of a real browser.**
Report the measured numbers, not the expected ones — a step that says "verified"
without a number has not verified anything.

- [ ] **Step 1: Write the IPC stub**

Tauri's `invoke` throws in a plain browser, so the page has to be given one
before any app code runs. Create `apps/devbench/scripts/fk-stub.js`:

```js
// Injected before load (Playwright's addInitScript). Serves 260 rows and 12
// columns so vertical paging, virtualization and horizontal scroll are all
// exercised, with `user_id` carrying a foreign-key target so the link icon and
// its popover are too.
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

  const META = COLUMNS.map((name) => ({
    name,
    udt: name === "paid" ? "bool" : name === "amount" || name === "quantity" ? "int4" : "text",
    nullable: name === "notes",
    default_expr: null,
    is_identity: name === "id",
    references:
      name === "user_id" ? { schema: "public", table: "users", column: "id" } : null,
  }));

  const HANDLERS = {
    get_startup_status: () => ({ db_error: null }),
    get_settings: () => ({
      theme: "dark", correlation_window_ms: 2000, smtp_port: 1025,
      provider: "anthropic", model: "claude-opus-5", active_session_id: null,
    }),
    list_sessions: () => [],
    list_archived_sessions: () => [],
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
    list_table_rows: (args) => ({
      columns: COLUMNS,
      rows: ROWS.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100)),
      pk_column: "id",
    }),
    count_table_rows: () => ROWS.length,
    describe_columns: () => META,
    get_referenced_row: (args) => ({
      columns: ["id", "email", "status"],
      rows: [[args.value, `${args.value}@example.com`, "active"]],
      pk_column: "id",
    }),
  };

  window.__TAURI_INTERNALS__ = {
    // Anything unlisted resolves to null rather than throwing: an unstubbed
    // command must not take the page down and hide the thing being measured.
    invoke: (cmd, args) => Promise.resolve(HANDLERS[cmd] ? HANDLERS[cmd](args ?? {}) : null),
    transformCallback: (cb) => cb,
    convertFileSrc: (p) => p,
  };
})();
```

- [ ] **Step 2: Start the app and load it with the stub**

```bash
cd apps/devbench && bun run dev
```

Drive the page with Playwright (the `playwright` MCP browser tools, or a script
using the `npx playwright` already on this machine at 1.62.1 with
`chromium-1234` installed). Inject `scripts/fk-stub.js` with `addInitScript`
**before** navigating to `http://localhost:5173`, then wait for
`[role="table"]` to appear.

Record: the viewport size used, and how many rows and columns the grid reports.

- [ ] **Step 3: Measure the four regression-critical behaviours**

Evaluate and record every number:

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

Pass conditions: `headerDelta === bodyDelta` (constraint 1), `renderedRows > 0`
(constraint 2), `docScrollWidth === docClientWidth` (constraint 3),
`rowHeights` is exactly `[33]`.

Then constraint 4, that NULL stays distinct from `<unsupported type>` — the
stub puts a NULL in `notes` every 7th row:

```js
(() => {
  const nulls = [...document.querySelectorAll('[role="cell"] span')]
    .filter(s => s.textContent === 'NULL');
  const s = getComputedStyle(nulls[0]);
  return { count: nulls.length, fontStyle: s.fontStyle, color: s.color };
})()
```

Pass condition: `count > 0` and `fontStyle === "italic"`. Record the colour and
confirm it is the faint token, not the warning token that
`<unsupported type>` uses.

- [ ] **Step 4: Measure the link icon**

Spec §8 requires it always visible, not hover-revealed:

```js
(() => {
  const links = [...document.querySelectorAll('[data-fk-trigger]')];
  const first = links[0];
  const s = getComputedStyle(first);
  const r = first.getBoundingClientRect();
  const cell = first.closest('[role="cell"]');
  const cellRect = cell.getBoundingClientRect();
  return {
    count: links.length,
    display: s.display,
    visibility: s.visibility,
    opacity: s.opacity,
    width: r.width,
    height: r.height,
    // Sits at the right edge of its own cell, after the value.
    rightInset: Math.round(cellRect.right - r.right),
  };
})()
```

Pass conditions: `count` equals the number of rendered rows (one per visible
`user_id` cell), `visibility === "visible"`, `opacity === "1"`, `display` is not
`"none"` — **measured without hovering anything**.

- [ ] **Step 5: Verify the popover stacks above cells and below the sticky header**

This is the measurement the plan is required to make. Click the first link
icon, wait for `[role="dialog"]`, then:

```js
(() => {
  const pop = document.querySelector('[role="dialog"][aria-label^="Referenced row"]');
  const header = document.querySelector('[role="table"] [role="row"]');
  const pinnedCell = document.querySelector('[role="cell"]');
  const z = (el) => getComputedStyle(el).zIndex;
  const pr = pop.getBoundingClientRect();
  const hr = header.getBoundingClientRect();
  return {
    popoverZ: z(pop),
    headerZ: z(header),
    cellZ: z(pinnedCell),
    popoverRect: { top: pr.top, left: pr.left, width: pr.width, height: pr.height },
    headerBottom: hr.bottom,
    // Does the popover actually cover the cells it overlaps?
    elementAtPopoverCentre:
      document.elementFromPoint(pr.left + pr.width / 2, pr.top + pr.height / 2)
        .closest('[role="dialog"],[role="cell"]')?.getAttribute('role'),
  };
})()
```

Pass conditions:
- `Number(popoverZ) < Number(headerZ)` — below the sticky header (20 vs 30).
- `elementAtPopoverCentre === "dialog"` — genuinely above the cells, not merely
  numerically higher. This is the check that catches a stacking context that
  traps the popover behind content despite its z-index.

Then scroll the grid so the popover's row travels up under the sticky header
and re-measure `document.elementFromPoint` at a point inside the header band:
the header must win.

Record `popoverRect` and say plainly whether the popover is fully within the
scroll container's viewport at this row, or whether it is clipped at the
container's bottom edge — it is positioned inside the scrolling box, exactly as
the inline cell editor is.

- [ ] **Step 6: Verify the popover's content and the jump**

With the popover open, record:

```js
(() => {
  const pop = document.querySelector('[role="dialog"][aria-label^="Referenced row"]');
  return {
    head: pop.querySelector('span').textContent,
    labels: [...pop.querySelectorAll('div > span:first-child')].map(s => s.textContent),
    actions: [...pop.querySelectorAll('button')].map(b => b.getAttribute('aria-label')),
  };
})()
```

Pass conditions: `head === "public.users.id"`, both actions carry real
accessible names, and the body lists the referenced row's columns.

Then click the open action and record what the grid switched to:

```js
(() => {
  const headers = [...document.querySelectorAll('[role="columnheader"]')].map(h => h.textContent.trim());
  const filterBtn = [...document.querySelectorAll('[data-toolbar-trigger]')]
    .find(b => (b.getAttribute('aria-label') || '').startsWith('Filter'));
  const page = document.querySelector('[aria-label="Page number"]');
  return {
    headers,
    filterLabel: filterBtn?.getAttribute('aria-label'),
    page: page?.value,
  };
})()
```

Pass conditions: `filterLabel === "Filter, 1 applied"` (the pinned filter is
applied and counted) and `page === "1"`.

- [ ] **Step 7: Measure the Columns popover footer**

The Reset layout move from Task 5 is positional and jsdom cannot see it. Open
the Columns popover and record:

```js
(() => {
  const pop = document.querySelector('[role="dialog"][aria-label="Columns options"]');
  const buttons = [...pop.querySelectorAll('button')].filter(b => /Show all|Reset layout/.test(b.textContent));
  const [showAll, reset] = buttons;
  const pr = pop.getBoundingClientRect();
  const sr = showAll.getBoundingClientRect();
  const rr = reset.getBoundingClientRect();
  return {
    labels: buttons.map(b => b.textContent.trim()),
    heights: [sr.height, rr.height],
    showAllLeftInset: Math.round(sr.left - pr.left),
    resetRightInset: Math.round(pr.right - rr.right),
    sameRow: Math.abs(sr.top - rr.top) < 1,
  };
})()
```

Pass conditions: both labels present, `sameRow === true`, and the two heights
identical (spec §14: the row owns the height, not the buttons). Record the
measured heights — the footer's own is 26px.

Also confirm the old strip is gone:

```js
[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Reset layout').length
```

Pass condition: `1` while the Columns popover is open, `0` when it is closed.

- [ ] **Step 8: Compare against the mockup**

```bash
cd docs/mockups && python3 -m http.server 8899
```

Open both side by side. Confirm the link icon's position within the cell, the
popover's head/body layout, and the Columns footer all match. Report any
deviation as a deviation, with both numbers — do not silently accept one.

- [ ] **Step 9: Run every suite and record the real numbers**

```bash
cd apps/devbench && bun run test 2>&1 | tail -5
cd apps/devbench && bun run build 2>&1 | tail -5
cd apps/devbench/src-tauri && cargo test 2>&1 | tail -20
```

Report the actual counts against the baseline measured at the start of the run.
If anything fails, say so and paste the output.

- [ ] **Step 10: Commit any fixes**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/scripts/fk-stub.js apps/devbench/src
git commit -m "fix(devbench): correct foreign-key popover layout against browser measurements"
```

If no measurement failed, commit the stub alone:

```bash
git add apps/devbench/scripts/fk-stub.js
git commit -m "test(devbench): add the browser IPC stub used to measure the grid"
```

---

## Self-Review

**1. Spec coverage (Slice 2 only).**

| Spec section | Task |
|---|---|
| §13 `describe_columns` — type, nullability, default, identity | 1 |
| §13 `describe_columns` — FK target per column, one query, per table | 1, 6 |
| §13 `get_referenced_row(connection_id, table, column, value)` | 2 |
| §8 Link icon on a column with a target, always visible | 4, 7 |
| §8 Popover: `public.users.id` head, open and close actions, label/value body | 4, 7 |
| §8 "No matching row in …" rather than an empty popover | 2, 4, 7 |
| §8 Jump: switch table, pinned `column = value`, clear sort/pins/hidden | 7 |
| §4 Operators from the column's real type (`describe_columns`) | 3, 6 |
| §17 `inferFamily` replaced — the named temporary duplication | 6 |
| §5 Columns popover footer, Reset layout documented | 5 |
| §16 Rust: `describe_columns` reports identity, nullability, defaults, FK | 1 |
| §16 Vitest: FK link icon only on columns with a target | 4, 7 |
| §16 Browser: popovers above cells and below the sticky header | 8 |

Deliberately not covered here, per §17: §1 dock slot, §3 Pending button, §3a
rail segments, §3b query tabs, §9 insert panel, §10 pending changes, §11 row
delete, §12 query staging — Slices 3 and 4. §7's boolean *toggling* is Slice 3;
this slice leaves the checkbox display-only and leaves `cellDisplay`'s value
sniffing alone, which §7 explicitly defers.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task
N". Every code step carries the code. Task 8 is the one task without new source
code; that is deliberate — it is a measurement gate, and its steps name the
exact expressions to evaluate and the exact pass condition for each, rather
than saying "check it looks right".

**3. Type consistency.** Checked across tasks:
- `ForeignKeyRef { schema, table, column }` — identical in Rust (Task 1) and TS
  (Task 3), consumed unchanged in 4 and 7.
- `ColumnInfo { name, udt, nullable, default_expr, is_identity, references }` —
  Task 1 defines it, Task 3 mirrors it field-for-field in snake_case (serde
  emits field names as written, as `TableRows.pk_column` already proves), Tasks
  6 and 7 consume it, Slice 3's insert panel is its second consumer.
- `describe_columns_impl(&PgPool, &QualifiedTable)` — Task 1 produces;
  `get_referenced_row_impl(&PgPool, &QualifiedTable, &str, &str)` and
  `fk_target_of(...)` — Task 2 produces, both in the same module.
- `familyOfColumn(meta, column)` — Task 3 produces; Task 6 consumes it as
  `familyOf`, which is the prop name `GridToolbar` and `FilterPopover` already
  expect (`familyOf: (column: string) => ColumnFamily`). **The exported helper
  and DbTab's old local function share the name `familyOfColumn`; Task 6 Step 4
  deletes the local one and binds the import to a differently-named `familyOf`
  const, so the two can never shadow each other.**
- `canFollow` / `fkTargetOf` — Task 3 produces, Task 7 consumes.
- `FkLinkButton({ target, onOpen })` and `FkPopover({ target, row, loading,
  error, onJump, onClose })` — Task 4 produces, Task 7 supplies exactly these
  props. `FkPopover` takes no `value` prop: it renders the referenced row, and
  the value only matters to the caller that fetched it.
- `ColumnsPopover` gains a **required** `onReset` — Task 5 changes the only
  call site (`GridToolbar`) in the same task, so nothing is left uncompilable
  between tasks.
- `GridLayout { widths, order, pinned, hidden }` — unchanged from Slice 1;
  Tasks 5 and 7 both write all four fields.

**4. Ordering.** Every task leaves all three suites green:
- Task 3 is purely additive; `inferFamily` survives until Task 6 removes its
  only call site in the same task that replaces it.
- Task 5 changes `ColumnsPopover`'s signature and its single call site
  together.
- Tasks 1 and 2 register their commands as they add them, so `main.rs` never
  names a function that does not exist.

**5. Corrections applied inline.** Four things that a closing note would have
buried, recorded here only for the record — each is already written into the
task that needs it, because a subagent sees only its own task:

- **`main.rs`, not `lib.rs`.** The Slice 1 plan's File Structure said
  `src-tauri/src/lib.rs` registers commands. It does not; `tauri::generate_handler!`
  is in `main.rs`. Fixed in Global Constraints and in Tasks 1 and 2.
- **The spec's FK join is wrong and Task 1 does not follow it.** §13's comment
  says "information_schema.columns joined to the FK constraint views".
  `information_schema.constraint_column_usage` carries no ordinal, so a
  composite key cross-joins — measured against Postgres 17.9, `ck_a` comes back
  claiming both `dc_ck.a` and `dc_ck.b`, and through a LEFT JOIN that duplicates
  the column rows too. Task 1 reads `pg_catalog`'s `conkey[i]` ↔ `confkey[i]`
  instead, and carries the test that proves the difference.
- **`is_identity` means "database-assigned", not literally IDENTITY.** A
  `serial` is not an identity column, but §9 needs it read-only in the insert
  panel all the same. The field covers IDENTITY, `GENERATED ALWAYS`, and a
  `nextval(...)` default. Documented on the struct in Task 1 and in the spec
  edit in Task 1 Step 5b.
- **There is no seeded Postgres schema.** `docker-compose.yml` creates an empty
  `devbench_test`; the tables named in the brief (`orders.customer_id →
  customers.id`, `order_items.order_id → orders.id`) do not exist. Every Rust
  test here creates and drops its own fixtures, and must use names unique to
  itself because cargo runs them concurrently against one database. Tasks 1 and
  2 use those FK shapes, created by the tests. Recorded in Global Constraints.

**6. The jump's two failure modes, both handled in Task 7 rather than noted
here.** A parked filter that the table-switch effect clears a render later, and
a self-referencing key that never fires that effect at all. Both have tests.

**7. What this plan does not touch.** The query console drawer (`consoleOpen`,
`<QueryConsole>`) — Slice 4 removes it, and Tasks 6 and 7 edit the same file.
`cellDisplay`'s boolean sniffing — §7 defers it to Slice 3. `editGenerationRef`
and the preview machinery — §15 retires them in Slice 3, and this slice's FK
lookup deliberately does not go near them.
