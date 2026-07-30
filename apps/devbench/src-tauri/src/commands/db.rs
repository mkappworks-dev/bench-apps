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

#[tauri::command]
pub async fn list_table_rows(input: DbConnectInput, table: String) -> Result<TableRows, String> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(&input))
        .await
        .map_err(|e| format!("connection failed: {e}"))?;

    let sql = format!("SELECT * FROM {table} LIMIT 200");
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
}
