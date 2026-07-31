use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::correlation_state::DEFAULT_CORRELATION_WINDOW_MS;
use crate::email_state::DEFAULT_SMTP_PORT;
use crate::local_db::LocalDb;

/// Default AI model. `claude-opus-5` is the current Opus; note that
/// `temperature`/`top_p`/`top_k` are removed on it (sending them is a 400) and
/// that thinking is on by default, so `max_tokens` must leave room for it.
pub const DEFAULT_MODEL: &str = "claude-opus-5";
pub const DEFAULT_PROVIDER: &str = "anthropic";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppSettings {
    pub theme: String,
    pub correlation_window_ms: i64,
    pub smtp_port: u16,
    pub provider: String,
    pub model: String,
}

async fn get_raw(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("failed to read setting {key}: {e}"))?;
    Ok(row.map(|r| r.get::<String, _>("value")))
}

/// Reads every setting, falling back to the constant default when a row is
/// absent or unparseable. A corrupt value must never make the app unusable —
/// it degrades to the default the app shipped with.
pub async fn get_settings_impl(pool: &SqlitePool) -> Result<AppSettings, String> {
    Ok(AppSettings {
        theme: get_raw(pool, "theme").await?.unwrap_or_else(|| "dark".to_string()),
        correlation_window_ms: get_raw(pool, "correlation_window_ms")
            .await?
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|ms| (1_000..=60_000).contains(ms))
            .unwrap_or(DEFAULT_CORRELATION_WINDOW_MS),
        smtp_port: get_raw(pool, "smtp_port")
            .await?
            .and_then(|v| v.parse::<u16>().ok())
            .filter(|p| *p >= 1)
            .unwrap_or(DEFAULT_SMTP_PORT),
        provider: get_raw(pool, "provider").await?.unwrap_or_else(|| DEFAULT_PROVIDER.to_string()),
        model: get_raw(pool, "model").await?.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
    })
}

pub async fn set_setting_impl(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to write setting {key}: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn get_settings(db: State<'_, LocalDb>) -> Result<AppSettings, String> {
    get_settings_impl(&db.pool).await
}

#[tauri::command]
pub async fn set_setting(db: State<'_, LocalDb>, key: String, value: String) -> Result<(), String> {
    set_setting_impl(&db.pool, &key, &value).await
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
    async fn an_empty_settings_table_yields_the_shipped_defaults() {
        let (_dir, db) = db().await;
        let settings = get_settings_impl(&db.pool).await.unwrap();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.correlation_window_ms, DEFAULT_CORRELATION_WINDOW_MS);
        assert_eq!(settings.smtp_port, DEFAULT_SMTP_PORT);
        assert_eq!(settings.model, DEFAULT_MODEL);
    }

    #[tokio::test]
    async fn a_stored_setting_overrides_the_default() {
        let (_dir, db) = db().await;
        set_setting_impl(&db.pool, "correlation_window_ms", "12000").await.unwrap();
        set_setting_impl(&db.pool, "theme", "light").await.unwrap();
        let settings = get_settings_impl(&db.pool).await.unwrap();
        assert_eq!(settings.correlation_window_ms, 12_000);
        assert_eq!(settings.theme, "light");
    }

    #[tokio::test]
    async fn writing_the_same_key_twice_updates_rather_than_erroring() {
        let (_dir, db) = db().await;
        set_setting_impl(&db.pool, "model", "claude-sonnet-5").await.unwrap();
        set_setting_impl(&db.pool, "model", "claude-opus-5").await.unwrap();
        assert_eq!(get_settings_impl(&db.pool).await.unwrap().model, "claude-opus-5");
    }

    // A hand-edited or corrupted DB must degrade to the shipped default, not
    // make the app unusable or silently correlate over a 0 ms window.
    #[tokio::test]
    async fn an_unparseable_or_out_of_range_value_falls_back_to_the_default() {
        let (_dir, db) = db().await;
        set_setting_impl(&db.pool, "correlation_window_ms", "not-a-number").await.unwrap();
        assert_eq!(
            get_settings_impl(&db.pool).await.unwrap().correlation_window_ms,
            DEFAULT_CORRELATION_WINDOW_MS
        );

        set_setting_impl(&db.pool, "correlation_window_ms", "999999").await.unwrap();
        assert_eq!(
            get_settings_impl(&db.pool).await.unwrap().correlation_window_ms,
            DEFAULT_CORRELATION_WINDOW_MS
        );
    }
}
