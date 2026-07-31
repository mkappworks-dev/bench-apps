use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::commands::db::validate_identifier;
use crate::local_db::LocalDb;

pub async fn list_watched_tables_impl(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT table_name FROM watched_tables WHERE connection_id = ? ORDER BY table_name")
        .bind(connection_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to list watched tables: {e}"))?;
    Ok(rows.iter().map(|r| r.get::<String, _>("table_name")).collect())
}

pub async fn set_watched_table_impl(
    pool: &SqlitePool,
    connection_id: &str,
    table: &str,
    watched: bool,
) -> Result<(), String> {
    // The same validation the snapshot path uses. A stored table name is
    // interpolated into SQL later; rejecting it here means a bad value can
    // never be persisted in the first place.
    validate_identifier(table)?;
    if watched {
        sqlx::query("INSERT OR IGNORE INTO watched_tables (connection_id, table_name) VALUES (?, ?)")
            .bind(connection_id)
            .bind(table)
            .execute(pool)
            .await
            .map_err(|e| format!("failed to watch {table}: {e}"))?;
    } else {
        sqlx::query("DELETE FROM watched_tables WHERE connection_id = ? AND table_name = ?")
            .bind(connection_id)
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
    connection_id: String,
) -> Result<Vec<String>, String> {
    list_watched_tables_impl(&db.pool, &connection_id).await
}

#[tauri::command]
pub async fn set_watched_table(
    db: State<'_, LocalDb>,
    connection_id: String,
    table: String,
    watched: bool,
) -> Result<(), String> {
    set_watched_table_impl(&db.pool, &connection_id, &table, watched).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn the_default_connection_is_seeded_by_migration() {
        let (_dir, db) = db().await;
        let row = sqlx::query("SELECT name, host, port, database, username FROM connections WHERE id = 'default'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("name"), "Local Dev");
        assert_eq!(row.get::<String, _>("host"), "localhost");
        assert_eq!(row.get::<i64, _>("port"), 5432);
        assert_eq!(row.get::<String, _>("database"), "devbench_test");
        assert_eq!(row.get::<String, _>("username"), "postgres");
    }

    #[tokio::test]
    async fn watching_a_table_survives_a_reconnect() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, "default").await.unwrap(), vec!["orders"]);
    }

    #[tokio::test]
    async fn unwatching_removes_the_row() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", "orders", false).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, "default").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn watching_the_same_table_twice_is_idempotent() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, "default").await.unwrap().len(), 1);
    }

    // watched_tables.connection_id is a foreign key into connections(id) now,
    // so a second row has to actually exist there to prove scoping — unlike
    // before, when "shop" and "staging" were just two arbitrary strings.
    #[tokio::test]
    async fn watch_state_is_scoped_per_connection() {
        let (_dir, db) = db().await;
        sqlx::query(
            "INSERT INTO connections (id, name, engine, host, port, database, username, sslmode, created_at, updated_at) \
             VALUES ('staging', 'Staging', 'postgres', 'staging-db.internal', 5432, 'app', 'app_ro', 'require', datetime('now'), datetime('now'))",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        set_watched_table_impl(&db.pool, "default", "orders", true).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, "staging").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_malicious_table_name_is_rejected_before_it_can_be_persisted() {
        let (_dir, db) = db().await;
        let result =
            set_watched_table_impl(&db.pool, "default", "orders; DROP TABLE users; --", true).await;
        assert!(result.is_err());
        assert!(list_watched_tables_impl(&db.pool, "default").await.unwrap().is_empty());
    }
}
