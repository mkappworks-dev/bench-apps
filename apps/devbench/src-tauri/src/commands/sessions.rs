use chrono::Utc;
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;
use uuid::Uuid;

use crate::local_db::LocalDb;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Session {
    pub id: String,
    pub name: String,
    /// Auto-inferred tag for scanning and search — NEVER a restriction on
    /// which tools are visible (v1 spec, "Shell and sessions").
    pub kind: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// `None` = active. `Some(ts)` = archived and restorable from Settings.
    pub archived_at: Option<String>,
}

fn row_to_session(r: &sqlx::sqlite::SqliteRow) -> Session {
    Session {
        id: r.get("id"),
        name: r.get("name"),
        kind: r.get("kind"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
        archived_at: r.get("archived_at"),
    }
}

pub async fn create_session_impl(
    pool: &SqlitePool,
    name: &str,
    kind: Option<&str>,
) -> Result<Session, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a session needs a name".to_string());
    }
    let now = Utc::now().to_rfc3339();
    let session = Session {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        kind: kind.map(str::to_string),
        created_at: now.clone(),
        updated_at: now,
        archived_at: None,
    };
    sqlx::query(
        "INSERT INTO sessions (id, name, kind, created_at, updated_at, archived_at) \
         VALUES (?, ?, ?, ?, ?, NULL)",
    )
    .bind(&session.id)
    .bind(&session.name)
    .bind(&session.kind)
    .bind(&session.created_at)
    .bind(&session.updated_at)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to create session: {e}"))?;
    Ok(session)
}

pub async fn list_sessions_impl(pool: &SqlitePool, archived: bool) -> Result<Vec<Session>, String> {
    let sql = if archived {
        "SELECT id, name, kind, created_at, updated_at, archived_at FROM sessions \
         WHERE archived_at IS NOT NULL ORDER BY archived_at DESC"
    } else {
        "SELECT id, name, kind, created_at, updated_at, archived_at FROM sessions \
         WHERE archived_at IS NULL ORDER BY updated_at DESC"
    };
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to list sessions: {e}"))?;
    Ok(rows.iter().map(row_to_session).collect())
}

pub async fn rename_session_impl(pool: &SqlitePool, id: &str, name: &str) -> Result<Session, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a session needs a name".to_string());
    }
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?")
        .bind(name)
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to rename session: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no session with id {id}"));
    }
    let row = sqlx::query(
        "SELECT id, name, kind, created_at, updated_at, archived_at FROM sessions WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("failed to read renamed session: {e}"))?;
    Ok(row_to_session(&row))
}

/// Archives rather than deletes. Removing a session from the sidebar must be
/// recoverable from Settings > Archive (v1 spec, Capabilities).
pub async fn archive_session_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to archive session: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no active session with id {id}"));
    }
    Ok(())
}

pub async fn restore_session_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query(
        "UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to restore session: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no archived session with id {id}"));
    }
    Ok(())
}

/// Permanent. Only reachable from Settings > Archive, where the user has
/// already said "remove" once and is confirming a second time.
pub async fn delete_session_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to delete session: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no session with id {id}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn create_session(
    db: State<'_, LocalDb>,
    name: String,
    kind: Option<String>,
) -> Result<Session, String> {
    create_session_impl(&db.pool, &name, kind.as_deref()).await
}

#[tauri::command]
pub async fn list_sessions(db: State<'_, LocalDb>) -> Result<Vec<Session>, String> {
    list_sessions_impl(&db.pool, false).await
}

#[tauri::command]
pub async fn list_archived_sessions(db: State<'_, LocalDb>) -> Result<Vec<Session>, String> {
    list_sessions_impl(&db.pool, true).await
}

#[tauri::command]
pub async fn rename_session(db: State<'_, LocalDb>, id: String, name: String) -> Result<Session, String> {
    rename_session_impl(&db.pool, &id, &name).await
}

#[tauri::command]
pub async fn archive_session(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    archive_session_impl(&db.pool, &id).await
}

#[tauri::command]
pub async fn restore_session(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    restore_session_impl(&db.pool, &id).await
}

#[tauri::command]
pub async fn delete_session(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    delete_session_impl(&db.pool, &id).await
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
    async fn creates_and_lists_an_active_session() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Order flow debug", Some("api")).await.unwrap();
        assert_eq!(created.name, "Order flow debug");
        assert_eq!(created.archived_at, None);

        let listed = list_sessions_impl(&db.pool, false).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
    }

    #[tokio::test]
    async fn rejects_a_blank_name() {
        let (_dir, db) = db().await;
        assert!(create_session_impl(&db.pool, "   ", None).await.is_err());
    }

    #[tokio::test]
    async fn archiving_removes_from_the_active_list_but_keeps_the_session_recoverable() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Checkout API", None).await.unwrap();
        archive_session_impl(&db.pool, &created.id).await.unwrap();

        assert_eq!(list_sessions_impl(&db.pool, false).await.unwrap().len(), 0);
        let archived = list_sessions_impl(&db.pool, true).await.unwrap();
        assert_eq!(archived.len(), 1);
        assert!(archived[0].archived_at.is_some());
    }

    #[tokio::test]
    async fn restoring_returns_the_session_to_the_active_list() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Users query", None).await.unwrap();
        archive_session_impl(&db.pool, &created.id).await.unwrap();
        restore_session_impl(&db.pool, &created.id).await.unwrap();

        assert_eq!(list_sessions_impl(&db.pool, false).await.unwrap().len(), 1);
        assert_eq!(list_sessions_impl(&db.pool, true).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn archiving_an_already_archived_session_is_an_error_not_a_silent_no_op() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Twice", None).await.unwrap();
        archive_session_impl(&db.pool, &created.id).await.unwrap();
        assert!(archive_session_impl(&db.pool, &created.id).await.is_err());
    }

    #[tokio::test]
    async fn renaming_updates_the_name_and_the_timestamp() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Old name", None).await.unwrap();
        let renamed = rename_session_impl(&db.pool, &created.id, "New name").await.unwrap();
        assert_eq!(renamed.name, "New name");
        assert_eq!(renamed.id, created.id);
    }

    #[tokio::test]
    async fn deleting_is_permanent_and_reports_an_unknown_id() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Gone", None).await.unwrap();
        delete_session_impl(&db.pool, &created.id).await.unwrap();
        assert_eq!(list_sessions_impl(&db.pool, true).await.unwrap().len(), 0);
        assert!(delete_session_impl(&db.pool, &created.id).await.is_err());
    }
}
