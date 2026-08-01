use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::local_db::LocalDb;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TabRow {
    pub id: String,
    pub session_id: Option<String>,
    pub kind: String,
    pub pane: String,
    pub ordinal: i64,
    pub state: Option<String>,
}

fn row_to_tab(r: &sqlx::sqlite::SqliteRow) -> TabRow {
    TabRow {
        id: r.get("id"),
        session_id: r.get("session_id"),
        kind: r.get("kind"),
        pane: r.get("pane"),
        ordinal: r.get("ordinal"),
        state: r.get("state"),
    }
}

// `session_id IS ?`, not `= ?`: NULL is an exact scope here (the scratch
// workspace), never a wildcard for "every tab regardless of session" — SQLite's
// `IS` is the NULL-safe comparison that makes a bound NULL match NULL rows.
pub async fn list_tabs_impl(pool: &SqlitePool, session_id: Option<&str>) -> Result<Vec<TabRow>, String> {
    let rows = sqlx::query(
        "SELECT id, session_id, kind, pane, ordinal, state FROM tabs \
         WHERE session_id IS ? ORDER BY pane, ordinal",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to list tabs: {e}"))?;
    Ok(rows.iter().map(row_to_tab).collect())
}

#[allow(clippy::too_many_arguments)]
pub async fn create_tab_impl(
    pool: &SqlitePool,
    id: &str,
    session_id: Option<&str>,
    kind: &str,
    pane: &str,
    ordinal: i64,
    state: Option<&str>,
) -> Result<(), String> {
    sqlx::query("INSERT INTO tabs (id, session_id, kind, pane, ordinal, state) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id)
        .bind(session_id)
        .bind(kind)
        .bind(pane)
        .bind(ordinal)
        .bind(state)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to create tab: {e}"))?;
    Ok(())
}

pub async fn close_tab_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM tabs WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to close tab: {e}"))?;
    Ok(())
}

/// Not an error when `id` no longer exists — a debounced write can
/// legitimately land after the tab was already closed.
pub async fn set_tab_state_impl(pool: &SqlitePool, id: &str, state: &str) -> Result<(), String> {
    sqlx::query("UPDATE tabs SET state = ? WHERE id = ?")
        .bind(state)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to set tab state: {e}"))?;
    Ok(())
}

pub async fn move_tab_impl(pool: &SqlitePool, id: &str, pane: &str, ordinal: i64) -> Result<(), String> {
    sqlx::query("UPDATE tabs SET pane = ?, ordinal = ? WHERE id = ?")
        .bind(pane)
        .bind(ordinal)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to move tab: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn list_tabs(db: State<'_, LocalDb>, session_id: Option<String>) -> Result<Vec<TabRow>, String> {
    list_tabs_impl(&db.pool, session_id.as_deref()).await
}

#[tauri::command]
pub async fn create_tab(
    db: State<'_, LocalDb>,
    id: String,
    session_id: Option<String>,
    kind: String,
    pane: String,
    ordinal: i64,
    state: Option<String>,
) -> Result<(), String> {
    create_tab_impl(&db.pool, &id, session_id.as_deref(), &kind, &pane, ordinal, state.as_deref()).await
}

#[tauri::command]
pub async fn close_tab(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    close_tab_impl(&db.pool, &id).await
}

#[tauri::command]
pub async fn set_tab_state(db: State<'_, LocalDb>, id: String, state: String) -> Result<(), String> {
    set_tab_state_impl(&db.pool, &id, &state).await
}

#[tauri::command]
pub async fn move_tab(db: State<'_, LocalDb>, id: String, pane: String, ordinal: i64) -> Result<(), String> {
    move_tab_impl(&db.pool, &id, &pane, ordinal).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sessions::create_session_impl;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn creates_and_lists_a_tab_scoped_to_a_session() {
        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        create_tab_impl(&db.pool, "tab-1", Some(&session.id), "api", "left", 0, None).await.unwrap();

        let listed = list_tabs_impl(&db.pool, Some(&session.id)).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "tab-1");
        assert_eq!(listed[0].kind, "api");
    }

    #[tokio::test]
    async fn the_scratch_workspace_is_session_id_null_and_distinct_from_named_sessions() {
        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        create_tab_impl(&db.pool, "scratch-1", None, "api", "left", 0, None).await.unwrap();
        create_tab_impl(&db.pool, "session-1", Some(&session.id), "db", "left", 0, None).await.unwrap();

        assert_eq!(list_tabs_impl(&db.pool, None).await.unwrap().len(), 1);
        assert_eq!(list_tabs_impl(&db.pool, Some(&session.id)).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn lists_ordered_by_pane_then_ordinal() {
        let (_dir, db) = db().await;
        create_tab_impl(&db.pool, "b", None, "log", "left", 1, None).await.unwrap();
        create_tab_impl(&db.pool, "a", None, "api", "left", 0, None).await.unwrap();
        create_tab_impl(&db.pool, "c", None, "email", "right", 0, None).await.unwrap();

        let listed = list_tabs_impl(&db.pool, None).await.unwrap();
        assert_eq!(listed.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn closing_a_tab_removes_only_that_row() {
        let (_dir, db) = db().await;
        create_tab_impl(&db.pool, "keep", None, "api", "left", 0, None).await.unwrap();
        create_tab_impl(&db.pool, "gone", None, "db", "left", 1, None).await.unwrap();

        close_tab_impl(&db.pool, "gone").await.unwrap();

        let listed = list_tabs_impl(&db.pool, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "keep");
    }

    #[tokio::test]
    async fn closing_an_already_closed_tab_is_not_an_error() {
        let (_dir, db) = db().await;
        close_tab_impl(&db.pool, "never-existed").await.unwrap();
    }

    #[tokio::test]
    async fn set_tab_state_updates_the_json_blob() {
        let (_dir, db) = db().await;
        create_tab_impl(&db.pool, "tab-1", None, "db", "left", 0, None).await.unwrap();

        set_tab_state_impl(&db.pool, "tab-1", r#"{"table":"orders"}"#).await.unwrap();

        let listed = list_tabs_impl(&db.pool, None).await.unwrap();
        assert_eq!(listed[0].state.as_deref(), Some(r#"{"table":"orders"}"#));
    }

    // A debounced write can legitimately land after the user already closed
    // the tab. It must not surface as an error the frontend has to handle.
    #[tokio::test]
    async fn set_tab_state_on_a_missing_tab_is_not_an_error() {
        let (_dir, db) = db().await;
        set_tab_state_impl(&db.pool, "never-existed", r#"{"table":"orders"}"#).await.unwrap();
    }

    #[tokio::test]
    async fn move_tab_changes_pane_and_ordinal() {
        let (_dir, db) = db().await;
        create_tab_impl(&db.pool, "tab-1", None, "db", "left", 0, None).await.unwrap();

        move_tab_impl(&db.pool, "tab-1", "right", 3).await.unwrap();

        let listed = list_tabs_impl(&db.pool, None).await.unwrap();
        assert_eq!(listed[0].pane, "right");
        assert_eq!(listed[0].ordinal, 3);
    }

    // The counterpart to commands::history::tests::deleting_a_session_keeps_its_history
    // — same shape of test, opposite FK action, because a tab has no meaning
    // once its session is gone (see the migration's comment).
    #[tokio::test]
    async fn deleting_a_session_deletes_its_tabs_but_not_the_scratch_workspaces() {
        use crate::commands::sessions::delete_session_impl;

        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        create_tab_impl(&db.pool, "tab-1", Some(&session.id), "api", "left", 0, None).await.unwrap();
        create_tab_impl(&db.pool, "scratch-1", None, "api", "left", 0, None).await.unwrap();

        delete_session_impl(&db.pool, &session.id).await.unwrap();

        assert_eq!(list_tabs_impl(&db.pool, Some(&session.id)).await.unwrap().len(), 0);
        assert_eq!(list_tabs_impl(&db.pool, None).await.unwrap().len(), 1);
    }
}
