use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::local_db::LocalDb;

/// A saved query, as stored and as sent over IPC. Field names are the wire
/// names — serde reads them exactly as written, matching `TableRows`'s
/// existing `pk_column`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub sql: String,
    /// Epoch milliseconds. Orders the rail, so a rename never reshuffles it.
    pub created_at: i64,
}

fn row_to_query(r: &sqlx::sqlite::SqliteRow) -> SavedQuery {
    SavedQuery {
        id: r.get("id"),
        connection_id: r.get("connection_id"),
        name: r.get("name"),
        sql: r.get("sql"),
        created_at: r.get("created_at"),
    }
}

pub async fn list_saved_queries_impl(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Vec<SavedQuery>, String> {
    // `id` breaks the tie: two queries created inside one millisecond would
    // otherwise come back in whatever order SQLite felt like, and the rail
    // would reshuffle between renders.
    let rows = sqlx::query(
        "SELECT id, connection_id, name, sql, created_at FROM saved_queries \
         WHERE connection_id = ? ORDER BY created_at, id",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to list saved queries: {e}"))?;

    Ok(rows.iter().map(row_to_query).collect())
}

pub async fn create_saved_query_impl(
    pool: &SqlitePool,
    connection_id: &str,
    name: &str,
    sql: &str,
    now_ms: i64,
) -> Result<SavedQuery, String> {
    let made = SavedQuery {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection_id.to_string(),
        name: name.to_string(),
        sql: sql.to_string(),
        created_at: now_ms,
    };

    sqlx::query(
        "INSERT INTO saved_queries (id, connection_id, name, sql, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&made.id)
    .bind(&made.connection_id)
    .bind(&made.name)
    .bind(&made.sql)
    .bind(made.created_at)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to create saved query: {e}"))?;

    Ok(made)
}

pub async fn rename_saved_query_impl(pool: &SqlitePool, id: &str, name: &str) -> Result<(), String> {
    sqlx::query("UPDATE saved_queries SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to rename saved query: {e}"))?;
    Ok(())
}

pub async fn set_saved_query_sql_impl(pool: &SqlitePool, id: &str, sql: &str) -> Result<(), String> {
    sqlx::query("UPDATE saved_queries SET sql = ? WHERE id = ?")
        .bind(sql)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to save query sql: {e}"))?;
    Ok(())
}

pub async fn delete_saved_query_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM saved_queries WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to delete saved query: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn list_saved_queries(
    db: State<'_, LocalDb>,
    connection_id: String,
) -> Result<Vec<SavedQuery>, String> {
    list_saved_queries_impl(&db.pool, &connection_id).await
}

#[tauri::command]
pub async fn create_saved_query(
    db: State<'_, LocalDb>,
    connection_id: String,
    name: String,
    sql: String,
) -> Result<SavedQuery, String> {
    create_saved_query_impl(&db.pool, &connection_id, &name, &sql, chrono::Utc::now().timestamp_millis()).await
}

#[tauri::command]
pub async fn rename_saved_query(db: State<'_, LocalDb>, id: String, name: String) -> Result<(), String> {
    rename_saved_query_impl(&db.pool, &id, &name).await
}

#[tauri::command]
pub async fn set_saved_query_sql(db: State<'_, LocalDb>, id: String, sql: String) -> Result<(), String> {
    set_saved_query_sql_impl(&db.pool, &id, &sql).await
}

#[tauri::command]
pub async fn delete_saved_query(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    delete_saved_query_impl(&db.pool, &id).await
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
    async fn a_created_query_round_trips() {
        let (_dir, db) = db().await;
        let made = create_saved_query_impl(&db.pool, "default", "failed orders", "SELECT 1;", 1000)
            .await
            .unwrap();

        assert_eq!(made.connection_id, "default");
        assert_eq!(made.name, "failed orders");
        assert_eq!(made.sql, "SELECT 1;");
        assert_eq!(made.created_at, 1000);
        assert!(!made.id.is_empty(), "the store assigns the id, not the caller");

        let listed = list_saved_queries_impl(&db.pool, "default").await.unwrap();
        assert_eq!(listed, vec![made]);
    }

    // Renaming must not reshuffle the rail, which is the whole reason the
    // order key is created_at rather than name.
    #[tokio::test]
    async fn the_list_is_ordered_by_creation_and_renaming_does_not_move_a_row() {
        let (_dir, db) = db().await;
        let first = create_saved_query_impl(&db.pool, "default", "aaa", "", 100).await.unwrap();
        let second = create_saved_query_impl(&db.pool, "default", "bbb", "", 200).await.unwrap();
        let third = create_saved_query_impl(&db.pool, "default", "ccc", "", 300).await.unwrap();

        rename_saved_query_impl(&db.pool, &third.id, "aaa-renamed-to-sort-first").await.unwrap();

        let ids: Vec<String> =
            list_saved_queries_impl(&db.pool, "default").await.unwrap().into_iter().map(|q| q.id).collect();
        assert_eq!(ids, vec![first.id, second.id, third.id]);
    }

    // Two queries created inside the same millisecond must still have a
    // stable order, or the rail reshuffles between renders for no reason.
    #[tokio::test]
    async fn queries_sharing_a_timestamp_still_order_deterministically() {
        let (_dir, db) = db().await;
        create_saved_query_impl(&db.pool, "default", "one", "", 500).await.unwrap();
        create_saved_query_impl(&db.pool, "default", "two", "", 500).await.unwrap();
        create_saved_query_impl(&db.pool, "default", "three", "", 500).await.unwrap();

        let once: Vec<String> =
            list_saved_queries_impl(&db.pool, "default").await.unwrap().into_iter().map(|q| q.id).collect();
        let twice: Vec<String> =
            list_saved_queries_impl(&db.pool, "default").await.unwrap().into_iter().map(|q| q.id).collect();
        assert_eq!(once, twice);
        assert_eq!(once.len(), 3);
    }

    #[tokio::test]
    async fn renaming_and_editing_sql_update_in_place() {
        let (_dir, db) = db().await;
        let made = create_saved_query_impl(&db.pool, "default", "old name", "SELECT 1;", 1).await.unwrap();

        rename_saved_query_impl(&db.pool, &made.id, "new name").await.unwrap();
        set_saved_query_sql_impl(&db.pool, &made.id, "SELECT 2;").await.unwrap();

        let listed = list_saved_queries_impl(&db.pool, "default").await.unwrap();
        assert_eq!(listed.len(), 1, "an update must not insert a second row");
        assert_eq!(listed[0].name, "new name");
        assert_eq!(listed[0].sql, "SELECT 2;");
        assert_eq!(listed[0].created_at, 1, "editing must not restamp creation");
    }

    #[tokio::test]
    async fn deleting_removes_only_that_query() {
        let (_dir, db) = db().await;
        let keep = create_saved_query_impl(&db.pool, "default", "keep", "", 1).await.unwrap();
        let doomed = create_saved_query_impl(&db.pool, "default", "doomed", "", 2).await.unwrap();

        delete_saved_query_impl(&db.pool, &doomed.id).await.unwrap();

        let listed = list_saved_queries_impl(&db.pool, "default").await.unwrap();
        assert_eq!(listed, vec![keep]);
    }

    // Same shape as watched_tables' scoping test: a second connection has to
    // really exist, because connection_id is a foreign key.
    #[tokio::test]
    async fn queries_are_scoped_per_connection() {
        let (_dir, db) = db().await;
        sqlx::query(
            "INSERT INTO connections (id, name, engine, host, port, database, username, sslmode, created_at, updated_at) \
             VALUES ('staging', 'Staging', 'postgres', 'staging-db.internal', 5432, 'app', 'app_ro', 'require', datetime('now'), datetime('now'))",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        create_saved_query_impl(&db.pool, "default", "dev only", "", 1).await.unwrap();
        assert!(list_saved_queries_impl(&db.pool, "staging").await.unwrap().is_empty());
    }

    // The cascade is the reason connection_id is a real foreign key rather
    // than a loose string: a query naming a dropped connection's tables has
    // nothing left to run against.
    #[tokio::test]
    async fn deleting_a_connection_takes_its_queries_with_it() {
        let (_dir, db) = db().await;
        create_saved_query_impl(&db.pool, "default", "doomed", "", 1).await.unwrap();

        sqlx::query("PRAGMA foreign_keys = ON").execute(&db.pool).await.unwrap();
        sqlx::query("DELETE FROM connections WHERE id = 'default'").execute(&db.pool).await.unwrap();

        assert!(list_saved_queries_impl(&db.pool, "default").await.unwrap().is_empty());
    }

    // Nothing in this module interpolates, so a query whose NAME is hostile
    // is stored and returned verbatim rather than being rejected or mangled.
    #[tokio::test]
    async fn a_hostile_name_is_stored_verbatim_because_nothing_interpolates_it() {
        let (_dir, db) = db().await;
        let nasty = "'; DROP TABLE saved_queries; --";
        let made = create_saved_query_impl(&db.pool, "default", nasty, "", 1).await.unwrap();

        let listed = list_saved_queries_impl(&db.pool, "default").await.unwrap();
        assert_eq!(listed, vec![made]);
        assert_eq!(listed[0].name, nasty);
    }
}
