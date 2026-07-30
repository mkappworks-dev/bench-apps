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
}

pub async fn save_history_entry_impl(
    pool: &sqlx::SqlitePool,
    entry: HistoryEntryInput,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let fired_at = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&entry.method)
    .bind(&entry.url)
    .bind(entry.status_code as i64)
    .bind(&entry.response_body)
    .bind(entry.duration_ms as i64)
    .bind(&fired_at)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to save history entry: {e}"))?;

    Ok(())
}

pub async fn list_history_impl(pool: &sqlx::SqlitePool) -> Result<Vec<HistoryEntry>, String> {
    let rows = sqlx::query(
        "SELECT id, method, url, status_code, response_body, duration_ms, fired_at \
         FROM request_history ORDER BY fired_at DESC LIMIT 50",
    )
    .fetch_all(pool)
    .await
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
pub async fn list_history(db: State<'_, LocalDb>) -> Result<Vec<HistoryEntry>, String> {
    list_history_impl(&db.pool).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_db::LocalDb;

    #[tokio::test]
    async fn saves_and_lists_a_history_entry() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        save_history_entry_impl(
            &db.pool,
            HistoryEntryInput {
                method: "GET".to_string(),
                url: "/api/orders".to_string(),
                status_code: 200,
                response_body: "{}".to_string(),
                duration_ms: 12,
            },
        )
        .await
        .unwrap();

        let entries = list_history_impl(&db.pool).await.unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].method, "GET");
        assert_eq!(entries[0].url, "/api/orders");
        assert_eq!(entries[0].status_code, 200);
    }
}
