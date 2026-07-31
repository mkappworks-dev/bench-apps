use crate::local_db::LocalDb;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct HistoryEntryInput {
    pub method: String,
    pub url: String,
    pub status_code: u16,
    pub response_body: String,
    pub duration_ms: u64,
    /// `None` = unattributed: fired with no active session, or predating
    /// session scoping. `#[serde(default)]` so a payload that omits the
    /// field entirely still deserializes rather than erroring.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HistoryEntry {
    pub id: String,
    pub method: String,
    pub url: String,
    pub status_code: i64,
    pub response_body: String,
    pub duration_ms: i64,
    pub fired_at: String,
    pub session_id: Option<String>,
}

pub async fn save_history_entry_impl(
    pool: &sqlx::SqlitePool,
    entry: HistoryEntryInput,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let fired_at = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at, session_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&entry.method)
    .bind(&entry.url)
    .bind(entry.status_code as i64)
    .bind(&entry.response_body)
    .bind(entry.duration_ms as i64)
    .bind(&fired_at)
    .bind(&entry.session_id)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to save history entry: {e}"))?;

    Ok(())
}

pub async fn list_history_impl(
    pool: &sqlx::SqlitePool,
    session_id: Option<&str>,
) -> Result<Vec<HistoryEntry>, String> {
    // Two distinct queries rather than one `(?1 IS NULL OR session_id = ?1)`
    // predicate. That trick reads as clever but is wrong here: it is easy to
    // write a NULL-tolerant variant that also matches unattributed rows into
    // a named session, which is precisely the behaviour that must not exist.
    // Keeping the unscoped branch as its own literal query also keeps it
    // byte-for-byte what shipped in v1.
    const COLUMNS: &str =
        "SELECT id, method, url, status_code, response_body, duration_ms, fired_at, session_id \
         FROM request_history";

    let rows = match session_id {
        Some(id) => {
            sqlx::query(&format!("{COLUMNS} WHERE session_id = ? ORDER BY fired_at DESC LIMIT 50"))
                .bind(id)
                .fetch_all(pool)
                .await
        }
        None => {
            sqlx::query(&format!("{COLUMNS} ORDER BY fired_at DESC LIMIT 50"))
                .fetch_all(pool)
                .await
        }
    }
    .map_err(|e| format!("failed to list history: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| HistoryEntry {
            id: r.get("id"),
            method: r.get("method"),
            url: r.get("url"),
            status_code: r.get("status_code"),
            response_body: r.get("response_body"),
            duration_ms: r.get("duration_ms"),
            fired_at: r.get("fired_at"),
            session_id: r.get("session_id"),
        })
        .collect())
}

#[tauri::command]
pub async fn save_history_entry(
    db: State<'_, LocalDb>,
    entry: HistoryEntryInput,
) -> Result<(), String> {
    save_history_entry_impl(&db.pool, entry).await
}

#[tauri::command]
pub async fn list_history(
    db: State<'_, LocalDb>,
    session_id: Option<String>,
) -> Result<Vec<HistoryEntry>, String> {
    list_history_impl(&db.pool, session_id.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sessions::{create_session_impl, delete_session_impl};
    use crate::local_db::LocalDb;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    async fn save(pool: &sqlx::SqlitePool, url: &str, session_id: Option<String>) {
        save_history_entry_impl(
            pool,
            HistoryEntryInput {
                method: "POST".to_string(),
                url: url.to_string(),
                status_code: 201,
                response_body: "{}".to_string(),
                duration_ms: 12,
                session_id,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn saves_and_lists_a_history_entry() {
        let (_dir, db) = db().await;
        save(&db.pool, "/api/orders", None).await;

        let entries = list_history_impl(&db.pool, None).await.unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].method, "POST");
        assert_eq!(entries[0].url, "/api/orders");
        assert_eq!(entries[0].status_code, 201);
        assert_eq!(entries[0].session_id, None);
    }

    #[tokio::test]
    async fn history_is_filtered_to_the_requested_session() {
        let (_dir, db) = db().await;
        let a = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        let b = create_session_impl(&db.pool, "Checkout", None).await.unwrap();
        save(&db.pool, "/in-a", Some(a.id.clone())).await;
        save(&db.pool, "/in-b", Some(b.id.clone())).await;

        let in_a = list_history_impl(&db.pool, Some(&a.id)).await.unwrap();
        assert_eq!(in_a.len(), 1);
        assert_eq!(in_a[0].url, "/in-a");

        let in_b = list_history_impl(&db.pool, Some(&b.id)).await.unwrap();
        assert_eq!(in_b.len(), 1);
        assert_eq!(in_b[0].url, "/in-b");
    }

    // NULL means "unattributed", NOT "belongs to everything". A request
    // fired outside any session must never be attributed to one the user
    // happens to have selected later.
    #[tokio::test]
    async fn an_unattributed_row_never_appears_in_a_named_session() {
        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        save(&db.pool, "/unattributed", None).await;

        assert!(list_history_impl(&db.pool, Some(&session.id)).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_unscoped_view_shows_attributed_and_unattributed_rows_alike() {
        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        save(&db.pool, "/attributed", Some(session.id.clone())).await;
        save(&db.pool, "/unattributed", None).await;

        let all = list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    // The sharpest test here. Asserting only "no row points at a missing
    // session" would ALSO pass if the rows had been deleted outright, and
    // would pass if foreign keys were unenforced and the id left dangling
    // (since the unscoped query has no join to notice). Both halves must
    // be asserted: the row SURVIVES, and its link is NULL.
    #[tokio::test]
    async fn deleting_a_session_keeps_its_history_and_nulls_the_link() {
        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        save(&db.pool, "/orders", Some(session.id.clone())).await;

        delete_session_impl(&db.pool, &session.id).await.unwrap();

        let all = list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(all.len(), 1, "deleting a session must not destroy its requests");
        assert_eq!(all[0].url, "/orders");
        assert_eq!(all[0].session_id, None, "the link must be nulled, not left dangling");

        // And the orphaned row must not resurface inside an unrelated session.
        let other = create_session_impl(&db.pool, "Unrelated", None).await.unwrap();
        assert!(list_history_impl(&db.pool, Some(&other.id)).await.unwrap().is_empty());
    }

    // Every other test here starts from a fresh tempdir, so migration 0003 has
    // only ever been exercised against an EMPTY `request_history`. The upgrade
    // path that actually ships is the opposite one: an existing install with
    // rows already in the table. This builds a genuinely pre-0003 database —
    // the same file `LocalDb::connect` will open, migrated only as far as 0002
    // — writes a row into it, and then opens it the way the app does, so the
    // ALTER runs over real data.
    #[tokio::test]
    async fn a_row_written_before_the_migration_survives_it_as_unattributed() {
        use sqlx::migrate::Migration;
        use sqlx::sqlite::SqlitePoolOptions;
        use std::borrow::Cow;

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("devbench.db");
        let url = format!("sqlite://{}?mode=rwc", db_path.display());

        let legacy_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();

        // The real migrator with 0003 withheld — not hand-written DDL, so the
        // starting point is byte-for-byte the schema v1 users are actually on.
        let mut pre_session = sqlx::migrate!("./migrations");
        let earlier: Vec<Migration> = pre_session
            .migrations
            .iter()
            .filter(|m| m.version < 3)
            .cloned()
            .collect();
        assert_eq!(earlier.len(), 2, "expected 0001 and 0002 to precede 0003");
        pre_session.migrations = Cow::Owned(earlier);
        pre_session.run(&legacy_pool).await.unwrap();

        // Without this the test could silently degrade into a post-migration
        // one, asserting nothing about the upgrade at all.
        let columns: Vec<String> = sqlx::query("PRAGMA table_info(request_history)")
            .fetch_all(&legacy_pool)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        assert!(
            !columns.iter().any(|c| c == "session_id"),
            "this database is not pre-0003: {columns:?}"
        );

        sqlx::query(
            "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("legacy-1")
        .bind("GET")
        .bind("/legacy")
        .bind(200_i64)
        .bind("{}")
        .bind(7_i64)
        .bind("2026-01-01T00:00:00Z")
        .execute(&legacy_pool)
        .await
        .unwrap();
        legacy_pool.close().await;

        // Exactly what launching the app against an existing install does.
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        let all = list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(all.len(), 1, "the migration must not drop existing history");
        assert_eq!(all[0].url, "/legacy");
        assert_eq!(all[0].session_id, None, "a pre-existing row lands unattributed");

        // Unattributed means it belongs to no named session — not that it
        // belongs to whichever one the user selects next.
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        assert!(list_history_impl(&db.pool, Some(&session.id)).await.unwrap().is_empty());
    }

    // Archiving is reversible and must not touch history at all. The rows
    // stay attributed to the session throughout, so restoring it needs no
    // recovery step — nothing was ever hidden at the data layer.
    #[tokio::test]
    async fn archiving_and_restoring_a_session_preserves_its_scoped_history() {
        use crate::commands::sessions::{archive_session_impl, restore_session_impl};

        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        save(&db.pool, "/orders", Some(session.id.clone())).await;

        archive_session_impl(&db.pool, &session.id).await.unwrap();
        assert_eq!(list_history_impl(&db.pool, Some(&session.id)).await.unwrap().len(), 1);
        assert_eq!(list_history_impl(&db.pool, None).await.unwrap().len(), 1);

        restore_session_impl(&db.pool, &session.id).await.unwrap();
        let restored = list_history_impl(&db.pool, Some(&session.id)).await.unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].url, "/orders");
    }
}
