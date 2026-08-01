use sqlx::{Postgres, Row, Transaction};
use std::collections::HashMap;
use std::sync::Mutex;

/// How long an unresolved preview survives before the background sweep rolls
/// it back. Not user-configurable — a fixed constant, not a Settings field.
pub const PREVIEW_TIMEOUT_MS: i64 = 120_000;

pub struct PendingPreview {
    pub transaction: Transaction<'static, Postgres>,
    expires_at_ms: i64,
}

#[derive(Default)]
pub struct PendingPreviewRegistry {
    previews: Mutex<HashMap<String, PendingPreview>>,
}

impl PendingPreviewRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn hold(&self, transaction: Transaction<'static, Postgres>, now_ms: i64, ttl_ms: i64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        if let Ok(mut previews) = self.previews.lock() {
            previews.insert(id.clone(), PendingPreview { transaction, expires_at_ms: now_ms + ttl_ms });
        }
        id
    }

    pub fn take(&self, preview_id: &str) -> Option<PendingPreview> {
        self.previews.lock().ok()?.remove(preview_id)
    }

    /// Rolls back and evicts every preview whose expiry has passed. Called
    /// periodically by a background task (main.rs) — the only thing standing
    /// between an abandoned preview and a row lock held forever on the user's
    /// real database.
    pub async fn sweep_expired(&self, now_ms: i64) {
        let expired: Vec<PendingPreview> = {
            let mut previews = match self.previews.lock() {
                Ok(p) => p,
                Err(_) => return,
            };
            let expired_ids: Vec<String> = previews
                .iter()
                .filter(|(_, p)| p.expires_at_ms <= now_ms)
                .map(|(id, _)| id.clone())
                .collect();
            expired_ids.into_iter().filter_map(|id| previews.remove(&id)).collect()
        };
        for preview in expired {
            let _ = preview.transaction.rollback().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> sqlx::PgPool {
        let host = std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into());
        let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into());
        let username = std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into());
        let password = std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into());
        let connection_string = crate::connection_registry::postgres_connection_string(
            &host, 5432, &database, &username, Some(&password), "disable",
        );
        sqlx::postgres::PgPoolOptions::new()
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }

    #[tokio::test]
    async fn a_preview_can_be_taken_once_and_only_once() {
        let pool = test_pool().await;
        let tx = pool.begin().await.unwrap();
        let registry = PendingPreviewRegistry::new();
        let id = registry.hold(tx, 0, PREVIEW_TIMEOUT_MS);

        assert!(registry.take(&id).is_some());
        assert!(registry.take(&id).is_none(), "a preview must not be resolvable twice");
    }

    #[tokio::test]
    async fn sweeping_before_expiry_leaves_the_preview_untouched() {
        let pool = test_pool().await;
        let tx = pool.begin().await.unwrap();
        let registry = PendingPreviewRegistry::new();
        let id = registry.hold(tx, 0, 60_000);

        registry.sweep_expired(30_000).await;
        assert!(registry.take(&id).is_some(), "an unexpired preview must survive a sweep");
    }

    #[tokio::test]
    async fn sweeping_after_expiry_rolls_back_and_evicts() {
        let pool = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS sweep_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE sweep_test (id serial PRIMARY KEY)").execute(&pool).await.unwrap();

        let mut tx = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO sweep_test DEFAULT VALUES").execute(&mut *tx).await.unwrap();

        let registry = PendingPreviewRegistry::new();
        let id = registry.hold(tx, 0, 1_000);

        registry.sweep_expired(2_000).await;

        assert!(registry.take(&id).is_none(), "an expired preview must be evicted");

        let count: i64 = sqlx::query("SELECT COUNT(*) as n FROM sweep_test")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(count, 0, "the sweep must have rolled back the insert, not just dropped the handle");

        sqlx::query("DROP TABLE sweep_test").execute(&pool).await.unwrap();
    }
}
