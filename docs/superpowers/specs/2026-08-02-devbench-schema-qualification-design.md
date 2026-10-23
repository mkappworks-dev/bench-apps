# Schema Qualification — Design

**Status:** approved, ready for an implementation plan.

**Goal:** Every table reference in the DevBench data path carries its schema, so
a table is identified by `(schema, name)` rather than by name alone.

**Why now:** Slice 2's foreign keys are schema-qualified (`public.users.id`), and
the jump-to-referenced-row action cannot be correct while the query path
discards the schema. Qualifying first, on its own, keeps that refactor out of
the foreign-key plan.

This is plan **2a**. Foreign keys are **2b** and depend on it.

---

## 1. The defect this fixes

`list_tables_impl` already returns `TableInfo { schema, name }`, but every
consumer below it matches on the bare name:

| Site | Today |
|---|---|
| `commands/db.rs` `get_primary_key_column` | `WHERE tc.table_name = $1` — no schema predicate |
| `commands/db.rs` `get_column_type` | `WHERE table_name = $1` — no schema predicate |
| `commands/db.rs` `list_table_rows_impl` | `FROM "{table}"` |
| `commands/db.rs` `count_table_rows_impl` | `FROM "{table}"` |
| `commands/query.rs` cell edit | `UPDATE "{table}"` |
| `commands/correlation.rs` snapshot | `FROM "{table}"` |
| `watched_tables` (SQLite) | stores a bare `table_name` |

Two consequences, both live today:

1. **Catalog lookups can resolve the wrong table.** With `users` in both
   `public` and `alt`, `get_primary_key_column("users")` matches two rows and
   fails as "composite primary key", or returns the wrong column.
2. **Unqualified DML resolves through `search_path`,** so which physical table a
   read or an edit hits depends on connection state rather than on what the user
   selected.

## 2. Scope

**In scope.** Threading `(schema, name)` through the Rust command layer, the IPC
boundary, the SQLite `watched_tables` store, and the frontend's table identity
(tab state and grid-layout keys).

**Out of scope — belongs to 2b.** Foreign keys, `describe_columns`,
`get_referenced_row`, retiring `inferFamily`, and replacing `db_filter`'s
`::text`/`::numeric` casts with real column types.

**No user-visible change.** 2a ships correct behavior for non-public schemas and
nothing else. Anyone working solely in `public` should see no difference.

## 3. `QualifiedTable`

New module `src-tauri/src/commands/qualified_table.rs`.

```rust
pub struct QualifiedTable { schema: String, name: String }

impl QualifiedTable {
    pub fn new(schema: &str, name: &str) -> Result<Self, String> {
        validate_identifier(schema)?;
        validate_identifier(name)?;
        Ok(Self { schema: schema.to_string(), name: name.to_string() })
    }

    /// `"public"."orders"` — the only path by which a table name reaches SQL.
    pub fn quoted(&self) -> String {
        format!("\"{}\".\"{}\"", self.schema, self.name)
    }

    pub fn schema(&self) -> &str { &self.schema }
    pub fn name(&self) -> &str { &self.name }
}
```

Fields stay private. The only constructor validates both identifiers, so an
unvalidated `QualifiedTable` cannot exist anywhere in the process.

### 3.1 Deserialization must run the constructor

A plain `#[derive(Deserialize)]` would let the frontend populate the fields
directly and bypass validation entirely, making the type's guarantee fiction.
Deserialization therefore routes through the constructor:

```rust
#[derive(Deserialize)]
struct QualifiedTableWire { schema: String, name: String }

impl TryFrom<QualifiedTableWire> for QualifiedTable {
    type Error = String;
    fn try_from(w: QualifiedTableWire) -> Result<Self, Self::Error> {
        QualifiedTable::new(&w.schema, &w.name)
    }
}

#[derive(Deserialize)]
#[serde(try_from = "QualifiedTableWire")]
pub struct QualifiedTable { /* as above */ }
```

An invalid identifier now fails deserialization before any command body runs.

This is strictly stronger than today's arrangement, where `validate_identifier`
is a separate call each site must remember — and `correlation.rs` interpolates
`FROM "{table}"` with no such call nearby.

## 4. Backend changes

Every function above takes `&QualifiedTable` in place of `&str`, interpolates
via `.quoted()`, and drops its own `validate_identifier` call for the table
(calls covering *column* identifiers stay).

Catalog queries gain the missing predicate:

```sql
-- get_primary_key_column
WHERE tc.constraint_type = 'PRIMARY KEY'
  AND tc.table_name = $1 AND tc.table_schema = $2

-- get_column_type
WHERE table_name = $1 AND column_name = $2 AND table_schema = $3
```

Tauri commands accept `table: QualifiedTable` instead of `table: String`.

`list_tables_impl` and `db_connect_and_list_tables` are unchanged: they already
select `table_schema` and return `TableInfo { schema, name }`. They are the
source of the schema everything else now carries.

## 5. Migration `0007_watched_tables_schema.sql`

The primary key is `(connection_id, table_name)` and SQLite cannot alter a
primary key in place, so this rebuilds the table exactly as `0006` did:

```sql
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

**On the `'public'` backfill.** A table can only have been watched by bare name,
resolved against the connection's default `search_path` — `"$user", public` on a
stock Postgres — so in practice every existing row is `public`. It is not
provable: a user whose role name matches an existing schema could have watched a
non-public table. The failure mode is benign (that watch stops matching and the
user re-watches), and the migration comment states this rather than claiming
certainty.

## 6. Frontend changes

**Wrappers** in `src/lib/tauri.ts` take the qualified table as one argument,
mirroring the Rust type:

```ts
export interface QualifiedTable { schema: string; name: string }

invokeListTableRows(connectionId, table: QualifiedTable, options?)
invokeCountTableRows(connectionId, table: QualifiedTable, filter?)
invokeSetWatchedTable(connectionId, table: QualifiedTable, watched)
```

**`SchemaTree`** already holds `TableInfo { schema, name }` and uses
`${t.schema}.${t.name}` as its React key; it passes the whole object up on
select instead of narrowing to the name.

**`DbTab`** holds `{ schema, name }` in place of `table: string`.

**Tab state** (`{ table: string }`, persisted through `set_tab_state`) becomes
`{ table: { schema, name } }`. The read path treats a legacy bare string as
`public`, so an open tab survives the upgrade instead of resetting to empty.

**Grid layout keys** become `devbench.grid-layout.{connId}:{schema}.{name}`.
Legacy keys are left to orphan: the cost is a one-time reset of saved column
widths, pins and hidden columns; `readLayout` already falls back to
`EMPTY_LAYOUT` on a miss; and it avoids a compatibility branch that would live
forever. This is a deliberate trade, recorded here so it is not mistaken for an
oversight.

## 7. Testing

The test that proves the refactor earned its keep:

> **Two same-named tables in different schemas resolve independently.** Create
> `public.dup` and `alt.dup` with different rows. Assert `list_table_rows_impl`,
> `count_table_rows_impl` and `get_primary_key_column` each return the right
> one for each schema.

It fails today — the catalog lookups match on `table_name` alone — so it is a
genuine regression test, not a restatement of the implementation.

Alongside it:

- `QualifiedTable::new` rejects an injection payload in the **schema** position,
  not only the table position. The schema is new attack surface.
- Deserializing a `QualifiedTable` with an invalid identifier fails, proving the
  `try_from` route rather than the constructor in isolation.
- Existing `watched_tables` rows land on `public` after `0007`.

Existing Rust tests all build tables in `public` and change mechanically —
`"orders"` becomes `QualifiedTable::new("public", "orders")?`. This is a wide but
shallow diff and accounts for most of the task count.

**Baselines to keep green:** `cd apps/devbench && bun run test` (388 passing / 43
files) and `bun run build`; `cd apps/devbench/src-tauri && cargo test --lib` (213
passing, 1 ignored). Both grow as tasks add tests.

Postgres for the Rust tests: container `devbench-test-pg`, `localhost:5432`,
`postgres`/`postgres`, database `devbench_test`. The collision test needs a
non-public schema, so it creates and drops `alt` itself rather than assuming one
exists.

## 8. Sequencing

Compiler-driven, in one pass per layer: change the signature and let `cargo` and
`tsc` enumerate the call sites, fixing them in the same task. A
parallel-old-and-new API would carry two code paths through exactly what Slice 1
just stabilized, for no safety gain — the compilers already give total call-site
coverage, which is the case where a strangler buys nothing.

1. `QualifiedTable` + its own tests (construction, quoting, both rejection paths)
2. Catalog lookups — `get_primary_key_column`, `get_column_type`
3. `db.rs` query paths — `list_table_rows_impl`, `count_table_rows_impl`
4. `query.rs` cell edit, `correlation.rs` snapshot
5. Migration `0007` + `watched.rs`
6. Tauri command signatures + `lib/tauri.ts`
7. `SchemaTree` → `DbTab` identity, tab state, layout keys
8. The cross-schema collision test as the capstone

## 9. Decisions recorded

| Decision | Rationale |
|---|---|
| Validated newtype over two params or a dotted string | Centralizes validation so it cannot be forgotten. A dotted string breaks on a legal Postgres table named `my.table`, silently querying the wrong schema. |
| Full qualification, not new paths only | Removes the same-name collision outright rather than leaving it latent behind a partially-correct API. |
| Split from foreign keys | Combined, Slice 2 ran past 20 tasks with a broad refactor mid-plan; splitting lets the refactor's regressions surface before FK work builds on it. |
| Orphan legacy layout keys | One-time loss of column widths, against a permanent compatibility branch. |
| Backfill `'public'` | Correct for effectively every install; benign failure mode; documented rather than asserted. |
