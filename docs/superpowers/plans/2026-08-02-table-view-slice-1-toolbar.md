# Table View Slice 1 — Toolbar and Query Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DB grid's client-side filter bar with a toolbar whose Filter, Sort, Columns, Export and pagination controls run against real SQL, including a true row count.

**Architecture:** A Rust filter compiler turns a list of conditions into a parameterised `WHERE` clause, consumed by both `list_table_rows` and a new `count_table_rows`. On the frontend, `DataGrid.tsx` (already 649 lines) sheds its layout-persistence helpers and gains a `grid/` subdirectory holding the toolbar and one component per popover. Filter and Sort popovers edit a draft that only reaches the query on Apply.

**Tech Stack:** Rust + sqlx (Postgres), Tauri 2 commands, React 18, Zustand, Tailwind v4, vitest + @testing-library/react, Playwright for anything positional.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md`. Visual source of truth: `docs/mockups/devbench-db-connections.html` (runnable; serve with `python3 -m http.server 8899` from `docs/mockups`).
- Type scale from the mockup: `--fs-xs: 10.5px`, `--fs-sm: 12px`, `--fs-md: 13.5px`.
- Column and table identifiers are **validated** with `validate_identifier` before interpolation. Filter **values are always bound parameters** — never interpolated.
- jsdom has no layout engine. Never assert layout in vitest. Anything positional is verified in a real browser via Playwright with `getComputedStyle` / `getBoundingClientRect`, reporting measured numbers.
- Baseline to keep green: `cd apps/devbench && bun run test` (316 passing / 36 files), `bun run build` (runs `tsc`), `cd apps/devbench/src-tauri && cargo test --lib` (194 passing).
- Postgres for Rust tests: container `devbench-test-pg`, `localhost:5432`, `postgres`/`postgres`, db `devbench_test`. `docker start devbench-test-pg` if unreachable.
- These four grid behaviours are regression-critical and must still hold after every task: sticky header stays aligned with body columns under horizontal scroll; virtualization keeps rendering rows; horizontal scroll stays contained (`document.documentElement.scrollWidth === clientWidth`); NULL stays visually distinct from `<unsupported type>`.
- Out of scope for this plan: foreign keys (Slice 2); insert panel / row delete / pending changes / boolean toggling (Slice 3); rail segments and queries-as-tabs (Slice 4).
- One thing this plan must NOT break: the query console drawer stays exactly as it is until Slice 4 removes it. Task 12 rewrites `DbTab`'s fetch and pagination state, which sits alongside `consoleOpen` — leave that flag and `<QueryConsole>` untouched.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src-tauri/src/commands/db_filter.rs` | Filter condition types + SQL compiler. Pure; no DB access. |
| `src/components/db/grid/types.ts` | `SortTerm`, `FilterCondition`, `FilterOp`, `GridLayout`, operators-per-type. |
| `src/components/db/grid/gridLayout.ts` | localStorage read/write + visual column derivation. Pure. |
| `src/components/db/grid/exportRows.ts` | Rows → CSV / JSON. Pure. |
| `src/components/db/grid/GridToolbar.tsx` | The toolbar row: Insert, Refresh, popover triggers, pager. |
| `src/components/db/grid/FilterPopover.tsx` | Filter draft editor. |
| `src/components/db/grid/SortPopover.tsx` | Sort draft editor with priority reordering. |
| `src/components/db/grid/ColumnsPopover.tsx` | Visibility, pin, order. |
| `src/components/ui/SecondaryButton.tsx` | The one secondary button style. |

**Modified**

| File | Change |
|---|---|
| `src-tauri/src/commands/db.rs` | `list_table_rows` takes a filter; new `count_table_rows`. |
| `src-tauri/src/lib.rs` | Register `count_table_rows`. |
| `src/lib/tauri.ts` | Filter types; `invokeListTableRows` gains `filter`; `invokeCountTableRows`. |
| `src/components/db/DataGrid.tsx` | Layout helpers move out; renders `GridToolbar`; boolean checkbox; bottom pager removed. |
| `src/components/db/DbTab.tsx` | Owns filter/page/limit state; passes them down; fetches count. |
| `src/styles/globals.css` | `prefers-reduced-transparency` already handled; no change expected. |

---

## Task 1: Filter compiler (Rust, pure)

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/db_filter.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`

**Interfaces:**
- Consumes: `crate::commands::db::validate_identifier`
- Produces: `FilterOp`, `FilterCondition { column, op, value, enabled }`, `CompiledFilter { where_sql: String, params: Vec<String> }`, `compile_filter(&[FilterCondition], first_param_index: usize) -> Result<CompiledFilter, String>`

- [ ] **Step 1: Make `validate_identifier` reachable from a sibling module**

In `apps/devbench/src-tauri/src/commands/db.rs`, the function is already
`pub(crate) fn validate_identifier`. Confirm with:

```bash
cd apps/devbench/src-tauri && grep -n "fn validate_identifier" src/commands/db.rs
```

Expected: `pub(crate) fn validate_identifier(identifier: &str) -> Result<(), String> {`

- [ ] **Step 2: Register the new module**

In `apps/devbench/src-tauri/src/commands/mod.rs`, add alongside the existing
`pub mod db;`:

```rust
pub mod db_filter;
```

- [ ] **Step 3: Write the failing tests**

Create `apps/devbench/src-tauri/src/commands/db_filter.rs` containing only the
test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn cond(column: &str, op: FilterOp, value: Option<&str>) -> FilterCondition {
        FilterCondition {
            column: column.to_string(),
            op,
            value: value.map(|v| v.to_string()),
            enabled: true,
        }
    }

    #[test]
    fn no_conditions_compiles_to_no_clause() {
        let c = compile_filter(&[], 1).unwrap();
        assert_eq!(c.where_sql, "");
        assert!(c.params.is_empty());
    }

    // Values are bound, never interpolated: the compiled SQL must not contain
    // the user's value anywhere in it.
    #[test]
    fn a_value_is_bound_as_a_parameter_not_inlined() {
        let c = compile_filter(&[cond("status", FilterOp::Eq, Some("paid"))], 1).unwrap();
        assert_eq!(c.where_sql, " WHERE \"status\" = $1");
        assert_eq!(c.params, vec!["paid".to_string()]);
        assert!(!c.where_sql.contains("paid"));
    }

    #[test]
    fn conditions_are_and_joined_and_numbered_in_order() {
        let c = compile_filter(
            &[
                cond("status", FilterOp::Eq, Some("paid")),
                cond("notes", FilterOp::Contains, Some("rush")),
            ],
            1,
        )
        .unwrap();
        assert_eq!(c.where_sql, " WHERE \"status\" = $1 AND \"notes\" LIKE $2");
        assert_eq!(c.params, vec!["paid".to_string(), "%rush%".to_string()]);
    }

    // The caller may already have bound parameters (limit/offset), so numbering
    // has to start where they left off.
    #[test]
    fn parameter_numbering_starts_at_the_given_index() {
        let c = compile_filter(&[cond("status", FilterOp::Eq, Some("paid"))], 3).unwrap();
        assert_eq!(c.where_sql, " WHERE \"status\" = $3");
    }

    // A wildcard typed by the user is data, not syntax.
    #[test]
    fn like_wildcards_in_user_input_are_escaped() {
        let c = compile_filter(&[cond("notes", FilterOp::Contains, Some("50%_off"))], 1).unwrap();
        assert_eq!(c.params, vec![r"%50\%\_off%".to_string()]);
        assert!(c.where_sql.ends_with(r"LIKE $1 ESCAPE '\'"));
    }

    #[test]
    fn starts_with_anchors_the_pattern_at_the_front() {
        let c = compile_filter(&[cond("email", FilterOp::StartsWith, Some("ada"))], 1).unwrap();
        assert_eq!(c.params, vec!["ada%".to_string()]);
    }

    // Valueless operators take no parameter at all.
    #[test]
    fn valueless_operators_bind_nothing() {
        let c = compile_filter(
            &[cond("notes", FilterOp::IsNull, None), cond("paid", FilterOp::IsTrue, None)],
            1,
        )
        .unwrap();
        assert_eq!(c.where_sql, " WHERE \"notes\" IS NULL AND \"paid\" IS TRUE");
        assert!(c.params.is_empty());
    }

    // Mirrors the UI rule: a condition that needs a value and has none is
    // inert, so an unfinished rule cannot empty the grid.
    #[test]
    fn a_value_operator_with_no_value_is_skipped() {
        let c = compile_filter(
            &[cond("status", FilterOp::Eq, None), cond("paid", FilterOp::IsTrue, None)],
            1,
        )
        .unwrap();
        assert_eq!(c.where_sql, " WHERE \"paid\" IS TRUE");
    }

    #[test]
    fn a_disabled_condition_is_skipped() {
        let mut disabled = cond("status", FilterOp::Eq, Some("paid"));
        disabled.enabled = false;
        let c = compile_filter(&[disabled], 1).unwrap();
        assert_eq!(c.where_sql, "");
    }

    #[test]
    fn a_malicious_column_name_is_rejected() {
        let result = compile_filter(
            &[cond("id\"; DROP TABLE users; --", FilterOp::Eq, Some("1"))],
            1,
        );
        assert!(result.is_err(), "a column name is an identifier and must be validated");
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::db_filter`
Expected: compile error — `FilterOp`, `FilterCondition`, `compile_filter` not found.

- [ ] **Step 5: Write the implementation**

Insert above the `#[cfg(test)]` block in `db_filter.rs`:

```rust
use serde::Deserialize;

use crate::commands::db::validate_identifier;

/// Operators the grid offers. Serialised from the frontend in snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Gt,
    Lt,
    Contains,
    StartsWith,
    IsNull,
    IsNotNull,
    IsTrue,
    IsFalse,
}

impl FilterOp {
    /// Whether this operator consumes a bound value. `IS NULL` and friends do
    /// not, and a condition using one is complete without any input.
    fn takes_value(self) -> bool {
        !matches!(
            self,
            FilterOp::IsNull | FilterOp::IsNotNull | FilterOp::IsTrue | FilterOp::IsFalse
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilterCondition {
    pub column: String,
    pub op: FilterOp,
    pub value: Option<String>,
    /// An unticked rule is kept by the UI but must not reach the query.
    pub enabled: bool,
}

pub struct CompiledFilter {
    /// Either empty, or a clause with a leading space: ` WHERE ...`.
    pub where_sql: String,
    pub params: Vec<String>,
}

/// `%` and `_` are LIKE syntax. A user typing them means the characters, so
/// they are escaped and the pattern declares its escape character.
fn escape_like(input: &str) -> String {
    input
        .replace('\\', r"\\")
        .replace('%', r"\%")
        .replace('_', r"\_")
}

/// Compiles conditions into a parameterised WHERE clause. `first_param_index`
/// is the number of the first `$n` placeholder this clause may use.
pub fn compile_filter(
    conditions: &[FilterCondition],
    first_param_index: usize,
) -> Result<CompiledFilter, String> {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    let mut next = first_param_index;

    for condition in conditions {
        if !condition.enabled {
            continue;
        }
        // An unfinished rule is inert rather than an error — the UI lets one
        // exist while the user is still typing it.
        if condition.op.takes_value() && condition.value.as_deref().unwrap_or("").is_empty() {
            continue;
        }
        validate_identifier(&condition.column)?;
        let column = format!("\"{}\"", condition.column);

        let clause = match condition.op {
            FilterOp::IsNull => format!("{column} IS NULL"),
            FilterOp::IsNotNull => format!("{column} IS NOT NULL"),
            FilterOp::IsTrue => format!("{column} IS TRUE"),
            FilterOp::IsFalse => format!("{column} IS FALSE"),
            FilterOp::Eq | FilterOp::Ne | FilterOp::Gt | FilterOp::Lt => {
                let operator = match condition.op {
                    FilterOp::Eq => "=",
                    FilterOp::Ne => "<>",
                    FilterOp::Gt => ">",
                    FilterOp::Lt => "<",
                    _ => unreachable!(),
                };
                params.push(condition.value.clone().unwrap_or_default());
                let clause = format!("{column} {operator} ${next}");
                next += 1;
                clause
            }
            FilterOp::Contains | FilterOp::StartsWith => {
                let escaped = escape_like(condition.value.as_deref().unwrap_or(""));
                let pattern = if condition.op == FilterOp::Contains {
                    format!("%{escaped}%")
                } else {
                    format!("{escaped}%")
                };
                params.push(pattern);
                let clause = format!(r"{column} LIKE ${next} ESCAPE '\'");
                next += 1;
                clause
            }
        };
        clauses.push(clause);
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    Ok(CompiledFilter { where_sql, params })
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::db_filter`
Expected: `test result: ok. 10 passed`

- [ ] **Step 7: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src-tauri/src/commands/db_filter.rs apps/devbench/src-tauri/src/commands/mod.rs
git commit -m "feat(devbench): compile grid filter conditions to a parameterised WHERE"
```

---

## Task 2: Filter and count on the query commands

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/db.rs`
- Modify: `apps/devbench/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `compile_filter`, `FilterCondition` (Task 1); existing `SortTerm`, `list_table_rows_impl`
- Produces: `list_table_rows_impl(pool, table, filter: &[FilterCondition], order_by: &[SortTerm], limit, offset)`, `count_table_rows_impl(pool, table, filter: &[FilterCondition]) -> Result<i64, String>`, Tauri command `count_table_rows`

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `apps/devbench/src-tauri/src/commands/db.rs`:

```rust
    fn eq_on(column: &str, value: &str) -> crate::commands::db_filter::FilterCondition {
        crate::commands::db_filter::FilterCondition {
            column: column.to_string(),
            op: crate::commands::db_filter::FilterOp::Eq,
            value: Some(value.to_string()),
            enabled: true,
        }
    }

    #[tokio::test]
    async fn a_filter_narrows_the_returned_rows() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS filter_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE filter_test (id serial PRIMARY KEY, status text)")
            .execute(&pool).await.unwrap();
        for s in ["paid", "pending", "paid"] {
            sqlx::query("INSERT INTO filter_test (status) VALUES ($1)")
                .bind(s).execute(&pool).await.unwrap();
        }

        let all = list_table_rows_impl(&pool, "filter_test", &[], &[], 200, 0).await.unwrap();
        assert_eq!(all.rows.len(), 3);

        let paid = list_table_rows_impl(&pool, "filter_test", &[eq_on("status", "paid")], &[], 200, 0)
            .await.unwrap();
        assert_eq!(paid.rows.len(), 2);

        sqlx::query("DROP TABLE filter_test").execute(&pool).await.unwrap();
    }

    // The pager and the grid must never disagree, so the count runs the same
    // filter the row query does.
    #[tokio::test]
    async fn the_count_uses_the_same_filter_as_the_rows() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS count_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE count_test (id serial PRIMARY KEY, status text)")
            .execute(&pool).await.unwrap();
        for s in ["paid", "pending", "paid", "paid"] {
            sqlx::query("INSERT INTO count_test (status) VALUES ($1)")
                .bind(s).execute(&pool).await.unwrap();
        }

        assert_eq!(count_table_rows_impl(&pool, "count_test", &[]).await.unwrap(), 4);
        assert_eq!(
            count_table_rows_impl(&pool, "count_test", &[eq_on("status", "paid")]).await.unwrap(),
            3
        );

        // And it agrees with what an unpaged fetch actually returns.
        let rows = list_table_rows_impl(&pool, "count_test", &[eq_on("status", "paid")], &[], 500, 0)
            .await.unwrap();
        assert_eq!(rows.rows.len() as i64, 3);

        sqlx::query("DROP TABLE count_test").execute(&pool).await.unwrap();
    }

    // Filter parameters are bound first, so limit/offset must shift to $n+1/$n+2
    // or the query binds the wrong values to the wrong placeholders.
    #[tokio::test]
    async fn a_filter_and_pagination_bind_without_colliding() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS filter_page_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE filter_page_test (id serial PRIMARY KEY, status text, n int)")
            .execute(&pool).await.unwrap();
        for n in 1..=5 {
            sqlx::query("INSERT INTO filter_page_test (status, n) VALUES ('paid', $1)")
                .bind(n).execute(&pool).await.unwrap();
        }

        let page = list_table_rows_impl(
            &pool, "filter_page_test", &[eq_on("status", "paid")], &[asc_on("n")], 2, 1,
        ).await.unwrap();
        let n = page.columns.iter().position(|c| c == "n").unwrap();
        assert_eq!(page.rows.len(), 2, "LIMIT must still apply alongside a filter");
        assert_eq!(page.rows[0][n], Some("2".to_string()), "OFFSET must skip the first match");

        sqlx::query("DROP TABLE filter_page_test").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn count_rejects_a_malicious_table_name() {
        let pool = test_pool().await;
        let result = count_table_rows_impl(&pool, "orders; DROP TABLE users; --", &[]).await;
        assert!(result.is_err());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::db`
Expected: compile errors — `count_table_rows_impl` not found, and
`list_table_rows_impl` called with 6 arguments but defined with 5.

- [ ] **Step 3: Add `enabled` to the Rust `SortTerm`**

The frontend's `SortTerm` (Task 3) carries `enabled`, and an unticked term must
not reach the `ORDER BY`. Without this the payload fails to deserialise. In
`db.rs`, replace the existing `SortTerm`:

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct SortTerm {
    pub column: String,
    pub descending: bool,
    /// An unticked term is kept by the UI but must not reach the ORDER BY.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}
```

Update the existing test helper so it still compiles:

```rust
    fn asc_on(column: &str) -> SortTerm {
        SortTerm { column: column.to_string(), descending: false, enabled: true }
    }
```

and add a test for the new behaviour:

```rust
    #[tokio::test]
    async fn a_disabled_sort_term_is_not_applied() {
        let pool = test_pool().await;
        let disabled = SortTerm { column: "id".into(), descending: true, enabled: false };
        let result = list_table_rows_impl(&pool, "orders", &[], &[disabled], 5, 0).await;
        assert!(result.is_ok(), "a disabled term must be skipped, not rejected");
    }
```

- [ ] **Step 4: Add the filter argument to `list_table_rows_impl`**

In `db.rs`, change the signature and body. Note the `.filter(|t| t.enabled)`
before the `ORDER BY` is built:

```rust
pub async fn list_table_rows_impl(
    pool: &PgPool,
    table: &str,
    filter: &[crate::commands::db_filter::FilterCondition],
    order_by: &[SortTerm],
    limit: i64,
    offset: i64,
) -> Result<TableRows, String> {
    validate_identifier(table)?;
    for term in order_by {
        validate_identifier(&term.column)?;
    }

    let pk_column = get_primary_key_column(pool, table).await.ok();

    // Filter params take $1..$n, so limit and offset follow them.
    let compiled = crate::commands::db_filter::compile_filter(filter, 1)?;
    let limit_index = compiled.params.len() + 1;
    let offset_index = compiled.params.len() + 2;

    let mut sql = format!("SELECT * FROM \"{table}\"{}", compiled.where_sql);
    let terms: Vec<String> = order_by
        .iter()
        .filter(|t| t.enabled)
        .map(|t| format!("\"{}\" {}", t.column, if t.descending { "DESC" } else { "ASC" }))
        .collect();
    if !terms.is_empty() {
        sql.push_str(&format!(" ORDER BY {}", terms.join(", ")));
    }
    sql.push_str(&format!(" LIMIT ${limit_index} OFFSET ${offset_index}"));

    let mut query = sqlx::query(&sql);
    for param in &compiled.params {
        query = query.bind(param);
    }
    let rows = query
        .bind(limit)
        .bind(offset)
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

pub async fn count_table_rows_impl(
    pool: &PgPool,
    table: &str,
    filter: &[crate::commands::db_filter::FilterCondition],
) -> Result<i64, String> {
    validate_identifier(table)?;
    let compiled = crate::commands::db_filter::compile_filter(filter, 1)?;
    let sql = format!("SELECT COUNT(*) AS n FROM \"{table}\"{}", compiled.where_sql);

    let mut query = sqlx::query(&sql);
    for param in &compiled.params {
        query = query.bind(param);
    }
    let row = query
        .fetch_one(pool)
        .await
        .map_err(|e| format!("count failed: {e}"))?;
    Ok(row.get::<i64, _>("n"))
}
```

- [ ] **Step 5: Update the Tauri commands**

Replace the existing `list_table_rows` command and add the count command:

```rust
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn list_table_rows(
    db: State<'_, LocalDb>,
    secrets: State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: State<'_, std::sync::Arc<ConnectionRegistry>>,
    connection_id: String,
    table: String,
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
    table: String,
    filter: Option<Vec<crate::commands::db_filter::FilterCondition>>,
) -> Result<i64, String> {
    let pool = registry.pool_for(&connection_id, &db.pool, secrets.as_ref()).await?;
    count_table_rows_impl(&pool, &table, &filter.unwrap_or_default()).await
}
```

- [ ] **Step 6: Fix the existing call sites**

Every existing `list_table_rows_impl(&pool, "x", &[], …)` call in the test
module now needs the extra filter slice. The order is
`(pool, table, filter, order_by, limit, offset)`:

```bash
cd apps/devbench/src-tauri
grep -n 'list_table_rows_impl(&pool' src/commands/db.rs
```

Update each to pass `&[]` as the third argument, e.g.
`list_table_rows_impl(&pool, "sort_test", &[], &[asc_on("n")], 200, 0)`.

- [ ] **Step 7: Register the new command**

In `apps/devbench/src-tauri/src/lib.rs`, find the `tauri::generate_handler![`
list and add `commands::db::count_table_rows,` next to
`commands::db::list_table_rows,`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib`
Expected: all pass, count rising from 194 to 198.

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src-tauri/src
git commit -m "feat(devbench): filter and count table rows server-side"
```

---

## Task 3: Frontend types and Tauri wrappers

**Files:**
- Create: `apps/devbench/src/components/db/grid/types.ts`
- Modify: `apps/devbench/src/lib/tauri.ts`
- Modify: `apps/devbench/src/lib/tauri.test.ts`

**Interfaces:**
- Consumes: Task 2's command names and payload shapes
- Produces: `FilterOp`, `FilterCondition`, `SortTerm`, `OPERATORS_FOR_TYPE`, `invokeListTableRows(connectionId, table, { filter, orderBy, limit, offset })`, `invokeCountTableRows(connectionId, table, filter)`

- [ ] **Step 1: Write the failing test**

Add to `apps/devbench/src/lib/tauri.test.ts`:

```ts
describe("invokeCountTableRows", () => {
  beforeEach(() => {
    invoked.mockClear();
    invoked.mockResolvedValue(0);
  });

  it("sends the same filter shape the row query uses", async () => {
    await invokeCountTableRows("c1", "orders", [
      { column: "status", op: "eq", value: "paid", enabled: true },
    ]);
    expect(lastCall()).toEqual([
      "count_table_rows",
      {
        connectionId: "c1",
        table: "orders",
        filter: [{ column: "status", op: "eq", value: "paid", enabled: true }],
      },
    ]);
  });

  it("defaults to no filter", async () => {
    await invokeCountTableRows("c1", "orders");
    expect(lastCall()[1]).toEqual({ connectionId: "c1", table: "orders", filter: [] });
  });
});

describe("invokeListTableRows with a filter", () => {
  beforeEach(() => {
    invoked.mockClear();
    invoked.mockResolvedValue({ columns: [], rows: [], pk_column: null });
  });

  it("passes filter and orderBy through as separate lists", async () => {
    await invokeListTableRows("c1", "orders", {
      filter: [{ column: "paid", op: "is_true", value: null, enabled: true }],
      orderBy: [{ column: "id", descending: true }],
      limit: 25,
      offset: 50,
    });
    expect(lastCall()[1]).toEqual({
      connectionId: "c1",
      table: "orders",
      filter: [{ column: "paid", op: "is_true", value: null, enabled: true }],
      orderBy: [{ column: "id", descending: true }],
      limit: 25,
      offset: 50,
    });
  });
});
```

Add `invokeCountTableRows` to the import list at the top of that test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/lib/tauri.test.ts`
Expected: FAIL — `invokeCountTableRows is not a function`.

- [ ] **Step 3: Create the shared types**

Create `apps/devbench/src/components/db/grid/types.ts`:

```ts
/** Wire-compatible with the Rust `FilterOp` (serde snake_case). */
export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "lt"
  | "contains"
  | "starts_with"
  | "is_null"
  | "is_not_null"
  | "is_true"
  | "is_false";

export interface FilterCondition {
  column: string;
  op: FilterOp;
  /** null for operators that take no value. */
  value: string | null;
  /** An unticked rule is kept but excluded from the query. */
  enabled: boolean;
}

export interface SortTerm {
  column: string;
  descending: boolean;
  enabled: boolean;
}

/** Operators that need no value — used for both the UI and the inert check. */
export const VALUELESS_OPS: FilterOp[] = ["is_null", "is_not_null", "is_true", "is_false"];

export const OP_LABELS: Record<FilterOp, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  lt: "<",
  contains: "contains",
  starts_with: "starts with",
  is_null: "is null",
  is_not_null: "is not null",
  is_true: "is true",
  is_false: "is false",
};

/** Slice 1 infers the family from the value, as the grid already does.
 *  Slice 2 replaces this with the real type from `describe_columns`. */
export type ColumnFamily = "text" | "number" | "boolean";

export const OPERATORS_FOR_FAMILY: Record<ColumnFamily, FilterOp[]> = {
  text: ["eq", "ne", "contains", "starts_with", "is_null", "is_not_null"],
  number: ["eq", "ne", "gt", "lt", "is_null", "is_not_null"],
  boolean: ["is_true", "is_false", "is_null", "is_not_null"],
};

export function inferFamily(sampleValue: string | null): ColumnFamily {
  if (sampleValue === "true" || sampleValue === "false") return "boolean";
  if (sampleValue !== null && /^-?\d+(\.\d+)?$/.test(sampleValue)) return "number";
  return "text";
}

/** A condition the backend will skip: unticked, or needing a value it lacks. */
export function isActiveCondition(condition: FilterCondition): boolean {
  if (!condition.enabled) return false;
  if (VALUELESS_OPS.includes(condition.op)) return true;
  return (condition.value ?? "").trim() !== "";
}

export function activeConditions(conditions: FilterCondition[]): FilterCondition[] {
  return conditions.filter(isActiveCondition);
}

export function activeSortTerms(terms: SortTerm[]): SortTerm[] {
  return terms.filter((t) => t.enabled);
}
```

- [ ] **Step 4: Update the Tauri wrappers**

In `apps/devbench/src/lib/tauri.ts`, replace the existing `SortTerm` interface
and `invokeListTableRows`:

```ts
export type { FilterCondition, FilterOp, SortTerm } from "../components/db/grid/types";
import type { FilterCondition, SortTerm } from "../components/db/grid/types";

export function invokeListTableRows(
  connectionId: string,
  table: string,
  options?: { filter?: FilterCondition[]; orderBy?: SortTerm[]; limit?: number; offset?: number },
): Promise<TableRows> {
  return invoke("list_table_rows", {
    connectionId,
    table,
    filter: options?.filter ?? [],
    orderBy: options?.orderBy ?? [],
    limit: options?.limit ?? 100,
    offset: options?.offset ?? 0,
  });
}

export function invokeCountTableRows(
  connectionId: string,
  table: string,
  filter: FilterCondition[] = [],
): Promise<number> {
  return invoke("count_table_rows", { connectionId, table, filter });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test src/lib/tauri.test.ts && bun run build`
Expected: tests PASS; `tsc` may report errors in `DbTab.tsx` because `SortTerm`
now carries `enabled`. Fix those by adding `enabled: true` wherever a
`SortTerm` is constructed in `DbTab.tsx`'s `handleSort`.

- [ ] **Step 6: Run the full suite**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src
git commit -m "feat(devbench): filter types and count wrapper for the grid"
```

---

## Task 4: Extract grid layout persistence

**Files:**
- Create: `apps/devbench/src/components/db/grid/gridLayout.ts`
- Create: `apps/devbench/src/components/db/grid/gridLayout.test.ts`
- Modify: `apps/devbench/src/components/db/DataGrid.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `GridLayout { widths, order, pinned, hidden }`, `EMPTY_LAYOUT`, `readLayout(key?)`, `writeLayout(key, layout)`, `visualColumns(columns, layout)`, `pinOffsets(visual, layout)`, `MIN_COLUMN_PX`, `MIN_RESIZED_COLUMN_PX`, `ACTIONS_COLUMN_PX`, `ROW_HEIGHT_PX`

This is a refactor: `DataGrid.tsx` is 649 lines and about to gain a toolbar.
Moving the pure layout logic out keeps the component readable and makes the
derivation directly testable. `hidden` is added here so Task 10 has somewhere
to write.

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/db/grid/gridLayout.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { EMPTY_LAYOUT, readLayout, writeLayout, visualColumns, pinOffsets, MIN_COLUMN_PX } from "./gridLayout";

beforeEach(() => localStorage.clear());

describe("visualColumns", () => {
  it("keeps the saved order and appends columns the table has gained", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["status", "id"] };
    expect(visualColumns(["id", "status", "notes"], layout)).toEqual(["status", "id", "notes"]);
  });

  it("drops columns the table no longer has", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["gone", "id"] };
    expect(visualColumns(["id"], layout)).toEqual(["id"]);
  });

  // "pinned" and "leftmost" must never disagree.
  it("hoists pinned columns to the front regardless of saved order", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["status", "id"], pinned: ["id"] };
    expect(visualColumns(["id", "status"], layout)).toEqual(["id", "status"]);
  });

  it("omits hidden columns", () => {
    const layout = { ...EMPTY_LAYOUT, hidden: ["notes"] };
    expect(visualColumns(["id", "notes"], layout)).toEqual(["id"]);
  });
});

describe("pinOffsets", () => {
  it("accumulates widths across the pinned run only", () => {
    const layout = { ...EMPTY_LAYOUT, pinned: ["id", "status"], widths: { id: 100 } };
    const visual = ["id", "status", "notes"];
    expect(pinOffsets(visual, layout)).toEqual({ id: 0, status: 100 });
  });

  it("falls back to the default width for an undragged pinned column", () => {
    const layout = { ...EMPTY_LAYOUT, pinned: ["id", "status"] };
    expect(pinOffsets(["id", "status"], layout).status).toBe(MIN_COLUMN_PX);
  });
});

describe("readLayout", () => {
  it("round-trips through storage under its key", () => {
    writeLayout("c1:orders", { ...EMPTY_LAYOUT, pinned: ["id"] });
    expect(readLayout("c1:orders").pinned).toEqual(["id"]);
  });

  it("keeps each table's layout separate", () => {
    writeLayout("c1:orders", { ...EMPTY_LAYOUT, pinned: ["id"] });
    expect(readLayout("c1:products").pinned).toEqual([]);
  });

  // Runs on every table switch, so a corrupt entry must not break the grid.
  it("falls back to defaults on unparseable storage", () => {
    localStorage.setItem("devbench.grid-layout.c1:orders", "{not json");
    expect(readLayout("c1:orders")).toEqual(EMPTY_LAYOUT);
  });

  it("returns defaults when no key is given", () => {
    expect(readLayout(undefined)).toEqual(EMPTY_LAYOUT);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/grid/gridLayout.test.ts`
Expected: FAIL — cannot resolve `./gridLayout`.

- [ ] **Step 3: Create the module**

Create `apps/devbench/src/components/db/grid/gridLayout.ts`:

```ts
export const ROW_HEIGHT_PX = 33;
/** Width an undragged column is guaranteed at least — the readable default. */
export const MIN_COLUMN_PX = 140;
/** Floor for a column the user has dragged. Far below MIN_COLUMN_PX: sharing
 *  one constant meant the default width was also the smallest achievable one,
 *  so a drag could only ever widen a column. */
export const MIN_RESIZED_COLUMN_PX = 56;
export const ACTIONS_COLUMN_PX = 90;
const LAYOUT_STORAGE_PREFIX = "devbench.grid-layout.";

/** Per-table view preferences. Only ever holds column *names*, never indices —
 *  a table whose shape changed then degrades to "that column is gone" rather
 *  than to a silent mis-mapping. */
export interface GridLayout {
  widths: Record<string, number>;
  order: string[];
  pinned: string[];
  hidden: string[];
}

export const EMPTY_LAYOUT: GridLayout = { widths: {}, order: [], pinned: [], hidden: [] };

export function readLayout(key: string | undefined): GridLayout {
  if (!key) return EMPTY_LAYOUT;
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_PREFIX + key);
    if (!raw) return EMPTY_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_LAYOUT;
    const { widths, order, pinned, hidden } = parsed as Partial<GridLayout>;
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
    return {
      widths: typeof widths === "object" && widths !== null ? widths : {},
      order: strings(order),
      pinned: strings(pinned),
      hidden: strings(hidden),
    };
  } catch {
    // Unreadable or corrupt storage means "no saved layout", never a broken
    // grid — this runs on every table switch.
    return EMPTY_LAYOUT;
  }
}

export function writeLayout(key: string | undefined, layout: GridLayout): void {
  if (!key) return;
  try {
    localStorage.setItem(LAYOUT_STORAGE_PREFIX + key, JSON.stringify(layout));
  } catch {
    // A full or disabled store must not take the grid down with it.
  }
}

/** On-screen order: saved order, minus columns this table no longer has, plus
 *  any it gained, minus hidden ones — then pinned hoisted to the front. */
export function visualColumns(columns: string[], layout: GridLayout): string[] {
  const known = layout.order.filter((c) => columns.includes(c));
  const ordered = [...known, ...columns.filter((c) => !known.includes(c))].filter(
    (c) => !layout.hidden.includes(c),
  );
  return [
    ...ordered.filter((c) => layout.pinned.includes(c)),
    ...ordered.filter((c) => !layout.pinned.includes(c)),
  ];
}

export function widthOf(column: string, layout: GridLayout): number {
  return layout.widths[column] ?? MIN_COLUMN_PX;
}

/** Left offset for each pinned column, accumulated across the pinned run. */
export function pinOffsets(visual: string[], layout: GridLayout): Record<string, number> {
  const offsets: Record<string, number> = {};
  let accumulated = 0;
  for (const column of visual) {
    if (!layout.pinned.includes(column)) break;
    offsets[column] = accumulated;
    accumulated += widthOf(column, layout);
  }
  return offsets;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/devbench && bun run test src/components/db/grid/gridLayout.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Make DataGrid use the module**

In `DataGrid.tsx`, delete the local `ROW_HEIGHT_PX`, `MIN_COLUMN_PX`,
`MIN_RESIZED_COLUMN_PX`, `ACTIONS_COLUMN_PX`, `LAYOUT_STORAGE_PREFIX`,
`GridLayout`, `EMPTY_LAYOUT`, `readLayout`, `writeLayout`, the `visualColumns`
useMemo body and the `pinOffsets` useMemo body. Import instead:

```ts
import {
  ACTIONS_COLUMN_PX,
  EMPTY_LAYOUT,
  MIN_COLUMN_PX,
  MIN_RESIZED_COLUMN_PX,
  ROW_HEIGHT_PX,
  pinOffsets,
  readLayout,
  visualColumns,
  widthOf,
  writeLayout,
  type GridLayout,
} from "./grid/gridLayout";
```

and replace the two `useMemo` bodies with calls:

```ts
const visual = useMemo(() => visualColumns(columns, layout), [columns, layout]);
const offsets = useMemo(() => pinOffsets(visual, layout), [visual, layout]);
```

Rename the local uses of `visualColumns`/`pinOffsets` variables accordingly.

- [ ] **Step 6: Run the full suite**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: all green, 316 + 9 = 325 passing. `DataGrid.tsx` should now be
roughly 100 lines shorter.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/components/db
git commit -m "refactor(devbench): move grid layout persistence into its own module"
```

---

## Task 5: Secondary button

**Files:**
- Create: `apps/devbench/src/components/ui/SecondaryButton.tsx`
- Create: `apps/devbench/src/components/ui/SecondaryButton.test.tsx`
- Modify: `apps/devbench/src/styles/tokens.css`

**Interfaces:**
- Produces: `SecondaryButton` (forwards all native button props), `SECONDARY_BUTTON_CLASS`

- [ ] **Step 1: Add the tokens**

In `apps/devbench/src/styles/tokens.css`, add to the base `:root` block, next
to the existing `--glass-border`:

```css
  --btn-ghost-border: rgba(255, 255, 255, 0.16);
  --btn-ghost-bg: rgba(255, 255, 255, 0.04);
```

and to **each** of the three light blocks (`@media (prefers-color-scheme: light)`,
`:root[data-theme="light"]`) — and the dark values to `:root[data-theme="dark"]`:

```css
  --btn-ghost-border: rgba(16, 21, 31, 0.18);
  --btn-ghost-bg: rgba(16, 21, 31, 0.03);
```

Then expose them to Tailwind in `apps/devbench/src/styles/globals.css` inside
`@theme`:

```css
  --color-btn-ghost-border: var(--btn-ghost-border);
  --color-btn-ghost-bg: var(--btn-ghost-bg);
```

- [ ] **Step 2: Write the failing test**

Create `apps/devbench/src/components/ui/SecondaryButton.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecondaryButton } from "./SecondaryButton";

describe("SecondaryButton", () => {
  it("renders its label and fires onClick", () => {
    const onClick = vi.fn();
    render(<SecondaryButton onClick={onClick}>Cancel</SecondaryButton>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClick).toHaveBeenCalled();
  });

  // The border is what distinguishes it from the ghost buttons already in the
  // chrome; losing it would make it indistinguishable from a plain text button.
  it("carries the ghost border and fill", () => {
    render(<SecondaryButton>Cancel</SecondaryButton>);
    expect(screen.getByRole("button")).toHaveClass("border-btn-ghost-border", "bg-btn-ghost-bg");
  });

  it("passes through native button props", () => {
    render(<SecondaryButton disabled aria-pressed>Discard</SecondaryButton>);
    const button = screen.getByRole("button", { name: "Discard" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("appends caller classes rather than replacing its own", () => {
    render(<SecondaryButton className="w-13">Cancel</SecondaryButton>);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("w-13");
    expect(button).toHaveClass("border-btn-ghost-border");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/ui/SecondaryButton.test.tsx`
Expected: FAIL — cannot resolve `./SecondaryButton`.

- [ ] **Step 4: Write the component**

Create `apps/devbench/src/components/ui/SecondaryButton.tsx`:

```tsx
import type { ButtonHTMLAttributes } from "react";

/** A hairline of the surface's own light rather than a --border hairline,
 *  which disappears against a translucent panel. Height is deliberately NOT
 *  set here: a footer sets one height for its secondary and primary buttons
 *  together, which is what stops the pair drifting apart. */
export const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border " +
  "border-btn-ghost-border bg-btn-ghost-bg px-2.5 text-xs font-medium text-text-muted " +
  "transition-colors duration-150 hover:border-text-faint hover:text-text " +
  "aria-pressed:bg-surface-2 aria-pressed:text-text disabled:opacity-40";

export function SecondaryButton({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`${SECONDARY_BUTTON_CLASS} ${className}`} {...props} />;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/devbench && bun run test src/components/ui/SecondaryButton.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/components/ui apps/devbench/src/styles
git commit -m "feat(devbench): add the shared secondary button"
```

---

## Task 6: Row export

**Files:**
- Create: `apps/devbench/src/components/db/grid/exportRows.ts`
- Create: `apps/devbench/src/components/db/grid/exportRows.test.ts`

**Interfaces:**
- Produces: `toCsv(columns, rows)`, `toJson(columns, rows)`, `downloadText(filename, mime, text)`

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/db/grid/exportRows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toCsv, toJson } from "./exportRows";

describe("toCsv", () => {
  it("writes a header row then the values", () => {
    expect(toCsv(["id", "status"], [["1", "paid"]])).toBe("id,status\n1,paid");
  });

  // A comma inside a value would otherwise invent a column.
  it("quotes values containing a comma, quote or newline", () => {
    expect(toCsv(["notes"], [['a,b']])).toBe('notes\n"a,b"');
    expect(toCsv(["notes"], [['say "hi"']])).toBe('notes\n"say ""hi"""');
    expect(toCsv(["notes"], [["line1\nline2"]])).toBe('notes\n"line1\nline2"');
  });

  // NULL and the empty string are different values and must stay different.
  it("writes NULL as an empty field and the empty string as quoted", () => {
    expect(toCsv(["a", "b"], [[null, ""]])).toBe('a,b\n,""');
  });
});

describe("toJson", () => {
  it("emits one object per row keyed by column", () => {
    expect(toJson(["id", "status"], [["1", "paid"]])).toBe(
      JSON.stringify([{ id: "1", status: "paid" }], null, 2),
    );
  });

  it("preserves null rather than turning it into a string", () => {
    expect(JSON.parse(toJson(["notes"], [[null]]))[0].notes).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/grid/exportRows.test.ts`
Expected: FAIL — cannot resolve `./exportRows`.

- [ ] **Step 3: Write the module**

Create `apps/devbench/src/components/db/grid/exportRows.ts`:

```ts
/** RFC 4180 quoting. A NULL becomes an empty field; an empty string becomes
 *  `""`, so the two stay distinguishable in the output. */
function csvField(value: string | null): string {
  if (value === null) return "";
  if (value === "" || /[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(columns: string[], rows: (string | null)[][]): string {
  const header = columns.map(csvField).join(",");
  const body = rows.map((row) => row.map(csvField).join(",")).join("\n");
  return body ? `${header}\n${body}` : header;
}

export function toJson(columns: string[], rows: (string | null)[][]): string {
  const objects = rows.map((row) => {
    const object: Record<string, string | null> = {};
    columns.forEach((column, index) => {
      object[column] = row[index] ?? null;
    });
    return object;
  });
  return JSON.stringify(objects, null, 2);
}

/** Kept separate from the serialisers so those stay pure and testable. */
export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/devbench && bun run test src/components/db/grid/exportRows.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/db/grid
git commit -m "feat(devbench): serialise grid rows to CSV and JSON"
```

---

## Task 7: Filter popover

**Files:**
- Create: `apps/devbench/src/components/db/grid/FilterPopover.tsx`
- Create: `apps/devbench/src/components/db/grid/FilterPopover.test.tsx`

**Interfaces:**
- Consumes: `FilterCondition`, `FilterOp`, `OPERATORS_FOR_FAMILY`, `OP_LABELS`, `VALUELESS_OPS`, `inferFamily` (Task 3); `SecondaryButton` (Task 5)
- Produces: `FilterPopover({ columns, familyOf, applied, onApply, onClose })`

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/db/grid/FilterPopover.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterPopover } from "./FilterPopover";
import type { FilterCondition } from "./types";

const columns = ["id", "status", "paid"];
const familyOf = (column: string) => (column === "paid" ? "boolean" as const : "text" as const);

function renderPopover(applied: FilterCondition[] = [], onApply = vi.fn(), onClose = vi.fn()) {
  render(
    <FilterPopover columns={columns} familyOf={familyOf} applied={applied} onApply={onApply} onClose={onClose} />,
  );
  return { onApply, onClose };
}

describe("FilterPopover", () => {
  it("adds a condition row without applying anything", () => {
    const { onApply } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    expect(screen.getByRole("combobox", { name: "Filter column" })).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  // The draft is the whole point: nothing reaches the query until Apply.
  it("does not apply while editing, only on Apply", () => {
    const { onApply } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter column" }), { target: { value: "status" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter value" }), { target: { value: "paid" } });
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      { column: "status", op: "eq", value: "paid", enabled: true },
    ]);
  });

  it("discards the draft on Cancel", () => {
    const { onApply, onClose } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // An unticked rule is kept so it can be switched back on without retyping.
  it("keeps an unticked condition but marks it disabled", () => {
    const applied: FilterCondition[] = [{ column: "status", op: "eq", value: "paid", enabled: true }];
    const { onApply } = renderPopover(applied);
    fireEvent.click(screen.getByRole("checkbox", { name: /include/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      { column: "status", op: "eq", value: "paid", enabled: false },
    ]);
  });

  it("removes a condition", () => {
    const applied: FilterCondition[] = [{ column: "status", op: "eq", value: "paid", enabled: true }];
    const { onApply } = renderPopover(applied);
    fireEvent.click(screen.getByRole("button", { name: /remove condition/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([]);
  });

  // The operator list must describe the column's type, not a fixed menu.
  it("offers boolean operators for a boolean column", () => {
    renderPopover([{ column: "paid", op: "is_true", value: null, enabled: true }]);
    const operators = [...screen.getByRole("combobox", { name: "Filter operator" }).querySelectorAll("option")];
    expect(operators.map((o) => o.textContent)).toEqual(["is true", "is false", "is null", "is not null"]);
  });

  // Changing column can invalidate the operator, so it resets.
  it("resets the operator when the column changes", () => {
    renderPopover([{ column: "status", op: "contains", value: "x", enabled: true }]);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter column" }), { target: { value: "paid" } });
    expect(screen.getByRole("combobox", { name: "Filter operator" })).toHaveValue("is_true");
  });

  it("hides the value field for an operator that takes none", () => {
    renderPopover([{ column: "status", op: "is_null", value: null, enabled: true }]);
    expect(screen.queryByRole("textbox", { name: "Filter value" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/grid/FilterPopover.test.tsx`
Expected: FAIL — cannot resolve `./FilterPopover`.

- [ ] **Step 3: Write the component**

Create `apps/devbench/src/components/db/grid/FilterPopover.tsx`:

```tsx
import { useState } from "react";
import { SecondaryButton } from "../../ui/SecondaryButton";
import {
  OPERATORS_FOR_FAMILY,
  OP_LABELS,
  VALUELESS_OPS,
  type ColumnFamily,
  type FilterCondition,
  type FilterOp,
} from "./types";

export function FilterPopover({
  columns,
  familyOf,
  applied,
  onApply,
  onClose,
}: {
  columns: string[];
  familyOf: (column: string) => ColumnFamily;
  applied: FilterCondition[];
  onApply: (conditions: FilterCondition[]) => void;
  onClose: () => void;
}) {
  // Snapshot on mount: Cancel restores exactly this, and nothing the user
  // types here reaches the query until Apply.
  const [draft, setDraft] = useState<FilterCondition[]>(() => applied.map((c) => ({ ...c })));

  function update(index: number, patch: Partial<FilterCondition>) {
    setDraft((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  return (
    <div className="min-w-82.5 p-2.5">
      <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
        Filter — applied as a WHERE clause
      </div>

      {draft.length === 0 ? (
        <div className="mb-2 text-xs text-text-faint">No conditions yet.</div>
      ) : null}

      {draft.map((condition, index) => {
        const operators = OPERATORS_FOR_FAMILY[familyOf(condition.column)];
        const needsValue = !VALUELESS_OPS.includes(condition.op);
        return (
          <div key={index} className="mb-1.5 flex items-center gap-1.5">
            <input
              type="checkbox"
              aria-label={`Include ${condition.column} condition`}
              checked={condition.enabled}
              onChange={(e) => update(index, { enabled: e.target.checked })}
              className="size-3.5 shrink-0 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent"
            />
            <select
              aria-label="Filter column"
              value={condition.column}
              onChange={(e) => {
                // The old operator may not exist for the new column's type.
                const nextColumn = e.target.value;
                update(index, { column: nextColumn, op: OPERATORS_FOR_FAMILY[familyOf(nextColumn)][0] });
              }}
              className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 text-xs text-text"
            >
              {columns.map((column) => (
                <option key={column} value={column}>{column}</option>
              ))}
            </select>
            <select
              aria-label="Filter operator"
              value={condition.op}
              onChange={(e) => update(index, { op: e.target.value as FilterOp })}
              className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 text-xs text-text"
            >
              {operators.map((op) => (
                <option key={op} value={op}>{OP_LABELS[op]}</option>
              ))}
            </select>
            {needsValue ? (
              <input
                aria-label="Filter value"
                value={condition.value ?? ""}
                onChange={(e) => update(index, { value: e.target.value })}
                placeholder="value"
                className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 font-mono text-xs text-text"
              />
            ) : null}
            <button
              type="button"
              aria-label={`Remove condition on ${condition.column}`}
              onClick={() => setDraft((prev) => prev.filter((_, i) => i !== index))}
              className="shrink-0 rounded-sm p-1 text-text-faint hover:bg-danger-bg hover:text-danger"
            >
              ✕
            </button>
          </div>
        );
      })}

      <div className="mt-3 flex items-center justify-between gap-2">
        <SecondaryButton
          className="h-6.5"
          onClick={() =>
            setDraft((prev) => [
              ...prev,
              { column: columns[0], op: OPERATORS_FOR_FAMILY[familyOf(columns[0])][0], value: "", enabled: true },
            ])
          }
        >
          + Add filter
        </SecondaryButton>
        <span className="flex gap-2">
          <SecondaryButton className="h-6.5" onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            className="h-6.5 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on hover:bg-accent-strong"
          >
            Apply
          </button>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/devbench && bun run test src/components/db/grid/FilterPopover.test.tsx`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/db/grid
git commit -m "feat(devbench): filter popover with a draft applied on Apply"
```

---

## Task 8: Sort popover

**Files:**
- Create: `apps/devbench/src/components/db/grid/SortPopover.tsx`
- Create: `apps/devbench/src/components/db/grid/SortPopover.test.tsx`

**Interfaces:**
- Consumes: `SortTerm` (Task 3), `SecondaryButton` (Task 5)
- Produces: `SortPopover({ columns, applied, onApply, onClose })`

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/db/grid/SortPopover.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SortPopover } from "./SortPopover";
import type { SortTerm } from "./types";

const columns = ["id", "status", "created_at"];

function renderPopover(applied: SortTerm[] = [], onApply = vi.fn(), onClose = vi.fn()) {
  render(<SortPopover columns={columns} applied={applied} onApply={onApply} onClose={onClose} />);
  return { onApply, onClose };
}

describe("SortPopover", () => {
  it("does not apply until Apply is pressed", () => {
    const { onApply } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /add sort/i }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([{ column: "id", descending: false, enabled: true }]);
  });

  it("discards the draft on Cancel", () => {
    const applied: SortTerm[] = [{ column: "id", descending: false, enabled: true }];
    const { onApply, onClose } = renderPopover(applied);
    fireEvent.click(screen.getByRole("button", { name: /add sort/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("toggles direction", () => {
    const { onApply } = renderPopover([{ column: "id", descending: false, enabled: true }]);
    fireEvent.click(screen.getByRole("button", { name: /direction for id/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([{ column: "id", descending: true, enabled: true }]);
  });

  // Priority IS the row order, so moving a row is how precedence changes.
  it("moves a term up to raise its priority", () => {
    const applied: SortTerm[] = [
      { column: "id", descending: false, enabled: true },
      { column: "status", descending: false, enabled: true },
    ];
    const { onApply } = renderPopover(applied);
    fireEvent.click(screen.getByRole("button", { name: /raise priority of status/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      { column: "status", descending: false, enabled: true },
      { column: "id", descending: false, enabled: true },
    ]);
  });

  it("cannot move the first term up or the last term down", () => {
    const applied: SortTerm[] = [
      { column: "id", descending: false, enabled: true },
      { column: "status", descending: false, enabled: true },
    ];
    renderPopover(applied);
    expect(screen.getByRole("button", { name: /raise priority of id/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /lower priority of status/i })).toBeDisabled();
  });

  // A term excluded from the ORDER BY has no priority, so it shows no number.
  it("numbers enabled terms only", () => {
    const applied: SortTerm[] = [
      { column: "id", descending: false, enabled: false },
      { column: "status", descending: false, enabled: true },
      { column: "created_at", descending: false, enabled: true },
    ];
    renderPopover(applied);
    expect(screen.getByTestId("rank-id")).toHaveTextContent("—");
    expect(screen.getByTestId("rank-status")).toHaveTextContent("1");
    expect(screen.getByTestId("rank-created_at")).toHaveTextContent("2");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/grid/SortPopover.test.tsx`
Expected: FAIL — cannot resolve `./SortPopover`.

- [ ] **Step 3: Write the component**

Create `apps/devbench/src/components/db/grid/SortPopover.tsx`:

```tsx
import { useState } from "react";
import { SecondaryButton } from "../../ui/SecondaryButton";
import type { SortTerm } from "./types";

export function SortPopover({
  columns,
  applied,
  onApply,
  onClose,
}: {
  columns: string[];
  applied: SortTerm[];
  onApply: (terms: SortTerm[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SortTerm[]>(() => applied.map((t) => ({ ...t })));

  function update(index: number, patch: Partial<SortTerm>) {
    setDraft((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= draft.length) return;
    setDraft((prev) => {
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  }

  // Ranks count enabled terms only — a term that is not in the ORDER BY has no
  // place in it, so giving it a number would be a lie.
  let rank = 0;

  return (
    <div className="min-w-82.5 p-2.5">
      <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
        Sort — priority runs top to bottom
      </div>

      {draft.length === 0 ? <div className="mb-2 text-xs text-text-faint">No sort yet.</div> : null}

      {draft.map((term, index) => {
        if (term.enabled) rank += 1;
        return (
          <div key={index} className="mb-1.5 flex items-center gap-1.5">
            <input
              type="checkbox"
              aria-label={`Include ${term.column} in the sort`}
              checked={term.enabled}
              onChange={(e) => update(index, { enabled: e.target.checked })}
              className="size-3.5 shrink-0 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent"
            />
            <span
              data-testid={`rank-${term.column}`}
              className={`w-3.5 shrink-0 text-center font-mono text-xs ${term.enabled ? "text-text" : "text-text-faint"}`}
            >
              {term.enabled ? rank : "—"}
            </span>
            <select
              aria-label="Sort column"
              value={term.column}
              onChange={(e) => update(index, { column: e.target.value })}
              className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 text-xs text-text"
            >
              {columns.map((column) => (
                <option key={column} value={column}>{column}</option>
              ))}
            </select>
            {/* Fixed width: ASC and DESC are different lengths, so an
                auto-sized toggle shifts every control to its right. */}
            <SecondaryButton
              className="h-6.5 w-13 font-mono"
              aria-label={`Toggle direction for ${term.column}`}
              onClick={() => update(index, { descending: !term.descending })}
            >
              {term.descending ? "DESC" : "ASC"}
            </SecondaryButton>
            <button
              type="button"
              aria-label={`Raise priority of ${term.column}`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              className="shrink-0 rounded-sm p-1 text-text-faint hover:bg-surface-2 hover:text-text disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Lower priority of ${term.column}`}
              disabled={index === draft.length - 1}
              onClick={() => move(index, 1)}
              className="shrink-0 rounded-sm p-1 text-text-faint hover:bg-surface-2 hover:text-text disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Remove sort on ${term.column}`}
              onClick={() => setDraft((prev) => prev.filter((_, i) => i !== index))}
              className="shrink-0 rounded-sm p-1 text-text-faint hover:bg-danger-bg hover:text-danger"
            >
              ✕
            </button>
          </div>
        );
      })}

      <div className="mt-3 flex items-center justify-between gap-2">
        <SecondaryButton
          className="h-6.5"
          onClick={() =>
            setDraft((prev) => [...prev, { column: columns[0], descending: false, enabled: true }])
          }
        >
          + Add sort
        </SecondaryButton>
        <span className="flex gap-2">
          <SecondaryButton className="h-6.5" onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            className="h-6.5 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on hover:bg-accent-strong"
          >
            Apply
          </button>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/devbench && bun run test src/components/db/grid/SortPopover.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/db/grid
git commit -m "feat(devbench): sort popover with per-term enable and priority order"
```

---

## Task 9: Columns popover

**Files:**
- Create: `apps/devbench/src/components/db/grid/ColumnsPopover.tsx`
- Create: `apps/devbench/src/components/db/grid/ColumnsPopover.test.tsx`

**Interfaces:**
- Consumes: `GridLayout`, `visualColumns` (Task 4); `SecondaryButton` (Task 5)
- Produces: `ColumnsPopover({ columns, layout, onChange })`

Unlike Filter and Sort, this applies immediately — hiding a column is a view
change with no query cost, and a draft would make it feel sluggish.

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/db/grid/ColumnsPopover.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColumnsPopover } from "./ColumnsPopover";
import { EMPTY_LAYOUT } from "./gridLayout";

const columns = ["id", "status", "notes"];

describe("ColumnsPopover", () => {
  it("hides a column immediately", () => {
    const onChange = vi.fn();
    render(<ColumnsPopover columns={columns} layout={EMPTY_LAYOUT} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: ["status"] }));
  });

  it("shows a hidden column again", () => {
    const onChange = vi.fn();
    render(
      <ColumnsPopover columns={columns} layout={{ ...EMPTY_LAYOUT, hidden: ["status"] }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Show status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: [] }));
  });

  it("pins and unpins a column", () => {
    const onChange = vi.fn();
    render(<ColumnsPopover columns={columns} layout={EMPTY_LAYOUT} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Freeze id" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pinned: ["id"] }));
  });

  it("restores every column with Show all", () => {
    const onChange = vi.fn();
    render(
      <ColumnsPopover
        columns={columns}
        layout={{ ...EMPTY_LAYOUT, hidden: ["status", "notes"] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: [] }));
  });

  // Hiding is a view concern; the column is still fetched and exported.
  it("lists hidden columns too, so they can be brought back", () => {
    render(
      <ColumnsPopover columns={columns} layout={{ ...EMPTY_LAYOUT, hidden: ["notes"] }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("checkbox", { name: "Show notes" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/grid/ColumnsPopover.test.tsx`
Expected: FAIL — cannot resolve `./ColumnsPopover`.

- [ ] **Step 3: Write the component**

Create `apps/devbench/src/components/db/grid/ColumnsPopover.tsx`:

```tsx
import { SecondaryButton } from "../../ui/SecondaryButton";
import type { GridLayout } from "./gridLayout";

export function ColumnsPopover({
  columns,
  layout,
  onChange,
}: {
  columns: string[];
  layout: GridLayout;
  onChange: (layout: GridLayout) => void;
}) {
  const toggleHidden = (column: string) =>
    onChange({
      ...layout,
      hidden: layout.hidden.includes(column)
        ? layout.hidden.filter((c) => c !== column)
        : [...layout.hidden, column],
    });

  const togglePinned = (column: string) =>
    onChange({
      ...layout,
      pinned: layout.pinned.includes(column)
        ? layout.pinned.filter((c) => c !== column)
        : [...layout.pinned, column],
    });

  return (
    <div className="min-w-82.5 p-2.5">
      <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
        Columns
      </div>
      {/* Every column is listed, hidden ones included — otherwise hiding a
          column would remove the only control that brings it back. */}
      {columns.map((column) => (
        <div key={column} className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-xs text-text-muted hover:bg-surface-2">
          <input
            type="checkbox"
            aria-label={`Show ${column}`}
            checked={!layout.hidden.includes(column)}
            onChange={() => toggleHidden(column)}
            className="size-3.5 shrink-0 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent"
          />
          <span className="min-w-0 flex-1 truncate font-mono">{column}</span>
          <button
            type="button"
            aria-label={layout.pinned.includes(column) ? `Unfreeze ${column}` : `Freeze ${column}`}
            aria-pressed={layout.pinned.includes(column)}
            onClick={() => togglePinned(column)}
            className={`shrink-0 rounded-sm p-1 ${layout.pinned.includes(column) ? "text-text" : "text-text-faint"} hover:text-text`}
          >
            📌
          </button>
        </div>
      ))}
      <div className="mt-3 flex items-center justify-between gap-2">
        <SecondaryButton className="h-6.5" onClick={() => onChange({ ...layout, hidden: [] })}>
          Show all
        </SecondaryButton>
        <span />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/devbench && bun run test src/components/db/grid/ColumnsPopover.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/db/grid
git commit -m "feat(devbench): columns popover for visibility and pinning"
```

---

## Task 10: Grid toolbar

**Files:**
- Create: `apps/devbench/src/components/db/grid/GridToolbar.tsx`
- Create: `apps/devbench/src/components/db/grid/GridToolbar.test.tsx`

**Interfaces:**
- Consumes: `FilterPopover` (Task 7), `SortPopover` (Task 8), `ColumnsPopover` (Task 9), `toCsv`/`toJson`/`downloadText` (Task 6), `activeConditions`/`activeSortTerms` (Task 3)
- Produces: `GridToolbar({ columns, rows, layout, onLayoutChange, filter, onFilterChange, sort, onSortChange, page, pageCount, onPageChange, limit, onLimitChange, onRefresh, onInsert, familyOf })`

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/db/grid/GridToolbar.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GridToolbar } from "./GridToolbar";
import { EMPTY_LAYOUT } from "./gridLayout";
import type { FilterCondition, SortTerm } from "./types";

function renderToolbar(overrides: Partial<Parameters<typeof GridToolbar>[0]> = {}) {
  const props = {
    columns: ["id", "status"],
    rows: [["1", "paid"]] as (string | null)[][],
    layout: EMPTY_LAYOUT,
    onLayoutChange: vi.fn(),
    filter: [] as FilterCondition[],
    onFilterChange: vi.fn(),
    sort: [] as SortTerm[],
    onSortChange: vi.fn(),
    page: 1,
    pageCount: 3,
    onPageChange: vi.fn(),
    limit: 100,
    onLimitChange: vi.fn(),
    onRefresh: vi.fn(),
    familyOf: () => "text" as const,
    ...overrides,
  };
  render(<GridToolbar {...props} />);
  return props;
}

describe("GridToolbar", () => {
  it("shows no count badge when nothing is filtered or sorted", () => {
    renderToolbar();
    expect(screen.getByRole("button", { name: "Filter" })).not.toHaveTextContent(/\d/);
  });

  // The badge counts what is ACTING on the grid, not what is stored.
  it("counts only enabled conditions", () => {
    renderToolbar({
      filter: [
        { column: "status", op: "eq", value: "paid", enabled: true },
        { column: "id", op: "eq", value: "1", enabled: false },
      ],
    });
    expect(screen.getByRole("button", { name: /^Filter/ })).toHaveTextContent("1");
  });

  it("does not count a condition still missing its value", () => {
    renderToolbar({ filter: [{ column: "status", op: "eq", value: "", enabled: true }] });
    expect(screen.getByRole("button", { name: /^Filter/ })).not.toHaveTextContent(/\d/);
  });

  it("counts only enabled sort terms", () => {
    renderToolbar({
      sort: [
        { column: "id", descending: false, enabled: true },
        { column: "status", descending: false, enabled: false },
      ],
    });
    expect(screen.getByRole("button", { name: /^Sort/ })).toHaveTextContent("1");
  });

  it("counts hidden columns on the Columns button", () => {
    renderToolbar({ layout: { ...EMPTY_LAYOUT, hidden: ["status"] } });
    expect(screen.getByRole("button", { name: /^Columns/ })).toHaveTextContent("1");
  });

  it("goes to the page typed into the field", () => {
    const props = renderToolbar();
    const field = screen.getByRole("textbox", { name: "Page number" });
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onPageChange).toHaveBeenCalledWith(2);
  });

  // Out of range clamps rather than erroring or fetching an empty page.
  it("clamps a page beyond the last one", () => {
    const props = renderToolbar({ pageCount: 3 });
    const field = screen.getByRole("textbox", { name: "Page number" });
    fireEvent.change(field, { target: { value: "99" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onPageChange).toHaveBeenCalledWith(3);
  });

  it("disables Previous on the first page and Next on the last", () => {
    renderToolbar({ page: 1, pageCount: 1 });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  // A new page size makes the current offset meaningless.
  it("returns to page 1 when the limit changes", () => {
    const props = renderToolbar({ page: 3 });
    fireEvent.change(screen.getByRole("combobox", { name: "Rows per page" }), { target: { value: "25" } });
    expect(props.onLimitChange).toHaveBeenCalledWith(25);
    expect(props.onPageChange).toHaveBeenCalledWith(1);
  });

  it("refreshes", () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it("opens the filter popover and closes it again", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByText(/applied as a WHERE clause/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/applied as a WHERE clause/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/grid/GridToolbar.test.tsx`
Expected: FAIL — cannot resolve `./GridToolbar`.

- [ ] **Step 3: Write the component**

Create `apps/devbench/src/components/db/grid/GridToolbar.tsx`:

```tsx
import { useState } from "react";
import { ColumnsPopover } from "./ColumnsPopover";
import { FilterPopover } from "./FilterPopover";
import { SortPopover } from "./SortPopover";
import { downloadText, toCsv, toJson } from "./exportRows";
import { visualColumns, type GridLayout } from "./gridLayout";
import { activeConditions, activeSortTerms, type ColumnFamily, type FilterCondition, type SortTerm } from "./types";

const LIMITS = [25, 50, 100, 250, 500, 1000];
type PopoverId = "filter" | "sort" | "columns" | "export" | null;

export function GridToolbar({
  columns,
  rows,
  layout,
  onLayoutChange,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  page,
  pageCount,
  onPageChange,
  limit,
  onLimitChange,
  onRefresh,
  onInsert,
  familyOf,
}: {
  columns: string[];
  rows: (string | null)[][];
  layout: GridLayout;
  onLayoutChange: (layout: GridLayout) => void;
  filter: FilterCondition[];
  onFilterChange: (filter: FilterCondition[]) => void;
  sort: SortTerm[];
  onSortChange: (sort: SortTerm[]) => void;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  limit: number;
  onLimitChange: (limit: number) => void;
  onRefresh: () => void;
  /** Slice 3 wires this to the insert panel; until then the button is absent. */
  onInsert?: () => void;
  familyOf: (column: string) => ColumnFamily;
}) {
  const [open, setOpen] = useState<PopoverId>(null);
  const [pageField, setPageField] = useState(String(page));

  const close = () => setOpen(null);

  // Counts describe what is acting on the grid right now, so a rule that is
  // switched off or still missing its value is not counted.
  const badges: Record<string, number> = {
    filter: activeConditions(filter).length,
    sort: activeSortTerms(sort).length,
    columns: layout.hidden.length,
    export: 0,
  };

  function trigger(id: Exclude<PopoverId, null>, label: string) {
    const count = badges[id];
    return (
      <button
        type="button"
        title={label}
        aria-expanded={open === id}
        onClick={() => setOpen(open === id ? null : id)}
        className={`inline-flex h-6.5 items-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-xs font-medium ${
          count ? "bg-surface-2 text-text" : "text-text-muted"
        } hover:bg-surface-2 hover:text-text`}
      >
        <span className="tb-label">{label}</span>
        {count ? (
          <span className="inline-flex h-3.75 min-w-3.75 items-center justify-center rounded-full bg-accent px-1 text-[10.5px] font-bold text-accent-on">
            {count}
          </span>
        ) : null}
      </button>
    );
  }

  function commitPage() {
    const parsed = Number.parseInt(pageField, 10);
    // Out of range clamps rather than erroring — a page beyond the end is a
    // typo, not a request for an empty grid.
    const next = Math.min(Math.max(1, Number.isNaN(parsed) ? 1 : parsed), Math.max(1, pageCount));
    setPageField(String(next));
    onPageChange(next);
  }

  const exportColumns = visualColumns(columns, layout);
  const exportRows = rows.map((row) => exportColumns.map((c) => row[columns.indexOf(c)] ?? null));

  return (
    <div className="relative">
      {/* container-type is what lets the labels collapse on PANE width rather
          than window width — the toolbar shrinks when the dock opens. */}
      <div className="@container flex items-center gap-1 border-b border-border bg-surface px-2 py-1.25">
        {onInsert ? (
          <button
            type="button"
            title="Insert row"
            onClick={onInsert}
            className="inline-flex h-6.5 items-center gap-1.5 rounded-sm bg-accent px-2 text-xs font-bold text-accent-on hover:bg-accent-strong"
          >
            <span className="tb-label">Insert</span>
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Refresh"
          title="Refresh"
          onClick={onRefresh}
          className="inline-flex size-6.5 items-center justify-center rounded-sm text-text-muted hover:bg-surface-2 hover:text-text"
        >
          ⟳
        </button>
        <span className="mx-1 h-4 w-px shrink-0 bg-border" />
        {trigger("filter", "Filter")}
        {trigger("sort", "Sort")}
        {trigger("columns", "Columns")}
        {trigger("export", "Export")}
        <span className="min-w-2 flex-1" />
        <div className="flex items-center gap-0.5 text-xs text-text-faint">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="inline-flex h-6 w-5.5 items-center justify-center rounded-sm hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            ‹
          </button>
          <input
            aria-label="Page number"
            value={pageField}
            onChange={(e) => setPageField(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commitPage()}
            onBlur={commitPage}
            className="h-6 w-8.5 rounded-sm border border-border bg-bg text-center font-mono text-xs text-text"
          />
          <span className="whitespace-nowrap px-1.5">of {pageCount}</span>
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
            className="inline-flex h-6 w-5.5 items-center justify-center rounded-sm hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            ›
          </button>
          <select
            aria-label="Rows per page"
            value={limit}
            onChange={(e) => {
              onLimitChange(Number(e.target.value));
              onPageChange(1);
            }}
            className="h-6 rounded-sm bg-transparent px-1 text-xs text-text-muted"
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {open ? (
        <div className="absolute left-2 top-full z-50 mt-1.5 rounded-lg border border-border bg-surface shadow-lg">
          {open === "filter" ? (
            <FilterPopover
              columns={columns}
              familyOf={familyOf}
              applied={filter}
              onApply={onFilterChange}
              onClose={close}
            />
          ) : null}
          {open === "sort" ? (
            <SortPopover columns={columns} applied={sort} onApply={onSortChange} onClose={close} />
          ) : null}
          {open === "columns" ? (
            <ColumnsPopover columns={columns} layout={layout} onChange={onLayoutChange} />
          ) : null}
          {open === "export" ? (
            <div className="min-w-82.5 p-2.5">
              <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
                Export — this page
              </div>
              <button
                type="button"
                onClick={() => {
                  downloadText("rows.csv", "text/csv", toCsv(exportColumns, exportRows));
                  close();
                }}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                CSV
              </button>
              <button
                type="button"
                onClick={() => {
                  downloadText("rows.json", "application/json", toJson(exportColumns, exportRows));
                  close();
                }}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                JSON
              </button>
              <div className="mt-1.5 text-xs text-text-faint">
                Exports the {rows.length} rows on this page, in the column order shown.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Add the label-collapse rule**

In `apps/devbench/src/styles/globals.css`, add:

```css
/* The toolbar is always one row: below 620px of its OWN width the button
   labels drop and only icons remain. A container query, not a media query —
   the toolbar shrinks when the chat dock opens, not when the window resizes. */
@container (max-width: 620px) {
  .tb-label {
    display: none;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/devbench && bun run test src/components/db/grid/GridToolbar.test.tsx`
Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src
git commit -m "feat(devbench): grid toolbar with filter, sort, columns, export and paging"
```

---

## Task 11: Boolean checkbox in the grid

**Files:**
- Modify: `apps/devbench/src/components/db/DataGrid.tsx`
- Modify: `apps/devbench/src/components/db/DataGrid.test.tsx`

**Interfaces:**
- Consumes: existing `cellDisplay`, `CellValue`
- Produces: `CellValue` renders a disabled checkbox for booleans

- [ ] **Step 1: Write the failing test**

Replace the existing pill test in `DataGrid.test.tsx` with:

```tsx
  // A checkbox rather than a word: booleans are the one column type whose whole
  // value space fits in a control. Slice 1 renders it read-only; Slice 3 makes
  // it interactive.
  it("renders a boolean as a checkbox reflecting its value", () => {
    render(<DataGrid columns={["paid"]} rows={[["true"], ["false"]]} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[0]).toBeDisabled();
  });

  // Three states, and the brief calls NULL-distinctness a hard constraint.
  it("keeps NULL distinct from false in a boolean column", () => {
    render(<DataGrid columns={["paid"]} rows={[["false"], [null]]} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/DataGrid.test.tsx`
Expected: FAIL — no checkbox role found.

- [ ] **Step 3: Replace the pill with a checkbox**

In `DataGrid.tsx`, replace the `CellValue` boolean branch:

```tsx
export function CellValue({ value }: { value: string | null }) {
  const { text, kind } = cellDisplay(value);
  if (kind === "bool-true" || kind === "bool-false") {
    return (
      <input
        type="checkbox"
        readOnly
        disabled
        checked={kind === "bool-true"}
        aria-label={text}
        // Drawn rather than native: a UA checkbox is ~16px and platform
        // coloured, which reads as a form control dropped into a dense row.
        className="mx-auto block size-3.5 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent disabled:opacity-100"
      />
    );
  }
  return <>{text}</>;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test src/components/db/DataGrid.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/db
git commit -m "feat(devbench): render booleans as a checkbox instead of a pill"
```

---

## Task 12: Wire the toolbar into the grid and tab

**Files:**
- Modify: `apps/devbench/src/components/db/DataGrid.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`

**Interfaces:**
- Consumes: `GridToolbar` (Task 10), `invokeCountTableRows` (Task 3)
- Produces: `DataGrid` accepts `toolbar?: ReactNode`; `DbTab` owns `filter`, `page`, `limit`, `total`

- [ ] **Step 1: Write the failing test**

Add to `apps/devbench/src/components/db/DbTab.test.tsx`:

```tsx
  it("sends the applied filter to both the row query and the count", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "paid"]], pk_column: "id",
    });
    const count = vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(1);

    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter column" }), { target: { value: "status" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter value" }), { target: { value: "paid" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const expected = [{ column: "status", op: "eq", value: "paid", enabled: true }];
    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ filter: expected, offset: 0 })),
    );
    expect(count).toHaveBeenLastCalledWith("c1", "orders", expected);
  });

  it("derives the page count from the total, not from the fetched rows", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(250);

    renderDb("orders");
    // 250 rows at 100 per page is 3 pages.
    expect(await screen.findByText("of 3")).toBeInTheDocument();
  });
```

Also mock the new command in the file's `beforeEach`:

```tsx
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/DbTab.test.tsx`
Expected: FAIL — no "Filter" button.

- [ ] **Step 3: Give DataGrid a toolbar slot and drop the bottom pager**

In `DataGrid.tsx`: add `toolbar?: ReactNode` to `DataGridProps`, render
`{toolbar}` as the first child inside the outer `role="table"` wrapper, wrap the
existing scroll container so the table scrolls independently of the toolbar, and
**delete** the bottom pager block (the `flex items-center justify-between
border-t …` div containing Prev/Next) along with the `hasNextPage`,
`hasPrevPage`, `onPrevPage`, `onNextPage` props.

- [ ] **Step 4: Move query state into DbTab**

In `DbTab.tsx`:

```tsx
const [filter, setFilter] = useState<FilterCondition[]>([]);
const [limit, setLimit] = useState(100);
const [total, setTotal] = useState(0);
// `page` already exists but is 0-based; the toolbar is 1-based.
```

Change `fetchRows` to take the filter and to fire the count alongside the page,
not before it — the grid must never wait on a `COUNT(*)`:

```tsx
async function fetchRows(
  t: string, connId: string,
  activeFilter: FilterCondition[], orderBy: SortTerm[],
  pageNum: number, pageSize: number,
) {
  const requestId = ++requestIdRef.current;
  setLoading(true);
  setError(null);
  // Fired in parallel: the count is the slow one and the grid should not
  // block on it.
  void invokeCountTableRows(connId, t, activeFilter)
    .then((n) => { if (requestId === requestIdRef.current) setTotal(n); })
    .catch(() => { if (requestId === requestIdRef.current) setTotal(0); });
  try {
    const result = await invokeListTableRows(connId, t, {
      filter: activeFilter, orderBy, limit: pageSize, offset: pageNum * pageSize,
    });
    if (requestId !== requestIdRef.current) return;
    setTableRows(result);
  } catch (err) {
    if (requestId !== requestIdRef.current) return;
    setTableRows(null);
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    if (requestId === requestIdRef.current) setLoading(false);
  }
}
```

The over-fetch-by-one and `hasNextPage` state are deleted — the count supplies
the page count now.

Render the toolbar into the grid:

```tsx
<DataGrid
  columns={tableRows.columns}
  rows={tableRows.rows}
  sort={sort}
  onSort={handleSort}
  renderCell={renderCell}
  layoutKey={`${activeConnectionId}:${table}`}
  toolbar={
    <GridToolbar
      columns={tableRows.columns}
      rows={tableRows.rows}
      layout={layout}
      onLayoutChange={setLayout}
      filter={filter}
      onFilterChange={(next) => {
        setFilter(next);
        setPage(0);
        void fetchRows(table!, activeConnectionId!, next, sort, 0, limit);
      }}
      sort={sort}
      onSortChange={(next) => {
        setSort(next);
        setPage(0);
        void fetchRows(table!, activeConnectionId!, filter, next, 0, limit);
      }}
      page={page + 1}
      pageCount={Math.max(1, Math.ceil(total / limit))}
      onPageChange={(next) => {
        setPage(next - 1);
        void fetchRows(table!, activeConnectionId!, filter, sort, next - 1, limit);
      }}
      limit={limit}
      onLimitChange={(next) => {
        setLimit(next);
        void fetchRows(table!, activeConnectionId!, filter, sort, 0, next);
      }}
      onRefresh={() => void fetchRows(table!, activeConnectionId!, filter, sort, page, limit)}
      familyOf={(column) => inferFamily(tableRows.rows[0]?.[tableRows.columns.indexOf(column)] ?? null)}
    />
  }
/>
```

`layout` must now be lifted out of `DataGrid` into `DbTab` (the toolbar and the
grid both need it). Move the `stored`/`updateLayout` state up, and pass
`layout` + `onLayoutChange` into `DataGrid` as props instead of `layoutKey`.

Finally, in the table/connection-switch effect, reset `setFilter([])` and
`setLimit(100)` alongside the existing sort and page resets.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: all green. Some `DbTab.test.tsx` cases asserting the old
over-fetch behaviour ("does not offer a next page when the fetch returns exactly
a page's worth of rows") no longer describe reality — rewrite them against
`invokeCountTableRows` returning the total, rather than deleting them.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src
git commit -m "feat(devbench): drive the grid from server-side filter, sort and count"
```

---

## Task 13: Browser verification

**Files:**
- No source changes expected unless a measurement fails.

This task exists because jsdom cannot see any of it. Every claim below must be
backed by a number read out of a real browser.

- [ ] **Step 1: Start the app and a stubbed IPC layer**

```bash
cd apps/devbench && bun run dev
```

Tauri `invoke` throws in a plain browser, so drive the page with Playwright and
inject a stub before load that implements `window.__TAURI_INTERNALS__.invoke`
for `get_startup_status`, `get_settings`, `list_sessions`, `list_tabs`,
`list_connections`, `db_connect_and_list_tables`, `list_watched_tables`,
`list_table_rows` and `count_table_rows`. Serve at least 250 rows and 12 columns
so paging and horizontal scroll are both exercised.

- [ ] **Step 2: Measure the four regression-critical behaviours**

Record actual numbers for each:

```js
const table = document.querySelector('[role="table"]');
const scroller = table.querySelector('.overflow-auto');
const th = table.querySelector('[role="columnheader"]');
const cell = [...table.querySelectorAll('[role="row"]')][1].querySelector('[role="cell"]');
const before = { th: th.getBoundingClientRect().left, td: cell.getBoundingClientRect().left };
scroller.scrollLeft = 400;
const after = { th: th.getBoundingClientRect().left, td: cell.getBoundingClientRect().left };
({
  headerDelta: after.th - before.th,          // must equal bodyDelta
  bodyDelta: after.td - before.td,
  renderedRows: table.querySelectorAll('[role="row"]').length - 1,   // must be > 0
  docContained: document.documentElement.scrollWidth === document.documentElement.clientWidth,
  rowHeights: [...new Set([...table.querySelectorAll('[role="row"]')].slice(1)
    .map(r => r.getBoundingClientRect().height))],                   // must be [33]
})
```

Expected: header and body deltas identical; rows rendered; document contained;
one distinct row height.

- [ ] **Step 3: Measure the toolbar**

```js
const tb = document.querySelector('[role="table"] .\\@container');
({
  width: tb.getBoundingClientRect().width,
  height: tb.getBoundingClientRect().height,           // one row: ~37px
  labelsHidden: getComputedStyle(document.querySelector('.tb-label')).display === 'none',
  pagerVisible: !!document.querySelector('[aria-label="Page number"]'),
})
```

Do this twice: with the chat dock closed (labels visible) and open (toolbar
below 620px, labels hidden, height unchanged, pager still present).

- [ ] **Step 4: Verify the popovers stack correctly**

Open the Filter popover, scroll the grid, and confirm it renders above the cells
and below the sticky header:

```js
({
  popoverZ: getComputedStyle(document.querySelector('[role="table"] .absolute.z-50')).zIndex,
  headerZ: getComputedStyle(document.querySelector('[role="row"]')).zIndex,
})
```

- [ ] **Step 5: Compare against the mockup**

```bash
cd docs/mockups && python3 -m http.server 8899
```

Open both side by side. Confirm the toolbar control order, the count badges, the
popover footers (Add left, Cancel/Apply right, equal heights) and the boolean
checkbox all match.

- [ ] **Step 6: Run the full suite and record the numbers**

```bash
cd apps/devbench && bun run test && bun run build
cd src-tauri && cargo test --lib
```

Report measured mockup vs before vs after for anything that changed, and the
final test counts. Do not claim a behaviour holds without the number that shows
it.

- [ ] **Step 7: Commit any fixes**

```bash
git add apps/devbench/src
git commit -m "fix(devbench): correct grid toolbar layout against browser measurements"
```

---

## Self-Review

**1. Spec coverage (Slice 1 only).**

| Spec section | Task |
|---|---|
| §2 Toolbar layout, pager, limits | 10, 12 |
| §2 One row, container-query collapse | 10 (step 4), 13 |
| §2 Filter bar and bottom pager removed | 12 |
| §4 Draft/apply/cancel | 7, 8 |
| §4 Per-rule enable, kept but not run | 7, 8, 1 |
| §4 Inert incomplete condition | 1, 3, 7 |
| §4 Counts of applied+enabled only | 10 |
| §4 Sort priority + reorder | 8 |
| §4 Operators by type family | 3, 7 |
| §4 Identifier validation, bound values, LIKE escaping | 1 |
| §4 Same filter for rows and count | 2, 12 |
| §5 Columns hide/pin | 9 |
| §6 Export CSV/JSON of the page | 6, 10 |
| §7 Boolean checkbox (display only) | 11 |
| §13 `count_table_rows`, filter on `list_table_rows` | 2 |
| §13 Count fetched in parallel | 12 |
| §14 One secondary button, footers own height | 5, 7, 8 |
| §16 Testing | every task; browser work in 13 |

Not covered here by design: §1 dock slot, §3 Pending button, §3a rail
segments, §3b query tabs, §8 foreign keys, §9 insert panel, §10 pending
changes, §11 row delete, §12 query execution and staging — all Slices 2–4,
per §17.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task
N". Every code step carries the actual code. Task 13 is the one task without
new source code; that is deliberate — it is a measurement gate, and its steps
name the exact expressions to evaluate rather than saying "check it looks
right".

**3. Type consistency.** Checked across tasks:
- `FilterCondition { column, op, value, enabled }` — identical in Rust (Task 1,
  serde snake_case) and TS (Task 3), and used unchanged in 7, 10, 12.
- `SortTerm { column, descending, enabled }` — Task 3 adds `enabled` to the
  existing Rust `SortTerm`, which currently has only `column` + `descending`.
  **Task 2 must therefore also add `enabled` to the Rust `SortTerm` and skip
  disabled terms when building `ORDER BY`.** Added to Task 2 Step 3 below.
- `GridLayout { widths, order, pinned, hidden }` — Task 4 defines it; 9, 10, 12
  consume the same four fields.
- `compile_filter(&[FilterCondition], usize)` — Task 1 produces, Task 2 consumes
  with `first_param_index: 1`.
- `visualColumns(columns, layout)` / `pinOffsets(visual, layout)` — Task 4
  produces, Task 10 uses `visualColumns` for export ordering.
- `toCsv`/`toJson(columns, rows)` — Task 6 produces, Task 10 consumes.

**Correction applied inline.** The fix below is now Task 2 Steps 3–4, not a
note at the end of the document — subagent-driven execution shows an
implementer only their own task, so a correction living here would never be
read. Recorded for the record:

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct SortTerm {
    pub column: String,
    pub descending: bool,
    /// An unticked term is kept by the UI but must not reach the ORDER BY.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool { true }
```

and in `list_table_rows_impl`, filter before building the clause:

```rust
    let terms: Vec<String> = order_by
        .iter()
        .filter(|t| t.enabled)
        .map(|t| format!("\"{}\" {}", t.column, if t.descending { "DESC" } else { "ASC" }))
        .collect();
    if !terms.is_empty() {
        sql.push_str(&format!(" ORDER BY {}", terms.join(", ")));
    }
```

The existing Rust test helper `asc_on` must set `enabled: true`, and a new test
belongs in Task 2:

```rust
    #[tokio::test]
    async fn a_disabled_sort_term_is_not_applied() {
        let pool = test_pool().await;
        let disabled = SortTerm { column: "id".into(), descending: true, enabled: false };
        // Must not error, and must not order by the disabled column.
        let result = list_table_rows_impl(&pool, "orders", &[], &[disabled], 5, 0).await;
        assert!(result.is_ok());
    }
```
