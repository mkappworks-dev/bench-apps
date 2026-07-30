use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::Column;
use sqlx::Row;

#[derive(Debug, Deserialize, Clone)]
pub struct DbConnectInput {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}

pub fn connection_string(input: &DbConnectInput) -> String {
    format!(
        "postgres://{}:{}@{}:{}/{}",
        input.username, input.password, input.host, input.port, input.database
    )
}

#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
}

pub async fn list_tables_impl(input: &DbConnectInput) -> Result<Vec<TableInfo>, String> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(input))
        .await
        .map_err(|e| format!("connection failed: {e}"))?;

    let rows = sqlx::query(
        "SELECT table_schema, table_name FROM information_schema.tables \
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
         ORDER BY table_schema, table_name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("query failed: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| TableInfo {
            schema: r.get("table_schema"),
            name: r.get("table_name"),
        })
        .collect())
}

#[tauri::command]
pub async fn db_connect_and_list_tables(input: DbConnectInput) -> Result<Vec<TableInfo>, String> {
    list_tables_impl(&input).await
}

#[derive(Debug, Serialize)]
pub struct TableRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

fn cell_to_string(row: &sqlx::postgres::PgRow, index: usize) -> Option<String> {
    use sqlx::Row as _;
    if let Ok(v) = row.try_get::<Option<String>, _>(index) { return v; }
    if let Ok(v) = row.try_get::<Option<i64>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<i32>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<f64>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<bool>, _>(index) { return v.map(|b| b.to_string()); }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(index) { return v.map(|d| d.to_string()); }
    if let Ok(v) = row.try_get::<Option<uuid::Uuid>, _>(index) { return v.map(|u| u.to_string()); }
    None
}

/// Validates that a table name is a legitimate Postgres identifier.
/// Allows only ASCII alphanumeric characters and underscores.
/// Returns an error if the identifier contains any other characters.
fn validate_identifier(identifier: &str) -> Result<(), String> {
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

pub async fn list_table_rows_impl(input: &DbConnectInput, table: &str) -> Result<TableRows, String> {
    // Validate the table identifier before using it in SQL.
    validate_identifier(table)?;

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(input))
        .await
        .map_err(|e| format!("connection failed: {e}"))?;

    // Double-quote the identifier as defense-in-depth after validation.
    let sql = format!("SELECT * FROM \"{}\" LIMIT 200", table);
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
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

    Ok(TableRows { columns, rows: out_rows })
}

#[tauri::command]
pub async fn list_table_rows(input: DbConnectInput, table: String) -> Result<TableRows, String> {
    list_table_rows_impl(&input, &table).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> DbConnectInput {
        DbConnectInput {
            host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
            port: 5432,
            database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            password: std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into()),
        }
    }

    #[tokio::test]
    async fn lists_the_public_orders_table() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup");

        sqlx::query("DROP TABLE IF EXISTS orders_for_test")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE orders_for_test (id serial PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();

        let tables = list_tables_impl(&conn).await.unwrap();
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
        let result = validate_identifier("orders");
        assert!(result.is_ok(), "should accept simple lowercase table name");
    }

    #[test]
    fn accepts_valid_table_name_with_underscore() {
        let result = validate_identifier("orders_for_test");
        assert!(result.is_ok(), "should accept table name with underscores");
    }

    #[test]
    fn accepts_valid_table_name_with_numbers() {
        let result = validate_identifier("table123");
        assert!(result.is_ok(), "should accept table name with numbers");
    }

    #[test]
    fn accepts_valid_mixed_case_table_name() {
        let result = validate_identifier("OrdersTable");
        assert!(result.is_ok(), "should accept mixed-case table name");
    }

    #[test]
    fn rejects_special_characters() {
        let test_cases = vec![
            ("users;", "semicolon"),
            ("users--", "dash"),
            ("users/**/", "comment"),
            ("users OR 1=1", "space and keyword"),
            ("users'test", "single quote"),
            ("users\"test", "double quote"),
            ("users,test", "comma"),
            ("users.test", "dot"),
            ("users(test)", "parentheses"),
        ];
        for (input, desc) in test_cases {
            let result = validate_identifier(input);
            assert!(result.is_err(), "should reject {} in table name", desc);
        }
    }

    #[tokio::test]
    async fn list_table_rows_rejects_malicious_table_name() {
        let conn = test_connection();
        let malicious_table = "orders; DROP TABLE users; --";
        let result = list_table_rows_impl(&conn, malicious_table).await;
        assert!(result.is_err(), "should reject malicious table name before executing query");
    }

    #[tokio::test]
    async fn list_table_rows_works_with_valid_table_name() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup");

        // Create a test table
        sqlx::query("DROP TABLE IF EXISTS test_rows_table")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE test_rows_table (id serial PRIMARY KEY, name text)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO test_rows_table (name) VALUES ('test_row_1')")
            .execute(&pool)
            .await
            .unwrap();

        // Call list_table_rows_impl with valid table name
        let result = list_table_rows_impl(&conn, "test_rows_table").await;
        assert!(result.is_ok(), "should successfully list rows from valid table");

        let table_rows = result.unwrap();
        assert!(!table_rows.columns.is_empty(), "should have columns");
        assert_eq!(table_rows.columns[0], "id", "first column should be id");

        // Clean up
        sqlx::query("DROP TABLE test_rows_table")
            .execute(&pool)
            .await
            .unwrap();
    }
}
