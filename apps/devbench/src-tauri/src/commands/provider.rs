use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;

use crate::commands::settings::get_settings_impl;
use crate::local_db::LocalDb;
use crate::secrets::SecretStore;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProviderStatus {
    pub provider: String,
    pub model: String,
    /// Whether a key is stored. The key ITSELF is never returned: anything the
    /// frontend can read, any HTML the app renders can also read.
    pub has_key: bool,
}

pub async fn get_provider_status_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<ProviderStatus, String> {
    let settings = get_settings_impl(pool).await?;
    let has_key = secrets.get(&settings.provider)?.is_some();
    Ok(ProviderStatus { provider: settings.provider, model: settings.model, has_key })
}

pub async fn set_provider_api_key_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    key: &str,
) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("an API key cannot be blank — use Remove key to clear it".to_string());
    }
    let settings = get_settings_impl(pool).await?;
    secrets.set(&settings.provider, key)
}

pub async fn clear_provider_api_key_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<(), String> {
    let settings = get_settings_impl(pool).await?;
    secrets.clear(&settings.provider)
}

#[tauri::command]
pub async fn get_provider_status(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
) -> Result<ProviderStatus, String> {
    get_provider_status_impl(&db.pool, secrets.as_ref()).await
}

#[tauri::command]
pub async fn set_provider_api_key(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    key: String,
) -> Result<(), String> {
    set_provider_api_key_impl(&db.pool, secrets.as_ref(), &key).await
}

#[tauri::command]
pub async fn clear_provider_api_key(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
) -> Result<(), String> {
    clear_provider_api_key_impl(&db.pool, secrets.as_ref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::settings::set_setting_impl;
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn status_reports_no_key_before_one_is_stored() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let status = get_provider_status_impl(&db.pool, &secrets).await.unwrap();
        assert!(!status.has_key);
        assert_eq!(status.provider, "anthropic");
        assert_eq!(status.model, "claude-opus-5");
    }

    #[tokio::test]
    async fn storing_a_key_flips_has_key_without_ever_exposing_the_key() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "  sk-ant-secret  ").await.unwrap();

        let status = get_provider_status_impl(&db.pool, &secrets).await.unwrap();
        assert!(status.has_key);
        // The serialized status must not carry the secret anywhere.
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("sk-ant-secret"));
        // …and the stored value is trimmed, so a pasted trailing space does
        // not produce a silent 401 later.
        assert_eq!(secrets.get("anthropic").unwrap().as_deref(), Some("sk-ant-secret"));
    }

    #[tokio::test]
    async fn a_blank_key_is_rejected_rather_than_silently_stored() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        assert!(set_provider_api_key_impl(&db.pool, &secrets, "   ").await.is_err());
    }

    #[tokio::test]
    async fn clearing_removes_the_key() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-secret").await.unwrap();
        clear_provider_api_key_impl(&db.pool, &secrets).await.unwrap();
        assert!(!get_provider_status_impl(&db.pool, &secrets).await.unwrap().has_key);
    }

    #[tokio::test]
    async fn keys_are_stored_per_provider() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant").await.unwrap();
        set_setting_impl(&db.pool, "provider", "openai").await.unwrap();
        assert!(!get_provider_status_impl(&db.pool, &secrets).await.unwrap().has_key);
    }
}
