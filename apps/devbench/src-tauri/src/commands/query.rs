use futures::TryStreamExt;
use serde::Serialize;
use sqlx::{Column, Either, Row};
use std::sync::Arc;
use tauri::State;

use crate::commands::db::{cell_to_string, column_types};
use crate::connection_registry::ConnectionRegistry;
use crate::local_db::LocalDb;
use crate::preview_state::{PendingPreviewRegistry, PREVIEW_TIMEOUT_MS};
use crate::secrets::SecretStore;

#[derive(Debug, Serialize, PartialEq)]
pub struct QueryPreview {
    pub preview_id: String,
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// `Some(n)` = a write that returned no rows; `None` = read-shaped.
    pub rows_affected: Option<u64>,
}

/// Describes on `tx` behind a SAVEPOINT: describing on `tx` bare lets a Parse
/// failure abort the whole transaction, and describing on a pooled connection
/// cannot see `tx`'s temp tables or session `SET`s.
async fn describe_result_columns(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
) -> Result<Option<(Vec<String>, Vec<String>)>, String> {
    if sqlx::query("SAVEPOINT devbench_describe").execute(&mut **tx).await.is_err() {
        return Ok(None);
    }
    let described = sqlx::Executor::describe(&mut **tx, sql).await;
    let recovery_sql =
        if described.is_ok() { "RELEASE SAVEPOINT devbench_describe" } else { "ROLLBACK TO SAVEPOINT devbench_describe" };
    let _ = sqlx::query(recovery_sql).execute(&mut **tx).await;
    match described {
        Ok(d) => {
            let columns: Vec<String> = d.columns().iter().map(|c| c.name().to_string()).collect();
            Ok((!columns.is_empty()).then(|| (columns, column_types(d.columns()))))
        }
        Err(e) if is_multiple_commands(&e) => Err(MULTIPLE_COMMANDS_MESSAGE.to_string()),
        Err(_) => Ok(None),
    }
}

/// Matched on the message, not the SQLSTATE: that is the generic 42601 every
/// ordinary typo also raises.
const MULTIPLE_COMMANDS: &str = "cannot insert multiple commands into a prepared statement";

const MULTIPLE_COMMANDS_MESSAGE: &str =
    "one statement per run: this text is several SQL commands separated by `;`. \
     Run them one at a time.";

fn is_multiple_commands(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.message().contains(MULTIPLE_COMMANDS))
}

/// `raw_sql` speaks the simple protocol, which would accept several `;`-separated
/// commands including `COMMIT` — the refusal above is what keeps that safe.
async fn execute_with_honest_result(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
) -> Result<(Vec<String>, Vec<String>, Vec<Vec<Option<String>>>, Option<u64>), String> {
    let described_columns = describe_result_columns(tx, sql).await?;

    let mut rows: Vec<sqlx::postgres::PgRow> = Vec::new();
    let mut rows_affected: u64 = 0;
    {
        let mut stream = sqlx::raw_sql(sql).fetch_many(&mut **tx);
        while let Some(item) = stream.try_next().await.map_err(|e| format!("query failed: {e}"))? {
            match item {
                Either::Left(result) => rows_affected = result.rows_affected(),
                Either::Right(row) => rows.push(row),
            }
        }
    }

    let (columns, column_types) = match described_columns {
        Some(columns) => columns,
        None if !rows.is_empty() => (rows[0].columns().iter().map(|c| c.name().to_string()).collect(), column_types(rows[0].columns())),
        None => return Ok((Vec::new(), Vec::new(), Vec::new(), Some(rows_affected))),
    };
    let out_rows = rows
        .iter()
        .map(|row| (0..columns.len()).map(|i| cell_to_string(row, i)).collect())
        .collect();
    Ok((columns, column_types, out_rows, None))
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
    let (columns, column_types, rows, rows_affected) = execute_with_honest_result(&mut tx, sql).await?;
    let preview_id = previews.hold(tx, now_ms, PREVIEW_TIMEOUT_MS);
    Ok(QueryPreview { preview_id, columns, column_types, rows, rows_affected })
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
            .max_connections(4)
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }

    // Simple protocol sends text, prepared sends binary. A decoding divergence
    // would render working cells as `<unsupported type>` with nothing failing.
    #[allow(deprecated)]
    #[tokio::test]
    async fn raw_sql_decodes_the_same_as_a_prepared_statement() {
        let pool = raw_pool().await;
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(
            "CREATE TEMP TABLE decode_parity (a int4, b int8, c float8, d bool, \
             e uuid, f timestamptz, g text)",
        )
        .execute(&mut *tx).await.unwrap();
        sqlx::query(
            "INSERT INTO decode_parity VALUES (1, 2, 3.5, true, \
             '11111111-1111-1111-1111-111111111111', now(), 'hi')",
        )
        .execute(&mut *tx).await.unwrap();

        let sql = "SELECT * FROM decode_parity";
        let width = 7;

        let mut prepared = Vec::new();
        {
            let mut stream = sqlx::query(sql).fetch_many(&mut *tx);
            while let Some(item) = stream.try_next().await.unwrap() {
                if let Either::Right(row) = item {
                    prepared = (0..width).map(|i| cell_to_string(&row, i)).collect();
                }
            }
        }

        let mut raw = Vec::new();
        {
            let mut stream = sqlx::raw_sql(sql).fetch_many(&mut *tx);
            while let Some(item) = stream.try_next().await.unwrap() {
                if let Either::Right(row) = item {
                    raw = (0..width).map(|i| cell_to_string(&row, i)).collect();
                }
            }
        }

        assert!(!prepared.is_empty(), "the prepared path returned no row to compare");
        assert_eq!(prepared, raw, "raw_sql must decode every cell exactly as the prepared path did");
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
    async fn a_zero_row_select_against_a_temp_table_stays_a_read_on_the_same_connection() {
        // Calls execute_with_honest_result directly: preview_query_impl would
        // draw its own pooled connection, which may not be the one holding the
        // temp table.
        let raw = raw_pool().await;
        let mut tx = raw.begin().await.unwrap();
        sqlx::query("CREATE TEMP TABLE scratch_temp (id int, status text)").execute(&mut *tx).await.unwrap();

        let (columns, _types, rows, rows_affected) =
            execute_with_honest_result(&mut tx, "SELECT id, status FROM scratch_temp WHERE id = 999999").await.unwrap();

        assert_eq!(columns, vec!["id", "status"], "describe() must see the temp table created earlier in this same transaction");
        assert_eq!(rows, Vec::<Vec<Option<String>>>::new());
        assert_eq!(rows_affected, None, "a zero-row SELECT against a temp table must not be misreported as a zero-row write");

        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn a_write_preview_is_not_visible_outside_its_transaction() {
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

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let still_pending: String = sqlx::query("SELECT status FROM preview_write_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(still_pending, "pending", "rolling back must leave the row as it was");

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

    // Unrefused, the trailing COMMIT would commit the preview's own transaction, making the write permanent.
    #[tokio::test]
    async fn a_multi_command_run_is_refused_and_writes_nothing() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS multi_command_refusal_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE multi_command_refusal_test (id serial PRIMARY KEY, status text)")
            .execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO multi_command_refusal_test (status) VALUES ('pending')")
            .execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let result = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "BEGIN; UPDATE multi_command_refusal_test SET status = 'escaped' WHERE id = 1; COMMIT;", 0,
        ).await;

        let err = result.expect_err("multi-command input must be refused, not run");
        assert!(
            err.contains("one statement per run"),
            "the refusal must tell the user what to do about it, got: {err}"
        );

        let status: String = sqlx::query("SELECT status FROM multi_command_refusal_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(status, "pending", "a refused multi-command run must not have written anything");

        sqlx::query("DROP TABLE multi_command_refusal_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn a_single_statement_still_runs_after_the_multi_command_refusal() {
        let raw = raw_pool().await;
        sqlx::query("DROP TABLE IF EXISTS single_command_still_runs_test").execute(&raw).await.unwrap();
        sqlx::query("CREATE TABLE single_command_still_runs_test (id serial PRIMARY KEY, status text)")
            .execute(&raw).await.unwrap();
        sqlx::query("INSERT INTO single_command_still_runs_test (status) VALUES ('pending')")
            .execute(&raw).await.unwrap();

        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "UPDATE single_command_still_runs_test SET status = 'shipped' WHERE id = 1;", 0,
        ).await.unwrap();
        assert_eq!(preview.rows_affected, Some(1));
        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();

        let select = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "SELECT status FROM single_command_still_runs_test WHERE id = 1", 0,
        ).await.unwrap();
        assert_eq!(select.rows, vec![vec![Some("pending".to_string())]]);
        rollback_preview_impl(&previews, &select.preview_id).await.unwrap();

        sqlx::query("DROP TABLE single_command_still_runs_test").execute(&raw).await.unwrap();
    }

    #[tokio::test]
    async fn a_statement_describe_cannot_introspect_still_runs() {
        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();

        let preview = preview_query_impl(
            &registry, &previews, &sqlite.pool, &secrets, &created.id,
            "CREATE TEMP TABLE undescribable_ddl_test (id int)", 0,
        ).await.expect("DDL is a single command and must keep working");
        assert_eq!(preview.rows, Vec::<Vec<Option<String>>>::new());

        rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();
    }

    #[tokio::test]
    async fn rolling_back_an_unknown_preview_id_is_a_clear_error() {
        let previews = PendingPreviewRegistry::new();
        assert!(rollback_preview_impl(&previews, "not-a-real-id").await.is_err());
    }

    #[tokio::test]
    async fn result_metadata_distinguishes_boolean_expressions_and_text_even_without_rows() {
        let (_dir, sqlite) = db().await;
        let secrets = InMemorySecretStore::default();
        let created = create_connection_impl(&sqlite.pool, &secrets, local_dev_input()).await.unwrap();
        let registry = ConnectionRegistry::new();
        let previews = PendingPreviewRegistry::new();
        for suffix in ["", " WHERE false"] {
            let sql = format!("SELECT true AS actual_bool, 'true'::text AS text_bool{suffix}");
            let preview = preview_query_impl(&registry, &previews, &sqlite.pool, &secrets, &created.id, &sql, 0).await.unwrap();
            let wire = serde_json::to_value(&preview).unwrap();
            rollback_preview_impl(&previews, &preview.preview_id).await.unwrap();
            assert_eq!(wire["column_types"], serde_json::json!(["bool", "text"]));
            assert_eq!(preview.columns, vec!["actual_bool", "text_bool"]);
        }
    }

}
