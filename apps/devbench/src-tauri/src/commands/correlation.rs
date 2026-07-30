use serde::Serialize;
use sqlx::{Pool, Postgres, Row};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct RowSnapshot {
    pub pk: String,
    pub hash: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TableDiff {
    pub table: String,
    pub inserted: i64,
    pub updated: i64,
    pub deleted: i64,
}

pub fn diff_table_snapshots(table: &str, before: &[RowSnapshot], after: &[RowSnapshot]) -> TableDiff {
    let before_map: HashMap<&str, &str> =
        before.iter().map(|r| (r.pk.as_str(), r.hash.as_str())).collect();
    let after_map: HashMap<&str, &str> =
        after.iter().map(|r| (r.pk.as_str(), r.hash.as_str())).collect();

    let mut inserted = 0i64;
    let mut updated = 0i64;
    for (pk, after_hash) in &after_map {
        match before_map.get(pk) {
            None => inserted += 1,
            Some(before_hash) if before_hash != after_hash => updated += 1,
            _ => {}
        }
    }

    let deleted = before_map.keys().filter(|pk| !after_map.contains_key(*pk)).count() as i64;

    TableDiff {
        table: table.to_string(),
        inserted,
        updated,
        deleted,
    }
}

pub async fn get_primary_key_column(pool: &Pool<Postgres>, table: &str) -> Result<String, String> {
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

pub async fn snapshot_table(
    pool: &Pool<Postgres>,
    table: &str,
    pk_col: &str,
) -> Result<Vec<RowSnapshot>, String> {
    let sql = format!("SELECT {pk_col}::text as pk, md5(t::text) as hash FROM {table} t");
    let rows = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("snapshot failed for {table}: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|r| RowSnapshot { pk: r.get("pk"), hash: r.get("hash") })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::db::{connection_string, DbConnectInput};
    use sqlx::postgres::PgPoolOptions;

    fn snap(pk: &str, hash: &str) -> RowSnapshot {
        RowSnapshot { pk: pk.to_string(), hash: hash.to_string() }
    }

    #[test]
    fn detects_an_insert() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a"), snap("2", "b")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 1, updated: 0, deleted: 0 });
    }

    #[test]
    fn detects_an_update_even_though_row_count_is_unchanged() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a-changed")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 1, deleted: 0 });
    }

    #[test]
    fn detects_a_delete() {
        let before = vec![snap("1", "a"), snap("2", "b")];
        let after = vec![snap("1", "a")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 0, deleted: 1 });
    }

    #[test]
    fn reports_nothing_when_unchanged() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 0, deleted: 0 });
    }

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
    async fn snapshot_and_diff_detects_a_real_update() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        sqlx::query("DROP TABLE IF EXISTS correlation_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE correlation_test (id serial PRIMARY KEY, status text)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO correlation_test (status) VALUES ('pending')")
            .execute(&pool).await.unwrap();

        let pk_col = get_primary_key_column(&pool, "correlation_test").await.unwrap();
        assert_eq!(pk_col, "id");

        let before = snapshot_table(&pool, "correlation_test", &pk_col).await.unwrap();
        sqlx::query("UPDATE correlation_test SET status = 'shipped' WHERE id = 1")
            .execute(&pool).await.unwrap();
        let after = snapshot_table(&pool, "correlation_test", &pk_col).await.unwrap();

        let diff = diff_table_snapshots("correlation_test", &before, &after);
        assert_eq!(diff, TableDiff { table: "correlation_test".into(), inserted: 0, updated: 1, deleted: 0 });

        sqlx::query("DROP TABLE correlation_test").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_composite_primary_keys() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        sqlx::query("DROP TABLE IF EXISTS composite_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE composite_test (tenant_id int, item_id int, val text, PRIMARY KEY (tenant_id, item_id))")
            .execute(&pool).await.unwrap();

        let result = get_primary_key_column(&pool, "composite_test").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("composite primary key"));

        sqlx::query("DROP TABLE composite_test").execute(&pool).await.unwrap();
    }
}
