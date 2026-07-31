use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::commands::db::{validate_identifier, DbConnectInput};
use crate::local_db::LocalDb;

/// Stable handle for a connection. Deliberately excludes the password: this
/// value lands in a WHERE clause and in error messages, and a credential has
/// no business in either.
pub fn connection_key(input: &DbConnectInput) -> String {
    format!("{}@{}:{}/{}", input.username, input.host, input.port, input.database)
}

pub async fn list_watched_tables_impl(
    pool: &SqlitePool,
    connection: &DbConnectInput,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT table_name FROM watched_tables WHERE connection_key = ? ORDER BY table_name")
        .bind(connection_key(connection))
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to list watched tables: {e}"))?;
    Ok(rows.iter().map(|r| r.get::<String, _>("table_name")).collect())
}

pub async fn set_watched_table_impl(
    pool: &SqlitePool,
    connection: &DbConnectInput,
    table: &str,
    watched: bool,
) -> Result<(), String> {
    // The same validation the snapshot path uses. A stored table name is
    // interpolated into SQL later; rejecting it here means a bad value can
    // never be persisted in the first place.
    validate_identifier(table)?;
    let key = connection_key(connection);
    if watched {
        sqlx::query("INSERT OR IGNORE INTO watched_tables (connection_key, table_name) VALUES (?, ?)")
            .bind(&key)
            .bind(table)
            .execute(pool)
            .await
            .map_err(|e| format!("failed to watch {table}: {e}"))?;
    } else {
        sqlx::query("DELETE FROM watched_tables WHERE connection_key = ? AND table_name = ?")
            .bind(&key)
            .bind(table)
            .execute(pool)
            .await
            .map_err(|e| format!("failed to unwatch {table}: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_watched_tables(
    db: State<'_, LocalDb>,
    connection: DbConnectInput,
) -> Result<Vec<String>, String> {
    list_watched_tables_impl(&db.pool, &connection).await
}

#[tauri::command]
pub async fn set_watched_table(
    db: State<'_, LocalDb>,
    connection: DbConnectInput,
    table: String,
    watched: bool,
) -> Result<(), String> {
    set_watched_table_impl(&db.pool, &connection, &table, watched).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(database: &str) -> DbConnectInput {
        DbConnectInput {
            host: "localhost".into(),
            port: 5432,
            database: database.into(),
            username: "postgres".into(),
            password: "secret".into(),
        }
    }

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[test]
    fn the_connection_key_never_contains_the_password() {
        let key = connection_key(&conn("devbench_test"));
        assert!(!key.contains("secret"));
        assert!(key.contains("devbench_test"));
    }

    #[tokio::test]
    async fn watching_a_table_survives_a_reconnect() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, &conn("shop")).await.unwrap(), vec!["orders"]);
    }

    #[tokio::test]
    async fn unwatching_removes_the_row() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", false).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, &conn("shop")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn watching_the_same_table_twice_is_idempotent() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, &conn("shop")).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn watch_state_is_scoped_per_connection() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, &conn("staging")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_malicious_table_name_is_rejected_before_it_can_be_persisted() {
        let (_dir, db) = db().await;
        let result =
            set_watched_table_impl(&db.pool, &conn("shop"), "orders; DROP TABLE users; --", true).await;
        assert!(result.is_err());
        assert!(list_watched_tables_impl(&db.pool, &conn("shop")).await.unwrap().is_empty());
    }
}
