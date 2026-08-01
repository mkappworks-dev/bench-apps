use futures::TryStreamExt;
use serde::Serialize;
use sqlx::{Column, Either, Row};
use std::sync::Arc;
use tauri::State;

use crate::commands::db::{cell_to_string, validate_identifier};
use crate::connection_registry::ConnectionRegistry;
use crate::local_db::LocalDb;
use crate::preview_state::{PendingPreviewRegistry, PREVIEW_TIMEOUT_MS};
use crate::secrets::SecretStore;

#[derive(Debug, Serialize, PartialEq)]
pub struct QueryPreview {
    pub preview_id: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// `Some(n)` = a write that returned no rows of its own; `None` = a
    /// read-shaped result (rows, however many, is the whole story).
    pub rows_affected: Option<u64>,
}

/// The one place this codebase distinguishes "0 rows returned" from "N rows
/// affected" for an arbitrary single statement. Plain `fetch_all` can't make
/// this distinction — it silently discards the completion tag whenever any
/// rows come back, and reports nothing useful when none do.
async fn execute_with_honest_result(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, Option<u64>), String> {
    let mut rows: Vec<sqlx::postgres::PgRow> = Vec::new();
    let mut rows_affected: u64 = 0;
    {
        let mut stream = sqlx::query(sql).fetch_many(&mut **tx);
        while let Some(item) = stream.try_next().await.map_err(|e| format!("query failed: {e}"))? {
            match item {
                Either::Left(result) => rows_affected = result.rows_affected(),
                Either::Right(row) => rows.push(row),
            }
        }
    }

    if rows.is_empty() {
        Ok((Vec::new(), Vec::new(), Some(rows_affected)))
    } else {
        let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
        let out_rows = rows
            .iter()
            .map(|row| (0..columns.len()).map(|i| cell_to_string(row, i)).collect())
            .collect();
        Ok((columns, out_rows, None))
    }
}

pub async fn preview_query_impl(
    registry: &ConnectionRegistry,
    previews: &PendingPreviewRegistry,
    db: &sqlx::SqlitePool,
    secrets: &dyn SecretStore,
    connection_id: &str,
    sql: &str,
    now_ms: i64,
) -> Result<QueryPreview, String> {
    let pool = registry.pool_for(connection_id, db, secrets).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;
    let (columns, rows, rows_affected) = execute_with_honest_result(&mut tx, sql).await?;
    let preview_id = previews.hold(tx, now_ms, PREVIEW_TIMEOUT_MS);
    Ok(QueryPreview { preview_id, columns, rows, rows_affected })
}

#[allow(clippy::too_many_arguments)]
pub async fn preview_cell_edit_impl(
    registry: &ConnectionRegistry,
    previews: &PendingPreviewRegistry,
    db: &sqlx::SqlitePool,
    secrets: &dyn SecretStore,
    connection_id: &str,
    table: &str,
    pk_column: &str,
    pk_value: &str,
    column: &str,
    value: Option<&str>,
    now_ms: i64,
) -> Result<QueryPreview, String> {
    validate_identifier(table)?;
    validate_identifier(pk_column)?;
    validate_identifier(column)?;

    let pool = registry.pool_for(connection_id, db, secrets).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;

    // Cast pk_column to text in SQL (matching correlation.rs's snapshot_table)
    // rather than relying on Postgres to infer $2's type from pk_column: sqlx
    // binds &str parameters as text, and comparing text = integer with no cast
    // has no operator, regardless of what the actual PK value looks like.
    let sql = format!("UPDATE \"{table}\" SET \"{column}\" = $1 WHERE \"{pk_column}\"::text = $2");
    let result = sqlx::query(&sql)
        .bind(value)
        .bind(pk_value)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("update failed: {e}"))?;

    if result.rows_affected() != 1 {
        // A PK match of zero or more than one row means something is wrong
        // with the assumption this edit was built on — not something to
        // preview and let the user paper over.
        let _ = tx.rollback().await;
        return Err(format!(
            "expected to match exactly 1 row by {pk_column} = {pk_value}, matched {}",
            result.rows_affected()
        ));
    }

    let preview_id = previews.hold(tx, now_ms, PREVIEW_TIMEOUT_MS);
    Ok(QueryPreview { preview_id, columns: vec![], rows: vec![], rows_affected: Some(1) })
}

pub async fn commit_preview_impl(previews: &PendingPreviewRegistry, preview_id: &str) -> Result<(), String> {
    let preview = previews.take(preview_id).ok_or_else(|| format!("no open preview with id {preview_id}"))?;
    preview.transaction.commit().await.map_err(|e| format!("commit failed: {e}"))
}

pub async fn rollback_preview_impl(previews: &PendingPreviewRegistry, preview_id: &str) -> Result<(), String> {
    let preview = previews.take(preview_id).ok_or_else(|| format!("no open preview with id {preview_id}"))?;
    preview.transaction.rollback().await.map_err(|e| format!("rollback failed: {e}"))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn preview_query(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    registry: State<'_, Arc<ConnectionRegistry>>,
    previews: State<'_, Arc<PendingPreviewRegistry>>,
    connection_id: String,
    sql: String,
) -> Result<QueryPreview, String> {
    preview_query_impl(&registry, &previews, &db.pool, secrets.as_ref(), &connection_id, &sql, chrono::Utc::now().timestamp_millis()).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn preview_cell_edit(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    registry: State<'_, Arc<ConnectionRegistry>>,
    previews: State<'_, Arc<PendingPreviewRegistry>>,
    connection_id: String,
    table: String,
    pk_column: String,
    pk_value: String,
    column: String,
    value: Option<String>,
) -> Result<QueryPreview, String> {
    preview_cell_edit_impl(
        &registry, &previews, &db.pool, secrets.as_ref(), &connection_id,
        &table, &pk_column, &pk_value, &column, value.as_deref(),
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}

#[tauri::command]
pub async fn commit_preview(previews: State<'_, Arc<PendingPreviewRegistry>>, preview_id: String) -> Result<(), String> {
    commit_preview_impl(&previews, &preview_id).await
}

#[tauri::command]
pub async fn rollback_preview(previews: State<'_, Arc<PendingPreviewRegistry>>, preview_id: String) -> Result<(), String> {
    rollback_preview_impl(&previews, &preview_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::{create_connection_impl, ConnectionInput};
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

    async fn raw_pool() -> sqlx::PgPool {
        let input = local_dev_input();
        let connection_string = crate::connection_registry::postgres_connection_string(
            &input.host, input.port, &input.database, &input.username, input.password.as_deref(), &input.sslmode,
        );
        sqlx::postgres::PgPoolOptions::new()
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }

    #[tokio::test]
    async fn a_select_preview_returns_rows_with_no_affected_count() {
        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(&registry, &previews, &sqlite.pool, &secrets, &created.id, "SELECT 1 as n", 0)
            .await
            .unwrap();

        assert_eq!(preview.columns, vec!["n"]);
        assert_eq!(preview.rows.len(), 1);
        assert_eq!(preview.rows_affected, None);

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();
    }

    #[tokio::test]
    async fn a_write_preview_is_not_visible_until_commit() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS preview_write_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE preview_write_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO preview_write_test (status) VALUES ('pending')").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "UPDATE preview_write_test SET status = 'shipped' WHERE id = 1", 0,
        ).await.unwrap();

        assert_eq!(preview.rows, Vec::<Vec<Option<String>>>::new(), "a write with no RETURNING returns no rows");
        assert_eq!(preview.rows_affected, Some(1), "must report the honest affected-row count, not a false 0");

        let still_pending: String = sqlx::query("SELECT status FROM preview_write_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(still_pending, "pending", "an uncommitted preview must not be visible to another connection");

        commit_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let now_shipped: String = sqlx::query("SELECT status FROM preview_write_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(now_shipped, "shipped");

        sqlx::query("DROP TABLE preview_write_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn rollback_preview_discards_the_write() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS preview_rollback_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE preview_rollback_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO preview_rollback_test (status) VALUES ('pending')").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "UPDATE preview_rollback_test SET status = 'shipped' WHERE id = 1", 0,
        ).await.unwrap();

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let still_pending: String = sqlx::query("SELECT status FROM preview_rollback_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(still_pending, "pending");

        sqlx::query("DROP TABLE preview_rollback_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn committing_or_rolling_back_an_unknown_preview_id_is_a_clear_error() {
        let previews = PendingPreviewRegistry::new();
        assert!(commit_preview_impl(&previews, "not-a-real-id").await.is_err());
        assert!(rollback_preview_impl(&previews, "not-a-real-id").await.is_err());
    }

    #[tokio::test]
    async fn preview_cell_edit_rejects_malicious_identifiers() {
        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let result = preview_cell_edit_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "orders; DROP TABLE users; --", "id", "1", "status", Some("shipped"), 0,
        ).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn preview_cell_edit_updates_exactly_the_matched_row() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS cell_edit_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE cell_edit_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO cell_edit_test (status) VALUES ('pending')").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_cell_edit_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "cell_edit_test", "id", "1", "status", Some("shipped"), 0,
        ).await.unwrap();
        assert_eq!(preview.rows_affected, Some(1));

        commit_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let status: String = sqlx::query("SELECT status FROM cell_edit_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(status, "shipped");

        sqlx::query("DROP TABLE cell_edit_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn preview_cell_edit_errors_when_the_primary_key_value_matches_no_row() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS cell_edit_no_match_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE cell_edit_no_match_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let result = preview_cell_edit_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "cell_edit_no_match_test", "id", "999", "status", Some("shipped"), 0,
        ).await;
        assert!(result.is_err(), "a PK value matching no row must error rather than silently no-op");

        sqlx::query("DROP TABLE cell_edit_no_match_test").execute(&raw).await.unwrap();
    }
}
