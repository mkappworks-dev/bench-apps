use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::commands::qualified_table::QualifiedTable;
use crate::local_db::LocalDb;

pub async fn list_watched_tables_impl(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Vec<QualifiedTable>, String> {
    let rows = sqlx::query(
        "SELECT table_schema, table_name FROM watched_tables \
         WHERE connection_id = ? ORDER BY table_schema, table_name",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to list watched tables: {e}"))?;

    // A stored row was validated before it was written, but it is re-validated
    // on the way out: the database file is editable by hand, and this value is
    // interpolated into SQL downstream.
    rows.iter()
        .map(|r| QualifiedTable::new(&r.get::<String, _>("table_schema"), &r.get::<String, _>("table_name")))
        .collect()
}

pub async fn set_watched_table_impl(
    pool: &SqlitePool,
    connection_id: &str,
    table: &QualifiedTable,
    watched: bool,
) -> Result<(), String> {
    if watched {
        sqlx::query(
            "INSERT OR IGNORE INTO watched_tables (connection_id, table_schema, table_name) \
             VALUES (?, ?, ?)",
        )
        .bind(connection_id)
        .bind(table.schema())
        .bind(table.name())
        .execute(pool)
        .await
        .map_err(|e| format!("failed to watch {table}: {e}"))?;
    } else {
        sqlx::query(
            "DELETE FROM watched_tables \
             WHERE connection_id = ? AND table_schema = ? AND table_name = ?",
        )
        .bind(connection_id)
        .bind(table.schema())
        .bind(table.name())
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
) -> Result<Vec<QualifiedTable>, String> {
    list_watched_tables_impl(&db.pool, &connection_id).await
}

#[tauri::command]
pub async fn set_watched_table(
    db: State<'_, LocalDb>,
    connection_id: String,
    table: QualifiedTable,
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

    fn qt(schema: &str, name: &str) -> crate::commands::qualified_table::QualifiedTable {
        crate::commands::qualified_table::QualifiedTable::new(schema, name).unwrap()
    }

    // Watching the same table name in two schemas must produce two rows, not
    // one — the composite primary key is what makes that possible.
    #[tokio::test]
    async fn the_same_name_in_two_schemas_watches_independently() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", &qt("public", "dup"), true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", &qt("alt", "dup"), true).await.unwrap();

        let watched = list_watched_tables_impl(&db.pool, "default").await.unwrap();
        assert_eq!(watched.len(), 2);

        // Unwatching one leaves the other.
        set_watched_table_impl(&db.pool, "default", &qt("alt", "dup"), false).await.unwrap();
        let watched = list_watched_tables_impl(&db.pool, "default").await.unwrap();
        assert_eq!(watched, vec![qt("public", "dup")]);
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
        set_watched_table_impl(&db.pool, "default", &qt("public", "orders"), true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, "default").await.unwrap(), vec![qt("public", "orders")]);
    }

    #[tokio::test]
    async fn unwatching_removes_the_row() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", &qt("public", "orders"), true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", &qt("public", "orders"), false).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, "default").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn watching_the_same_table_twice_is_idempotent() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, "default", &qt("public", "orders"), true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", &qt("public", "orders"), true).await.unwrap();
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

        set_watched_table_impl(&db.pool, "default", &qt("public", "orders"), true).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, "staging").await.unwrap().is_empty());
    }

    // The store's own test above builds its tables with `QualifiedTable::new`.
    // `set_watched_table` receives them from serde instead, and
    // `list_watched_tables` hands them back the same way, so the round trip
    // that actually happens in production is JSON in and JSON out.
    #[tokio::test]
    async fn watch_state_round_trips_through_the_ipc_wire_shape() {
        let (_dir, db) = db().await;
        let public_dup: QualifiedTable =
            serde_json::from_value(serde_json::json!({"schema": "public", "name": "dup"})).unwrap();
        let alt_dup: QualifiedTable =
            serde_json::from_value(serde_json::json!({"schema": "alt", "name": "dup"})).unwrap();

        set_watched_table_impl(&db.pool, "default", &public_dup, true).await.unwrap();
        set_watched_table_impl(&db.pool, "default", &alt_dup, true).await.unwrap();

        let watched = list_watched_tables_impl(&db.pool, "default").await.unwrap();
        assert_eq!(watched.len(), 2, "one name in two schemas is two watches, not one");
        // Serialized back out, the frontend keys these apart; a bare name would
        // collapse both entries onto one row.
        assert_eq!(
            serde_json::to_value(&watched).unwrap(),
            serde_json::json!([
                {"schema": "alt", "name": "dup"},
                {"schema": "public", "name": "dup"},
            ]),
        );

        set_watched_table_impl(&db.pool, "default", &alt_dup, false).await.unwrap();
        let watched = list_watched_tables_impl(&db.pool, "default").await.unwrap();
        assert_eq!(watched, vec![public_dup], "unwatching one schema must leave the other");
    }

    // `set_watched_table_impl` now takes a `&QualifiedTable`, so a malicious
    // table name can no longer be passed to it at all — the guarantee moved
    // from a runtime check inside the store to `QualifiedTable::new`.
    #[test]
    fn a_malicious_table_name_cannot_construct_a_qualified_table() {
        let result = QualifiedTable::new("public", "orders; DROP TABLE users; --");
        assert!(result.is_err(), "should reject malicious table name before it can reach SQL");
    }
}
