use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row, SqlitePool};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::secrets::SecretStore;

pub struct ConnectionRegistry {
    pools: Mutex<HashMap<String, PgPool>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self { pools: Mutex::new(HashMap::new()) }
    }

    pub fn invalidate(&self, connection_id: &str) {
        if let Ok(mut pools) = self.pools.lock() {
            pools.remove(connection_id);
        }
    }

    pub async fn pool_for(
        &self,
        connection_id: &str,
        db: &SqlitePool,
        secrets: &dyn SecretStore,
    ) -> Result<PgPool, String> {
        if let Some(pool) = self
            .pools
            .lock()
            .map_err(|_| "connection registry poisoned".to_string())?
            .get(connection_id)
        {
            return Ok(pool.clone());
        }

        let row = sqlx::query(
            "SELECT host, port, database, username, sslmode FROM connections WHERE id = ?",
        )
        .bind(connection_id)
        .fetch_optional(db)
        .await
        .map_err(|e| format!("failed to look up connection {connection_id}: {e}"))?
        .ok_or_else(|| format!("no connection with id {connection_id}"))?;

        let host: String = row.get("host");
        let port: i64 = row.get("port");
        let database: String = row.get("database");
        let username: String = row.get("username");
        let sslmode: String = row.get("sslmode");
        let password = secrets.get(&format!("db-connection:{connection_id}"))?;

        let connection_string = postgres_connection_string(&host, port as u16, &database, &username, password.as_deref(), &sslmode);

        // A modest pool per connection, not the throwaway max_connections(1)
        // this codebase used everywhere before: browsing, the query console,
        // and a held-open preview transaction can all be in flight on the
        // same connection at once now.
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&connection_string)
            .await
            .map_err(|e| format!("connection failed: {e}"))?;

        self.pools
            .lock()
            .map_err(|_| "connection registry poisoned".to_string())?
            .insert(connection_id.to_string(), pool.clone());
        Ok(pool)
    }
}

/// The one place a Postgres connection string gets built anywhere in this
/// codebase — `ConnectionRegistry::pool_for` and (Task 4) `test_connection`/
/// `test_saved_connection` both call this rather than each formatting their
/// own. `password: None` (or empty) omits the credential segment entirely,
/// for local trust/peer-auth setups that have no password at all.
pub fn postgres_connection_string(
    host: &str,
    port: u16,
    database: &str,
    username: &str,
    password: Option<&str>,
    sslmode: &str,
) -> String {
    match password.filter(|p| !p.is_empty()) {
        Some(password) => format!("postgres://{username}:{password}@{host}:{port}/{database}?sslmode={sslmode}"),
        None => format!("postgres://{username}@{host}:{port}/{database}?sslmode={sslmode}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::{create_connection_impl, ConnectionInput};
    use crate::local_db::LocalDb;
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    fn local_dev_input() -> ConnectionInput {
        ConnectionInput {
            name: "Test".to_string(),
            engine: "postgres".to_string(),
            host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
            port: 5432,
            database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            sslmode: "disable".to_string(),
            password: Some(std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into())),
        }
    }

    #[tokio::test]
    async fn a_pool_is_cached_and_reused_for_the_same_connection_id() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();

        registry
            .pool_for(&created.id, &db.pool, &secrets)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup");

        // Corrupt the stored password. A cache hit must not reconnect (and
        // therefore must not notice); a cache miss would fail here.
        secrets.set(&format!("db-connection:{}", created.id), "definitely-wrong").unwrap();
        registry
            .pool_for(&created.id, &db.pool, &secrets)
            .await
            .expect("a cached pool must not reconnect with the now-corrupted stored password");
    }

    #[tokio::test]
    async fn invalidate_forces_a_reconnect_on_the_next_call() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();

        registry.pool_for(&created.id, &db.pool, &secrets).await.expect("requires a real local Postgres");
        secrets.set(&format!("db-connection:{}", created.id), "definitely-wrong").unwrap();
        registry.invalidate(&created.id);

        let result = registry.pool_for(&created.id, &db.pool, &secrets).await;
        assert!(result.is_err(), "invalidate must force a reconnect, which fails with the corrupted password");
    }

    #[tokio::test]
    async fn an_unknown_connection_id_is_a_clear_error() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let registry = ConnectionRegistry::new();

        let result = registry.pool_for("does-not-exist", &db.pool, &secrets).await;
        assert!(result.is_err());
    }
}
