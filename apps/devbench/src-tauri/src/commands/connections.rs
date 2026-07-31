use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::secrets::SecretStore;

fn secret_account(connection_id: &str) -> String {
    format!("db-connection:{connection_id}")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub sslmode: String,
    pub has_password: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionInput {
    pub name: String,
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub sslmode: String,
    pub password: Option<String>,
}

pub async fn list_connections_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<Vec<ConnectionSummary>, String> {
    let rows = sqlx::query(
        "SELECT id, name, engine, host, port, database, username, sslmode FROM connections ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to list connections: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        let has_password = secrets.get(&secret_account(&id))?.is_some();
        out.push(ConnectionSummary {
            id,
            name: row.get("name"),
            engine: row.get("engine"),
            host: row.get("host"),
            port: row.get::<i64, _>("port") as u16,
            database: row.get("database"),
            username: row.get("username"),
            sslmode: row.get("sslmode"),
            has_password,
        });
    }
    Ok(out)
}

pub async fn create_connection_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO connections (id, name, engine, host, port, database, username, sslmode, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.engine)
    .bind(&input.host)
    .bind(input.port as i64)
    .bind(&input.database)
    .bind(&input.username)
    .bind(&input.sslmode)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to create connection: {e}"))?;

    // Blank means "no password" (e.g. local trust/peer auth) — a legitimate
    // real-world case, not an error the way a blank AI provider key is.
    if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
        secrets.set(&secret_account(&id), password)?;
    }

    Ok(ConnectionSummary {
        has_password: secrets.get(&secret_account(&id))?.is_some(),
        id,
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        database: input.database,
        username: input.username,
        sslmode: input.sslmode,
    })
}

pub async fn update_connection_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    id: &str,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    let result = sqlx::query(
        "UPDATE connections SET name = ?, engine = ?, host = ?, port = ?, database = ?, username = ?, sslmode = ?, updated_at = datetime('now') \
         WHERE id = ?",
    )
    .bind(&input.name)
    .bind(&input.engine)
    .bind(&input.host)
    .bind(input.port as i64)
    .bind(&input.database)
    .bind(&input.username)
    .bind(&input.sslmode)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to update connection: {e}"))?;

    if result.rows_affected() == 0 {
        return Err(format!("no connection with id {id}"));
    }

    Ok(ConnectionSummary {
        has_password: secrets.get(&secret_account(id))?.is_some(),
        id: id.to_string(),
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        database: input.database,
        username: input.username,
        sslmode: input.sslmode,
    })
}

pub async fn delete_connection_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    id: &str,
) -> Result<(), String> {
    // watched_tables rows cascade automatically (ON DELETE CASCADE, migration 0004).
    sqlx::query("DELETE FROM connections WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to delete connection: {e}"))?;
    secrets.clear(&secret_account(id))
}

pub async fn set_connection_password_impl(
    secrets: &dyn SecretStore,
    id: &str,
    password: &str,
) -> Result<(), String> {
    let password = password.trim();
    if password.is_empty() {
        return Err("a password cannot be blank — use Clear password to remove it".to_string());
    }
    secrets.set(&secret_account(id), password)
}

pub async fn clear_connection_password_impl(secrets: &dyn SecretStore, id: &str) -> Result<(), String> {
    secrets.clear(&secret_account(id))
}

/// One-time bridge for upgrading installs: migration 0004 seeds the
/// 'default' connection row with today's hardcoded values, but its password
/// can't be seeded by SQL (the keyring isn't SQL-reachable). Called once from
/// main.rs's setup, after migrations run. Never overwrites a password the
/// user has since changed.
pub async fn seed_default_connection_password_if_missing(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<(), String> {
    let exists = sqlx::query("SELECT id FROM connections WHERE id = 'default'")
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("failed to check for the default connection: {e}"))?;
    if exists.is_none() {
        return Ok(());
    }
    if secrets.get(&secret_account("default"))?.is_some() {
        return Ok(());
    }
    // Not a new secret — the literal value already shipping today in
    // App.tsx/ApiTab.tsx/DbTab.tsx's DEV_CONNECTION, relocated once.
    secrets.set(&secret_account("default"), "postgres")
}

#[tauri::command]
pub async fn list_connections(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
) -> Result<Vec<ConnectionSummary>, String> {
    list_connections_impl(&db.pool, secrets.as_ref()).await
}

#[tauri::command]
pub async fn create_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    create_connection_impl(&db.pool, secrets.as_ref(), input).await
}

#[tauri::command]
pub async fn update_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: tauri::State<'_, std::sync::Arc<crate::connection_registry::ConnectionRegistry>>,
    id: String,
    input: ConnectionInput,
) -> Result<ConnectionSummary, String> {
    let summary = update_connection_impl(&db.pool, secrets.as_ref(), &id, input).await?;
    registry.invalidate(&id);
    Ok(summary)
}

#[tauri::command]
pub async fn delete_connection(
    db: tauri::State<'_, crate::local_db::LocalDb>,
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    registry: tauri::State<'_, std::sync::Arc<crate::connection_registry::ConnectionRegistry>>,
    id: String,
) -> Result<(), String> {
    delete_connection_impl(&db.pool, secrets.as_ref(), &id).await?;
    registry.invalidate(&id);
    Ok(())
}

#[tauri::command]
pub async fn set_connection_password(
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    id: String,
    password: String,
) -> Result<(), String> {
    set_connection_password_impl(secrets.as_ref(), &id, &password).await
}

#[tauri::command]
pub async fn clear_connection_password(
    secrets: tauri::State<'_, std::sync::Arc<dyn SecretStore>>,
    id: String,
) -> Result<(), String> {
    clear_connection_password_impl(secrets.as_ref(), &id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_db::LocalDb;
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    fn input(name: &str) -> ConnectionInput {
        ConnectionInput {
            name: name.to_string(),
            engine: "postgres".to_string(),
            host: "staging-db.internal".to_string(),
            port: 5432,
            database: "app".to_string(),
            username: "app_ro".to_string(),
            sslmode: "require".to_string(),
            password: Some("s3cret".to_string()),
        }
    }

    #[tokio::test]
    async fn the_seeded_default_connection_is_listed_with_no_password_yet() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let connections = list_connections_impl(&db.pool, &secrets).await.unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "default");
        assert_eq!(connections[0].name, "Local Dev");
        assert!(!connections[0].has_password);
    }

    #[tokio::test]
    async fn creating_a_connection_stores_metadata_and_the_password_separately() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, input("Staging")).await.unwrap();

        assert_eq!(created.name, "Staging");
        assert!(created.has_password);
        assert_eq!(secrets.get(&secret_account(&created.id)).unwrap().as_deref(), Some("s3cret"));

        // The serialized summary must never carry the secret anywhere.
        let json = serde_json::to_string(&created).unwrap();
        assert!(!json.contains("s3cret"));
    }

    #[tokio::test]
    async fn updating_a_connection_leaves_its_password_untouched() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, input("Staging")).await.unwrap();

        let mut edited = input("Staging (renamed)");
        edited.password = None;
        update_connection_impl(&db.pool, &secrets, &created.id, edited).await.unwrap();

        let connections = list_connections_impl(&db.pool, &secrets).await.unwrap();
        let updated = connections.iter().find(|c| c.id == created.id).unwrap();
        assert_eq!(updated.name, "Staging (renamed)");
        assert!(updated.has_password, "update_connection must not touch the stored password");
        assert_eq!(secrets.get(&secret_account(&created.id)).unwrap().as_deref(), Some("s3cret"));
    }

    #[tokio::test]
    async fn deleting_a_connection_clears_its_password_and_cascades_watched_tables() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, input("Staging")).await.unwrap();
        sqlx::query("INSERT INTO watched_tables (connection_id, table_name) VALUES (?, 'orders')")
            .bind(&created.id)
            .execute(&db.pool)
            .await
            .unwrap();

        delete_connection_impl(&db.pool, &secrets, &created.id).await.unwrap();

        assert_eq!(secrets.get(&secret_account(&created.id)).unwrap(), None);
        let remaining = sqlx::query("SELECT COUNT(*) as n FROM watched_tables WHERE connection_id = ?")
            .bind(&created.id)
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get::<i64, _>("n");
        assert_eq!(remaining, 0, "deleting a connection must cascade its watched_tables rows");
    }

    #[tokio::test]
    async fn set_and_clear_password_round_trip_without_ever_exposing_the_value_in_the_summary() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let mut draft = input("Staging");
        draft.password = None;
        let created = create_connection_impl(&db.pool, &secrets, draft).await.unwrap();
        assert!(!created.has_password);

        set_connection_password_impl(&secrets, &created.id, "new-pw").await.unwrap();
        let connections = list_connections_impl(&db.pool, &secrets).await.unwrap();
        assert!(connections.iter().find(|c| c.id == created.id).unwrap().has_password);

        clear_connection_password_impl(&secrets, &created.id).await.unwrap();
        let connections = list_connections_impl(&db.pool, &secrets).await.unwrap();
        assert!(!connections.iter().find(|c| c.id == created.id).unwrap().has_password);
    }

    #[tokio::test]
    async fn a_blank_password_is_rejected_rather_than_silently_stored() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&db.pool, &secrets, input("Staging")).await.unwrap();
        assert!(set_connection_password_impl(&secrets, &created.id, "   ").await.is_err());
    }

    #[tokio::test]
    async fn seeding_the_default_password_is_skipped_once_a_password_already_exists() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        secrets.set(&secret_account("default"), "user-changed-this").unwrap();

        seed_default_connection_password_if_missing(&db.pool, &secrets).await.unwrap();

        assert_eq!(
            secrets.get(&secret_account("default")).unwrap().as_deref(),
            Some("user-changed-this"),
            "must never overwrite a password the user has since changed"
        );
    }

    #[tokio::test]
    async fn seeding_the_default_password_sets_it_when_absent() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();

        seed_default_connection_password_if_missing(&db.pool, &secrets).await.unwrap();

        assert_eq!(secrets.get(&secret_account("default")).unwrap().as_deref(), Some("postgres"));
    }
}
