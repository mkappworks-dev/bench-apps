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
