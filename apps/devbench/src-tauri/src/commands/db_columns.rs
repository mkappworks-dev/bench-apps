use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use tauri::State;

use crate::commands::db::{
    cell_to_string, get_column_type, get_primary_key_column, validate_identifier_labeled, TableRows,
};
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
}
