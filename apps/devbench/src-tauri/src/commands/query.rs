use futures::TryStreamExt;
use serde::Serialize;
use sqlx::{Column, Either, Row};
use std::sync::Arc;
use tauri::State;

use crate::commands::db::{cell_to_string, get_column_type, validate_identifier};
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

/// Whether `sql` has an output column list (a SELECT, or anything with
/// RETURNING) and, if so, what it is. Runs on a throwaway connection
/// borrowed from `pool`, never on the transaction the statement will
/// actually execute in: `describe()`'s Parse step raises a genuine Postgres
/// error for semantically invalid SQL (bad column/table/type), and that
/// error aborts whatever transaction it runs in. If it ran on the preview's
/// transaction, the real error would be lost — the follow-up `fetch_many()`
/// on an already-aborted transaction reports only "current transaction is
/// aborted, commands ignored until end of transaction block", masking the
/// actual problem the user needs to see. A separate connection means a
/// `describe()` failure here (for either reason — invalid SQL or a
/// statement that just can't be introspected) only discards its own throwaway
/// connection's aborted implicit transaction, and `fetch_many` goes on to
/// hit the real error itself, on a still-healthy transaction.
async fn describe_result_columns(pool: &sqlx::PgPool, sql: &str) -> Option<Vec<String>> {
    sqlx::Executor::describe(pool, sql)
        .await
        .ok()
        .filter(|d| !d.columns().is_empty())
        .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
}

/// The one place this codebase distinguishes "0 rows returned" from "N rows
/// affected" for an arbitrary single statement. Plain `fetch_all` can't make
/// this distinction — it silently discards the completion tag whenever any
/// rows come back, and reports nothing useful when none do.
///
/// `fetch_many` alone can't tell a zero-row SELECT apart from a zero-row
/// UPDATE either: both surface only a `Left(PgQueryResult)` with no `Right`
/// rows. `described_columns` (from `describe_result_columns`, run ahead of
/// this call) is what tells the two apart — it reflects the statement's
/// shape regardless of how many rows it ends up matching.
async fn execute_with_honest_result(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
    described_columns: Option<Vec<String>>,
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

    let columns = match described_columns {
        Some(columns) => columns,
        // describe() couldn't tell us the shape up front (some statements
        // can't be introspected), but rows actually came back — so this was
        // read-shaped after all. Fall back to the row's own columns.
        None if !rows.is_empty() => rows[0].columns().iter().map(|c| c.name().to_string()).collect(),
        None => return Ok((Vec::new(), Vec::new(), Some(rows_affected))),
    };
    let out_rows = rows
        .iter()
        .map(|row| (0..columns.len()).map(|i| cell_to_string(row, i)).collect())
        .collect();
    Ok((columns, out_rows, None))
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
    let described_columns = describe_result_columns(&pool, sql).await;
    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;
    let (columns, rows, rows_affected) = execute_with_honest_result(&mut tx, sql, described_columns).await?;
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

    // Cast the bound value to the PK column's own type ($2::{pk_type}) rather
    // than casting the column to text: sqlx binds &str parameters as text,
    // and comparing an untouched integer column against a text parameter has
    // no operator — but casting the *column* instead (`"{pk_column}"::text`)
    // is non-sargable and forces a seq scan even on an indexed PK. pk_type
    // comes from the catalog, not user input, but it's still validated below
    // before interpolation, matching this file's identifier discipline.
    let pk_type = get_column_type(&pool, table, pk_column).await?;
    validate_identifier(&pk_type)?;

    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;

    let sql = format!("UPDATE \"{table}\" SET \"{column}\" = $1 WHERE \"{pk_column}\" = $2::{pk_type}");
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
    async fn a_zero_row_select_is_still_a_read_not_a_write_that_touched_nothing() {
        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "SELECT 1 as n WHERE false", 0,
        ).await.unwrap();

        assert_eq!(preview.columns, vec!["n"], "describe() reports the column list even when no rows match");
        assert_eq!(preview.rows, Vec::<Vec<Option<String>>>::new());
        assert_eq!(preview.rows_affected, None, "a SELECT matching nothing is not the same as a write matching nothing");

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();
    }

    #[tokio::test]
    async fn a_zero_row_update_reports_some_zero_not_none() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS zero_row_update_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE zero_row_update_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "UPDATE zero_row_update_test SET status = 'shipped' WHERE id = 999", 0,
        ).await.unwrap();

        assert_eq!(preview.rows, Vec::<Vec<Option<String>>>::new());
        assert_eq!(preview.rows_affected, Some(0), "a write that matched nothing is Some(0), distinct from a SELECT's None");

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();
        sqlx::query("DROP TABLE zero_row_update_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn a_zero_row_update_returning_still_reports_none_affected() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS returning_zero_row_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE returning_zero_row_test (id serial PRIMARY KEY, status text)").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "UPDATE returning_zero_row_test SET status = 'shipped' WHERE id = 999 RETURNING id, status", 0,
        ).await.unwrap();

        assert_eq!(preview.columns, vec!["id", "status"], "RETURNING's column list is real even with zero matches");
        assert_eq!(preview.rows, Vec::<Vec<Option<String>>>::new());
        assert_eq!(preview.rows_affected, None, "RETURNING makes this read-shaped, same as a bare SELECT matching nothing");

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();
        sqlx::query("DROP TABLE returning_zero_row_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn an_invalid_query_surfaces_the_real_postgres_error_not_a_poisoned_transaction_message() {
        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let result = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "SELECT nonexistent_column_xyz FROM pg_catalog.pg_type", 0,
        ).await;

        let err = result.expect_err("invalid SQL must be an error, not a silently-empty result");
        assert!(
            err.contains("nonexistent_column_xyz") || err.contains("does not exist"),
            "error must be Postgres's real complaint about the bad column, not a generic aborted-transaction message: {err}"
        );
        assert!(
            !err.contains("current transaction is aborted"),
            "describe()'s Parse failure must not poison the transaction fetch_many runs against: {err}"
        );
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
    async fn preview_cell_edit_updates_a_text_primary_key_row() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS cell_edit_text_pk_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE cell_edit_text_pk_test (code text PRIMARY KEY, status text)").execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO cell_edit_text_pk_test (code, status) VALUES ('abc', 'pending')").execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_cell_edit_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "cell_edit_text_pk_test", "code", "abc", "status", Some("shipped"), 0,
        ).await.unwrap();
        assert_eq!(preview.rows_affected, Some(1));

        commit_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let status: String = sqlx::query("SELECT status FROM cell_edit_text_pk_test WHERE code = 'abc'")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(status, "shipped");

        sqlx::query("DROP TABLE cell_edit_text_pk_test").execute(&raw).await.unwrap();
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
