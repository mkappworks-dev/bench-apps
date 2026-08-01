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
    // None of the supported decode paths matched. This is NOT the same thing as a
    // genuine SQL NULL (which returns early above via `v.map(...)` on `None`) — it
    // means the column holds a real, non-null value of a type we don't know how to
    // decode (NUMERIC/DECIMAL, JSONB, arrays, enums, ...).
    // Rendering that the same as NULL would silently misrepresent real row data, so
    // it gets a visible marker instead. Full decode support for every Postgres type
    // is out of scope here — this only makes the failure mode honest.
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
    // No other value in this query is bound (table/column are identifiers,
    // which Postgres can't bind — they're interpolated after validation
    // instead), so limit/offset are $1/$2.
    sql.push_str(" LIMIT $1 OFFSET $2");

    let rows = sqlx::query(&sql)
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
