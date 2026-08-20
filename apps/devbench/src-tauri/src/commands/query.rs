use futures::TryStreamExt;
use serde::Serialize;
use sqlx::{Column, Either, Row};
use std::sync::Arc;
use tauri::State;

use crate::commands::db::cell_to_string;
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
/// RETURNING) and, if so, what it is. Runs `describe()` on `tx` — the same
/// connection the statement will actually execute on, wrapped in a
/// SAVEPOINT — rather than either of the two approaches that came before:
///
///   - describing on `tx` directly (no savepoint) let a Parse failure on
///     invalid SQL abort the whole transaction, so the follow-up execution
///     saw only "current transaction is aborted" instead of the real error;
///   - describing on a separate pooled connection avoided that, but meant
///     `describe()` and the real execution could land on two different
///     physical backends. Temp tables, `SET`/search_path, and other
///     connection-scoped state can differ between them — reproduced
///     empirically as a valid zero-row SELECT against a temp table getting
///     misreported as a zero-row *write* when `describe()` drew a
///     connection that had never seen the temp table.
///
/// A SAVEPOINT gets both properties at once: `describe()` runs on the exact
/// connection/session the statement will execute in (so temp tables etc.
/// are always visible to both), and a Parse failure only aborts the
/// savepoint — `ROLLBACK TO SAVEPOINT` recovers `tx` to just before it, so
/// the subsequent real execution still runs cleanly and surfaces Postgres's
/// actual error for genuinely invalid SQL.
///
/// `Err` is reserved for the one describe failure that must stop the run
/// before it executes: multi-command input (see MULTIPLE_COMMANDS). Every
/// other failure is `Ok(None)` — plenty of legitimate single statements
/// (DDL, `SET`) cannot be introspected and must keep working.
async fn describe_result_columns(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
) -> Result<Option<Vec<String>>, String> {
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
            Ok((!columns.is_empty()).then_some(columns))
        }
        Err(e) if is_multiple_commands(&e) => Err(MULTIPLE_COMMANDS_MESSAGE.to_string()),
        Err(_) => Ok(None),
    }
}

/// Postgres's complaint when the prepared protocol is handed more than one
/// command. Matched on the message rather than the SQLSTATE, which is the
/// generic 42601 `syntax_error` shared with every ordinary typo.
const MULTIPLE_COMMANDS: &str = "cannot insert multiple commands into a prepared statement";

const MULTIPLE_COMMANDS_MESSAGE: &str =
    "one statement per run: this text is several SQL commands separated by `;`. \
     Run them one at a time.";

fn is_multiple_commands(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.message().contains(MULTIPLE_COMMANDS))
}

/// The one place this codebase distinguishes "0 rows returned" from "N rows
/// affected" for an arbitrary single statement. Plain `fetch_all` can't make
/// this distinction — it silently discards the completion tag whenever any
/// rows come back, and reports nothing useful when none do.
///
/// `fetch_many` alone can't tell a zero-row SELECT apart from a zero-row
/// UPDATE either: both surface only a `Left(PgQueryResult)` with no `Right`
/// rows. `describe_result_columns` is what tells the two apart — it
/// reflects the statement's shape regardless of how many rows it ends up
/// matching.
///
/// `raw_sql` rather than `query`: the Either stream is the only way to get
/// rows AND the completion tag from one execution, and `query(...).fetch_many`
/// is deprecated. `raw_sql` uses Postgres's simple protocol instead of the
/// prepared one, which returns values in text format — `raw_sql_decodes_the_same_as_a_prepared_statement`
/// pins that this changes nothing about how cells decode, since a divergence
/// there would silently turn working columns into `<unsupported type>`.
/// One consequence, not a feature: the simple protocol accepts several
/// statements separated by `;`, where the prepared one rejected them — and
/// `COMMIT` is one of the statements it accepts. A multi-command run could
/// therefore commit the very transaction this preview opened, leaving the
/// write permanent while `rows_affected` reported only the trailing `COMMIT`
/// tag (0) and the caller's rollback failed with "there is no transaction in
/// progress". That is why `describe_result_columns` refuses multi-command
/// input outright, before anything executes: the refusal is what keeps
/// `raw_sql` safe here, not anything about `raw_sql` itself.
async fn execute_with_honest_result(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, Option<u64>), String> {
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
    let mut tx = pool.begin().await.map_err(|e| format!("failed to open a transaction: {e}"))?;
    let (columns, rows, rows_affected) = execute_with_honest_result(&mut tx, sql).await?;
    let preview_id = previews.hold(tx, now_ms, PREVIEW_TIMEOUT_MS);
    Ok(QueryPreview { preview_id, columns, rows, rows_affected })
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
            // Capped so the suite's parallel tests can't collectively exhaust
            // Postgres's max_connections; each test needs only a handful.
            .max_connections(4)
            .connect(&connection_string)
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup")
    }

    // The switch from `query(...)` to `raw_sql(...)` in
    // execute_with_honest_result moved this path onto Postgres's simple
    // protocol, which sends values as text rather than binary. If sqlx ever
    // decodes the two differently, cells that work today would start rendering
    // as `<unsupported type>` with nothing else failing. numeric is already
    // undecoded on both paths — that is pre-existing and equally so.
    // Calls the deprecated prepared path on purpose: the whole point is to
    // compare against it. The deprecation is what execute_with_honest_result
    // moved away from.
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
        // Regression test for the round-2 finding: describe() must run on
        // the exact same connection/session as the real execution, or a
        // temp table visible to one but not the other can misclassify a
        // valid zero-row SELECT as a zero-row write. Calls
        // execute_with_honest_result directly (not preview_query_impl,
        // which would acquire its own connection from a pool and can't
        // guarantee it's the same one) so the temp table and the SELECT are
        // certain to share one transaction — the same connection the
        // SAVEPOINT-wrapped describe() and fetch_many both run on inside it.
        let raw = raw_pool().await;
        let mut tx = raw.begin().await.unwrap();
        sqlx::query("CREATE TEMP TABLE scratch_temp (id int, status text)").execute(&mut *tx).await.unwrap();

        let (columns, rows, rows_affected) =
            execute_with_honest_result(&mut tx, "SELECT id, status FROM scratch_temp WHERE id = 999999").await.unwrap();

        assert_eq!(columns, vec!["id", "status"], "describe() must see the temp table created earlier in this same transaction");
        assert_eq!(rows, Vec::<Vec<Option<String>>>::new());
        assert_eq!(rows_affected, None, "a zero-row SELECT against a temp table must not be misreported as a zero-row write");

        tx.rollback().await.unwrap();
    }

    // The isolation guarantee Run query rests on: a statement's effect is
    // real inside its transaction and invisible outside it, so the effect can
    // be reported honestly without anything being written.
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

    // The Critical this refusal exists for: `raw_sql` uses the simple
    // protocol, which accepts several statements separated by `;` — `COMMIT`
    // among them. Unrefused, `BEGIN; UPDATE ...; COMMIT;` commits the preview
    // transaction itself, so the write is permanent while the pane reports
    // "rolled back" and "0 rows affected" (the trailing COMMIT's tag).
    // The second connection is the whole point: it proves nothing was
    // written, which reading the code cannot.
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

        // From a second connection, after the refusal: the row must be
        // exactly as it was. A committed escape would read 'escaped' here.
        let status: String = sqlx::query("SELECT status FROM multi_command_refusal_test WHERE id = 1")
            .fetch_one(&raw).await.unwrap().get("status");
        assert_eq!(status, "pending", "a refused multi-command run must not have written anything");

        sqlx::query("DROP TABLE multi_command_refusal_test").execute(&raw).await.unwrap();
    }

    // The refusal must be narrow. A trailing `;` is one command, and a single
    // write still runs and still reports its honest count.
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

    // A statement `describe()` cannot introspect must NOT be caught by the
    // multi-command refusal — that is the whole reason the match is on
    // Postgres's specific message rather than on any describe failure.
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

}
