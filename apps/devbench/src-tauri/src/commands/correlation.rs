use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Pool, Postgres, Row};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use super::db::{connection_string, validate_identifier, DbConnectInput};
use super::history::{save_history_entry_impl, HistoryEntryInput};
use super::request::{fire_request_impl, FireRequestInput, FireRequestOutput};
use crate::local_db::LocalDb;

#[derive(Debug, Clone)]
pub struct RowSnapshot {
    pub pk: String,
    pub hash: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TableDiff {
    pub table: String,
    pub inserted: i64,
    pub updated: i64,
    pub deleted: i64,
}

pub fn diff_table_snapshots(table: &str, before: &[RowSnapshot], after: &[RowSnapshot]) -> TableDiff {
    let before_map: HashMap<&str, &str> =
        before.iter().map(|r| (r.pk.as_str(), r.hash.as_str())).collect();
    let after_map: HashMap<&str, &str> =
        after.iter().map(|r| (r.pk.as_str(), r.hash.as_str())).collect();

    let mut inserted = 0i64;
    let mut updated = 0i64;
    for (pk, after_hash) in &after_map {
        match before_map.get(pk) {
            None => inserted += 1,
            Some(before_hash) if before_hash != after_hash => updated += 1,
            _ => {}
        }
    }

    let deleted = before_map.keys().filter(|pk| !after_map.contains_key(*pk)).count() as i64;

    TableDiff {
        table: table.to_string(),
        inserted,
        updated,
        deleted,
    }
}

pub async fn get_primary_key_column(pool: &Pool<Postgres>, table: &str) -> Result<String, String> {
    let rows = sqlx::query(
        "SELECT kcu.column_name FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name \
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to look up primary key for {table}: {e}"))?;

    match rows.len() {
        0 => Err(format!("table {table} has no single-column primary key — not watchable")),
        1 => Ok(rows[0].get::<String, _>("column_name")),
        _ => Err(format!("table {table} has a composite primary key — not watchable")),
    }
}

pub async fn snapshot_table(
    pool: &Pool<Postgres>,
    table: &str,
    pk_col: &str,
) -> Result<Vec<RowSnapshot>, String> {
    // Validate both identifiers before using them in SQL — `table` comes straight
    // from the frontend's `watched_tables` list with no validation upstream, and
    // `pk_col`, while normally sourced from `information_schema` (trusted), is
    // validated too as defense-in-depth, matching db.rs's `list_table_rows_impl`.
    validate_identifier(table)?;
    validate_identifier(pk_col)?;

    // Double-quote both identifiers as defense-in-depth after validation.
    let sql = format!("SELECT \"{pk_col}\"::text as pk, md5(t::text) as hash FROM \"{table}\" t");
    let rows = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("snapshot failed for {table}: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|r| RowSnapshot { pk: r.get("pk"), hash: r.get("hash") })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct CorrelationResult {
    /// Handle for the second phase (`collect_correlation_window`). Filled in
    /// by Task 6; a fixed placeholder until then.
    pub correlation_id: String,
    pub response: FireRequestOutput,
    /// `None` means the DB could not be verified — never rendered as "0 writes".
    /// `Some(vec![])` means it WAS verified and nothing changed.
    pub table_diffs: Option<Vec<TableDiff>>,
    pub db_error: Option<String>,
}

/// Snapshots every watched table. Returned as a `Result` so the caller can
/// degrade to "unable to verify" instead of failing the whole request.
async fn snapshot_all(
    pool: &Pool<Postgres>,
    watched_tables: &[String],
) -> Result<Vec<(String, String, Vec<RowSnapshot>)>, String> {
    let mut snapshots = Vec::with_capacity(watched_tables.len());
    for table in watched_tables {
        let pk_col = get_primary_key_column(pool, table).await?;
        let snapshot = snapshot_table(pool, table, &pk_col).await?;
        snapshots.push((table.clone(), pk_col, snapshot));
    }
    Ok(snapshots)
}

async fn diff_all(
    pool: &Pool<Postgres>,
    before: Vec<(String, String, Vec<RowSnapshot>)>,
) -> Result<Vec<TableDiff>, String> {
    let mut table_diffs = Vec::with_capacity(before.len());
    for (table, pk_col, before_rows) in before {
        let after = snapshot_table(pool, &table, &pk_col).await?;
        let diff = diff_table_snapshots(&table, &before_rows, &after);
        if diff.inserted > 0 || diff.updated > 0 || diff.deleted > 0 {
            table_diffs.push(diff);
        }
    }
    Ok(table_diffs)
}

pub async fn run_correlated_request_impl(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
    logs: &crate::log_state::LogState,
) -> Result<CorrelationResult, String> {
    // Everything DB-related is fallible-but-not-fatal. Only a failure to fire
    // the request itself fails the command, because without a response there
    // is nothing to correlate against.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(&connection))
        .await
        .map_err(|e| format!("connection failed: {e}"))
        .ok();

    let before = match &pool {
        Some(p) => snapshot_all(p, &watched_tables).await.map_err(Some),
        None => Err(Some("connection failed".to_string())),
    };

    let _ = logs; // used from Task 6 onward

    let response = fire_request_impl(request).await?;

    let (table_diffs, db_error) = match (pool, before) {
        (Some(p), Ok(snapshots)) => match diff_all(&p, snapshots).await {
            Ok(diffs) => (Some(diffs), None),
            Err(e) => (None, Some(e)),
        },
        (_, Err(e)) => (None, e),
        (None, Ok(_)) => (None, Some("connection failed".to_string())),
    };

    Ok(CorrelationResult {
        correlation_id: String::new(),
        response,
        table_diffs,
        db_error,
    })
}

/// Persists a request-history entry for a correlated request that already
/// succeeded. Takes the raw SQLite pool (not a Tauri `State`) so it stays
/// directly unit-testable, matching this codebase's `_impl` convention.
///
/// A failure here is intentionally non-fatal to the caller: the user's actual
/// HTTP request already completed by the time this runs, so we don't want a
/// local SQLite hiccup to fail the whole command. It's not swallowed silently
/// either — it's logged so an empty history sidebar is debuggable.
async fn save_correlation_history(
    pool: &sqlx::SqlitePool,
    method: &str,
    url: &str,
    response: &FireRequestOutput,
    session_id: Option<&str>,
) {
    let entry = HistoryEntryInput {
        method: method.to_string(),
        url: url.to_string(),
        status_code: response.status_code,
        response_body: response.body.clone(),
        duration_ms: response.duration_ms,
        session_id: session_id.map(str::to_string),
    };
    if let Err(e) = save_history_entry_impl(pool, entry).await {
        eprintln!("failed to save request history entry after a successful correlated request: {e}");
    }
}

use crate::correlation_state::{CorrelationRegistry, DEFAULT_CORRELATION_WINDOW_MS};
use crate::email_state::{EmailState, EmailSummary};
use crate::log_state::{LogLine, LogState};

#[derive(Debug, Serialize, PartialEq)]
pub struct CorrelationWindowResult {
    /// `None` means no log source was configured — logs were NOT observed.
    /// `Some(vec![])` means we were tailing and nothing was logged.
    pub log_lines: Option<Vec<LogLine>>,
    /// True when the ring buffer evicted lines belonging to this window before
    /// they were collected. The UI must render the count as "N+", never as N.
    pub log_lines_truncated: bool,
    /// `None` = the SMTP catcher is not listening, so mail was NOT observed.
    /// `Some(vec![])` = it was listening and nothing was sent.
    pub emails: Option<Vec<EmailSummary>>,
    pub emails_truncated: bool,
}

/// The real orchestration. `now_ms` is injected so tests can place the window
/// in the past and skip the wait entirely.
pub async fn run_correlated_request_impl_with_registry(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
    logs: &LogState,
    emails: &EmailState,
    registry: &CorrelationRegistry,
    now_ms: i64,
    // How long after the response to keep collecting. Comes from Settings >
    // General; `DEFAULT_CORRELATION_WINDOW_MS` is the fallback when no row
    // has been stored.
    window_ms: i64,
) -> Result<CorrelationResult, String> {
    let from_log_id = logs.next_line_id().saturating_sub(1);
    let from_email_id = emails.store().lock().map(|s| s.next_id().saturating_sub(1)).unwrap_or(0);

    // The window's end is anchored to *response* time, not request-start
    // time: `now_ms` is captured by the caller before `fire_request_impl`
    // is even invoked, so naively computing `now_ms + window_ms` measures
    // the window from "when this command was invoked," not from "when the
    // response actually came back," as the spec and Settings > General's UI
    // copy ("N seconds after the response") both promise. For any request
    // slower than `window_ms`, that would silently shrink (or entirely
    // consume) the window before a single log line or email had a chance to
    // land, and a failure to observe must never be rendered as "nothing
    // happened" (this app's core principle). `elapsed_ms`, measured with a
    // monotonic clock (immune to wall-clock adjustments, unlike a
    // `chrono::Utc::now()` diff), is exactly how long the awaited request
    // took, so `now_ms + elapsed_ms` reconstructs the response's wall-clock
    // time and `now_ms + elapsed_ms + window_ms` is "response time +
    // window_ms" — matching the documented behavior — while adding only a
    // negligible, deterministic offset in tests (mocked HTTP responses
    // resolve in low single-digit milliseconds).
    let request_started_at = std::time::Instant::now();
    let mut result = run_correlated_request_impl(request, connection, watched_tables, logs).await?;
    let elapsed_ms = request_started_at.elapsed().as_millis() as i64;

    result.correlation_id = registry.open(from_log_id, from_email_id, now_ms + elapsed_ms + window_ms);
    Ok(result)
}

pub async fn collect_correlation_window_impl(
    registry: &CorrelationRegistry,
    logs: &LogState,
    emails: &EmailState,
    correlation_id: String,
    now_ms: i64,
) -> Result<CorrelationWindowResult, String> {
    let window = registry
        .take(&correlation_id)
        .ok_or_else(|| format!("no open correlation window with id {correlation_id}"))?;

    let remaining_ms = window.window_ends_at_ms - now_ms;
    if remaining_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(remaining_ms as u64)).await;
    }

    let log_lines = logs.collect_window(window.from_log_id, window.window_ends_at_ms);
    let log_lines_truncated = log_lines.is_some()
        && logs.read_since(window.from_log_id, None, 1).dropped > 0;

    // A catcher that is not listening did not observe anything — reporting
    // zero mail would be a false negative, which principle 4 forbids.
    let (captured, emails_truncated) = if emails.status().listening {
        match emails.store().lock() {
            Ok(store) => (
                Some(store.between(window.from_email_id, window.window_ends_at_ms)),
                store.evicted_through_id() > window.from_email_id,
            ),
            Err(_) => (None, false),
        }
    } else {
        (None, false)
    };

    Ok(CorrelationWindowResult {
        log_lines,
        log_lines_truncated,
        emails: captured,
        emails_truncated,
    })
}

#[tauri::command]
pub async fn collect_correlation_window(
    registry: State<'_, Arc<CorrelationRegistry>>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    correlation_id: String,
) -> Result<CorrelationWindowResult, String> {
    collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        correlation_id,
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}

// The argument list IS the IPC surface: four `State` injections plus the
// request payload. Collapsing it into a params struct would change the shape
// the frontend has to invoke with, for no gain on this side.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_correlated_request(
    db: State<'_, LocalDb>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    registry: State<'_, Arc<CorrelationRegistry>>,
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
    session_id: Option<String>,
) -> Result<CorrelationResult, String> {
    let method = request.method.clone();
    let url = request.url.clone();
    let window_ms = crate::commands::settings::get_settings_impl(&db.pool)
        .await
        .map(|s| s.correlation_window_ms)
        .unwrap_or(DEFAULT_CORRELATION_WINDOW_MS);
    let result = run_correlated_request_impl_with_registry(
        request,
        connection,
        watched_tables,
        &logs,
        &emails,
        &registry,
        chrono::Utc::now().timestamp_millis(),
        window_ms,
    )
    .await?;
    save_correlation_history(&db.pool, &method, &url, &result.response, session_id.as_deref()).await;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::db::{connection_string, DbConnectInput};
    use sqlx::postgres::PgPoolOptions;
    use crate::correlation_state::{CorrelationRegistry, DEFAULT_CORRELATION_WINDOW_MS};
    use crate::log_state::LogState;

    fn snap(pk: &str, hash: &str) -> RowSnapshot {
        RowSnapshot { pk: pk.to_string(), hash: hash.to_string() }
    }

    #[test]
    fn detects_an_insert() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a"), snap("2", "b")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 1, updated: 0, deleted: 0 });
    }

    #[test]
    fn detects_an_update_even_though_row_count_is_unchanged() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a-changed")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 1, deleted: 0 });
    }

    #[test]
    fn detects_a_delete() {
        let before = vec![snap("1", "a"), snap("2", "b")];
        let after = vec![snap("1", "a")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 0, deleted: 1 });
    }

    #[test]
    fn reports_nothing_when_unchanged() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 0, deleted: 0 });
    }

    fn test_connection() -> DbConnectInput {
        DbConnectInput {
            host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
            port: 5432,
            database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            password: std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into()),
        }
    }

    #[tokio::test]
    async fn snapshot_and_diff_detects_a_real_update() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        sqlx::query("DROP TABLE IF EXISTS correlation_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE correlation_test (id serial PRIMARY KEY, status text)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO correlation_test (status) VALUES ('pending')")
            .execute(&pool).await.unwrap();

        let pk_col = get_primary_key_column(&pool, "correlation_test").await.unwrap();
        assert_eq!(pk_col, "id");

        let before = snapshot_table(&pool, "correlation_test", &pk_col).await.unwrap();
        sqlx::query("UPDATE correlation_test SET status = 'shipped' WHERE id = 1")
            .execute(&pool).await.unwrap();
        let after = snapshot_table(&pool, "correlation_test", &pk_col).await.unwrap();

        let diff = diff_table_snapshots("correlation_test", &before, &after);
        assert_eq!(diff, TableDiff { table: "correlation_test".into(), inserted: 0, updated: 1, deleted: 0 });

        sqlx::query("DROP TABLE correlation_test").execute(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_composite_primary_keys() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        sqlx::query("DROP TABLE IF EXISTS composite_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE composite_test (tenant_id int, item_id int, val text, PRIMARY KEY (tenant_id, item_id))")
            .execute(&pool).await.unwrap();

        let result = get_primary_key_column(&pool, "composite_test").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("composite primary key"));

        sqlx::query("DROP TABLE composite_test").execute(&pool).await.unwrap();
    }

    // NOTE: this deliberately does NOT insert the "side effect" row before calling
    // `run_correlated_request_impl` (as a naive transcription of this scenario might).
    // `run_correlated_request_impl` takes its "before" snapshot as the first thing it
    // does internally; a pre-seeded row would already be present in *both* the before
    // and after snapshots taken inside the function, so the diff would come out empty
    // and this test would pass or fail for the wrong reason (or not exercise the
    // orchestration at all). Instead, the INSERT is performed synchronously from
    // *inside* the mocked HTTP response callback, so it genuinely lands between the
    // impl's internal before-snapshot and after-snapshot — see comment below.
    #[tokio::test]
    async fn run_correlated_request_reports_only_tables_that_actually_changed() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        sqlx::query("DROP TABLE IF EXISTS orders_e2e").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS untouched_e2e").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE orders_e2e (id serial PRIMARY KEY, status text)")
            .execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE untouched_e2e (id serial PRIMARY KEY)")
            .execute(&pool).await.unwrap();

        let mut server = mockito::Server::new_async().await;
        let insert_conn_str = connection_string(&conn);
        let mock = server
            .mock("POST", "/orders")
            .with_status(201)
            // The mocked endpoint doesn't actually touch Postgres, so the "backend
            // side effect" is simulated here — but critically, it runs *while
            // mockito is producing the response body*, not before the request is
            // fired. `with_body_from_request` invokes this closure synchronously
            // at the moment mockito serves the response, which is strictly after
            // `run_correlated_request_impl`'s internal before-snapshot (already
            // taken before `fire_request_impl` is called) and strictly before its
            // after-snapshot (only taken once `fire_request_impl`'s `.await`
            // resolves, i.e. once this closure has returned a full body). That is
            // what actually proves the snapshot -> request -> snapshot sandwich
            // works, rather than merely observing pre-seeded data was still there.
            //
            // mockito 1.x serves every connection from its own dedicated
            // current-thread Tokio runtime running on a separate OS thread
            // (verified by reading mockito 1.7.2's `Server::try_new_with_opts_async`
            // in server.rs, which spins up `runtime::Builder::new_current_thread()`
            // on a `thread::spawn`'d thread regardless of the caller's own runtime
            // flavor). That means `tokio::task::block_in_place` cannot be used from
            // this closure: it panics with "can call blocking only when running on
            // the multi-threaded runtime" because it's mockito's *own* internal
            // runtime that's current here, not the multi-thread flavor of this
            // test's runtime, no matter what flavor this test itself uses.
            //
            // Spawning a plain OS thread with its own throwaway single-threaded
            // Tokio runtime (and its own fresh connection pool, to avoid driving
            // any resource from a runtime other than the one that created it) and
            // `.join()`-ing it is what actually works here: it performs a real,
            // deterministic async database write with no sleep or timing race.
            .with_body_from_request(move |_request| {
                let conn_str = insert_conn_str.clone();
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("failed to build throwaway runtime for synchronized insert");
                    rt.block_on(async {
                        let insert_pool = PgPoolOptions::new()
                            .max_connections(1)
                            .connect(&conn_str)
                            .await
                            .expect("insert thread requires a real local Postgres");
                        sqlx::query("INSERT INTO orders_e2e (status) VALUES ('pending')")
                            .execute(&insert_pool)
                            .await
                            .unwrap();
                    });
                })
                .join()
                .expect("insert thread panicked");
                br#"{"id":1}"#.to_vec()
            })
            .create_async()
            .await;

        let result = run_correlated_request_impl(
            FireRequestInput {
                method: "POST".to_string(),
                url: format!("{}/orders", server.url()),
                body: None,
            },
            conn,
            vec!["orders_e2e".to_string(), "untouched_e2e".to_string()],
            &crate::log_state::LogState::new(),
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(result.response.status_code, 201);
        let diffs = result.table_diffs.expect("diffs should be present");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].table, "orders_e2e");
        assert_eq!(diffs[0].inserted, 1);

        sqlx::query("DROP TABLE orders_e2e").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE untouched_e2e").execute(&pool).await.unwrap();
    }

    // --- Fix 2: snapshot_table SQL hardening ---

    #[tokio::test]
    async fn snapshot_table_rejects_a_malicious_table_name() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        let result = snapshot_table(&pool, "orders; DROP TABLE users; --", "id").await;
        assert!(result.is_err(), "should reject malicious table name before executing SQL");
    }

    #[tokio::test]
    async fn snapshot_table_rejects_a_malicious_pk_column() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        let result = snapshot_table(&pool, "orders", "id; DROP TABLE users; --").await;
        assert!(result.is_err(), "should reject malicious pk column name before executing SQL");
    }

    // Before this fix, snapshot_table's raw (unquoted) format! interpolation meant
    // an unquoted `MixedCaseTable` identifier would be folded to lowercase by
    // Postgres and resolve to `mixedcasetable` — which does NOT match a table that
    // was actually created quoted as "MixedCaseTable". That's not just an
    // injection risk, it's a guaranteed functional break on any legitimately
    // mixed-case (or reserved-word, or hyphenated) table name. This test proves
    // the double-quoting fix actually resolves the real, case-sensitive table.
    #[tokio::test]
    async fn snapshot_table_works_with_a_mixed_case_table_name_needing_quoting() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        sqlx::query("DROP TABLE IF EXISTS \"MixedCaseTable\"").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE \"MixedCaseTable\" (id serial PRIMARY KEY, val text)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO \"MixedCaseTable\" (val) VALUES ('x')").execute(&pool).await.unwrap();

        let snapshot = snapshot_table(&pool, "MixedCaseTable", "id").await.unwrap();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].pk, "1");

        sqlx::query("DROP TABLE \"MixedCaseTable\"").execute(&pool).await.unwrap();
    }

    // --- Fix 1: request history write-through ---

    #[tokio::test]
    async fn save_correlation_history_writes_a_row_list_history_can_read() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        save_correlation_history(
            &db.pool,
            "POST",
            "/orders",
            &FireRequestOutput { status_code: 201, body: "{\"id\":1}".to_string(), duration_ms: 42 },
            None,
        )
        .await;

        let entries = crate::commands::history::list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].method, "POST");
        assert_eq!(entries[0].url, "/orders");
        assert_eq!(entries[0].status_code, 201);
        assert_eq!(entries[0].response_body, "{\"id\":1}");
        assert_eq!(entries[0].duration_ms, 42);
    }

    // Mirrors exactly what the `run_correlated_request` tauri command body does
    // (minus unwrapping the `State<LocalDb>` itself, which requires a running
    // Tauri app and isn't constructible in a plain unit test): run a correlated
    // request end to end, then persist history from its result, then confirm
    // list_history can read it back. This is the regression test for the bug
    // where request history was never written at all — Tasks 6/7 were dead code
    // at runtime because nothing ever called save_history_entry.
    #[tokio::test]
    async fn full_correlated_request_flow_persists_a_history_entry() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let conn = test_connection();

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let url = format!("{}/ping", server.url());
        let request = FireRequestInput { method: "GET".to_string(), url: url.clone(), body: None };
        let method = request.method.clone();

        let result = run_correlated_request_impl(request, conn, vec![], &crate::log_state::LogState::new()).await.unwrap();
        save_correlation_history(&db.pool, &method, &url, &result.response, None).await;

        mock.assert_async().await;

        let entries = crate::commands::history::list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].method, "GET");
        assert_eq!(entries[0].url, url);
        assert_eq!(entries[0].status_code, 200);
        assert_eq!(entries[0].response_body, "pong");
    }

    #[tokio::test]
    async fn save_correlation_history_attributes_the_row_to_the_active_session() {
        use crate::commands::sessions::create_session_impl;

        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();

        save_correlation_history(
            &db.pool,
            "POST",
            "/orders",
            &FireRequestOutput { status_code: 201, body: "{}".to_string(), duration_ms: 42 },
            Some(&session.id),
        )
        .await;

        let scoped = crate::commands::history::list_history_impl(&db.pool, Some(&session.id))
            .await
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].url, "/orders");
        assert_eq!(scoped[0].session_id.as_deref(), Some(session.id.as_str()));
    }

    // Firing with no session selected is a supported, non-error path. The
    // row lands unattributed and shows only in the unscoped view.
    #[tokio::test]
    async fn a_request_fired_with_no_active_session_is_saved_unattributed() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        save_correlation_history(
            &db.pool,
            "GET",
            "/ping",
            &FireRequestOutput { status_code: 200, body: "pong".to_string(), duration_ms: 3 },
            None,
        )
        .await;

        let all = crate::commands::history::list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].session_id, None);
    }

    // A watched table that does not exist stands in for any mid-diff DB
    // failure (dropped connection, revoked permission, dropped table). The
    // request itself succeeded, so the user must still get their response and
    // an explicit "unable to verify" — never a silent, false "0 writes".
    #[tokio::test]
    async fn a_db_failure_still_returns_the_response_and_reports_unable_to_verify() {
        let conn = test_connection();

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl(
            FireRequestInput {
                method: "GET".to_string(),
                url: format!("{}/ping", server.url()),
                body: None,
            },
            conn,
            vec!["table_that_does_not_exist_anywhere".to_string()],
            &crate::log_state::LogState::new(),
        )
        .await
        .expect("a DB verification failure must not fail the whole command");

        mock.assert_async().await;
        assert_eq!(result.response.status_code, 200);
        assert_eq!(result.response.body, "pong");
        assert!(result.table_diffs.is_none(), "diffs must be absent, not empty");
        assert!(result.db_error.is_some());
    }

    #[tokio::test]
    async fn a_successful_diff_reports_an_empty_vec_not_a_null() {
        let conn = test_connection();
        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl(
            FireRequestInput { method: "GET".to_string(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &crate::log_state::LogState::new(),
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(result.table_diffs, Some(vec![]), "watching nothing is still a successful verification");
        assert_eq!(result.db_error, None);
    }

    #[tokio::test]
    async fn a_correlated_request_opens_a_window_that_can_be_collected() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = EmailState::new();
        let registry = CorrelationRegistry::new();

        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("app.log");
        std::fs::write(&log_path, "").unwrap();
        logs.add_source("app.log".into(), crate::log_state::SourceKind::File { path: log_path.clone() }).unwrap();
        logs.poll_all(1_000);

        let mut server = mockito::Server::new_async().await;
        let log_path_for_mock = log_path.clone();
        let mock = server
            .mock("POST", "/orders")
            .with_status(201)
            // Writing the log line from inside the mock's body callback puts it
            // strictly between the request being sent and the response landing,
            // which is what a real backend logging during a request looks like.
            .with_body_from_request(move |_req| {
                use std::io::Write as _;
                let mut f = std::fs::OpenOptions::new().append(true).open(&log_path_for_mock).unwrap();
                writeln!(f, r#"{{"level":"info","msg":"order created id=8841"}}"#).unwrap();
                f.flush().unwrap();
                br#"{"id":8841}"#.to_vec()
            })
            .create_async()
            .await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput {
                method: "POST".to_string(),
                url: format!("{}/orders", server.url()),
                body: None,
            },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
            DEFAULT_CORRELATION_WINDOW_MS,
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert!(!result.correlation_id.is_empty());

        // The tailer has not run since the write; drive it explicitly with a
        // capture time inside the window.
        logs.poll_all(10_100);

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
            result.correlation_id.clone(),
            10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
        )
        .await
        .unwrap();

        let lines = window.log_lines.expect("a source is running, so lines must be Some");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].message, "order created id=8841");
        assert_eq!(lines[0].level.as_deref(), Some("INFO"));
        assert!(!window.log_lines_truncated);
    }

    #[tokio::test]
    async fn collecting_a_window_with_no_log_source_reports_not_observed_rather_than_zero() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = EmailState::new();
        let registry = CorrelationRegistry::new();

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
            DEFAULT_CORRELATION_WINDOW_MS,
        )
        .await
        .unwrap();
        mock.assert_async().await;

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
            result.correlation_id,
            10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
        )
        .await
        .unwrap();

        assert_eq!(window.log_lines, None, "no source configured means NOT OBSERVED, not zero lines");
    }

    #[tokio::test]
    async fn collecting_an_unknown_correlation_id_is_an_error() {
        let logs = LogState::new();
        let emails = EmailState::new();
        let registry = CorrelationRegistry::new();
        let result =
            collect_correlation_window_impl(&registry, &logs, &emails, "not-a-real-id".into(), 1_000)
                .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn a_window_can_only_be_collected_once() {
        let logs = LogState::new();
        let emails = EmailState::new();
        let registry = CorrelationRegistry::new();
        let id = registry.open(0, 0, 500);

        assert!(collect_correlation_window_impl(&registry, &logs, &emails, id.clone(), 1_000).await.is_ok());
        assert!(collect_correlation_window_impl(&registry, &logs, &emails, id, 1_000).await.is_err());
        assert_eq!(registry.len(), 0);
    }

    use crate::email_state::EmailState;

    const TEST_EMAIL: &str = "Subject: Order confirmation #8841\r\n\r\nThanks for your order.\r\n";

    fn listening_email_state() -> EmailState {
        let state = EmailState::new();
        state.set_status(crate::email_state::SmtpStatus {
            listening: true,
            port: crate::email_state::DEFAULT_SMTP_PORT,
            error: None,
        });
        state
    }

    #[tokio::test]
    async fn a_correlation_window_captures_mail_sent_during_the_request() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = listening_email_state();
        let registry = CorrelationRegistry::new();

        let store_for_mock = emails.store();
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/orders")
            .with_status(201)
            // Pushing into the inbox from inside the mock's body callback puts
            // the capture strictly between the request being sent and the
            // response landing — the same shape as a real backend sending mail
            // mid-request, without needing a live SMTP round trip here (that
            // is covered end to end in Task 9).
            .with_body_from_request(move |_req| {
                store_for_mock
                    .lock()
                    .unwrap()
                    .push("orders@shop.test", &["customer@example.com".into()], TEST_EMAIL, 10_100);
                br#"{"id":8841}"#.to_vec()
            })
            .create_async()
            .await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput {
                method: "POST".to_string(),
                url: format!("{}/orders", server.url()),
                body: None,
            },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
            DEFAULT_CORRELATION_WINDOW_MS,
        )
        .await
        .unwrap();

        mock.assert_async().await;

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
            result.correlation_id,
            10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
        )
        .await
        .unwrap();

        let captured = window.emails.expect("the catcher is running, so emails must be Some");
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].subject, "Order confirmation #8841");
        assert_eq!(captured[0].to, vec!["customer@example.com".to_string()]);
        assert!(!window.emails_truncated);
    }

    // Regression test for the bug where the correlation window's end was
    // computed from `now_ms + window_ms` — i.e. from the instant the Tauri
    // command was *invoked*, not from the instant the response actually came
    // back. A request slower than `window_ms` would silently shrink (or
    // entirely consume) its own window before anything it caused had a
    // chance to be observed. This test uses REAL wall-clock time (not
    // synthetic integers) and a genuinely slow mocked backend (a real
    // `std::thread::sleep`) to prove the window's end tracks response time,
    // not request-start time.
    //
    // With the old code, the window would close at `started_at_ms + 100`
    // (`window_ms`), but the email is captured only after a real ~200ms
    // sleep, i.e. around `started_at_ms + 200` — well past that bound — so
    // the old code excludes it and this test fails against it. With the fix,
    // the window closes at `started_at_ms + elapsed_ms(~200) + 100`, which
    // comfortably includes an email captured at `started_at_ms + 200`.
    #[tokio::test]
    async fn a_slow_request_does_not_shrink_its_own_correlation_window() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = listening_email_state();
        let registry = CorrelationRegistry::new();

        const WINDOW_MS: i64 = 100;
        const SIMULATED_BACKEND_DELAY_MS: u64 = 200;

        let store_for_mock = emails.store();
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/orders")
            .with_status(201)
            // A real sleep here simulates a backend slow enough to outlast
            // `WINDOW_MS` on its own, then pushes the "side effect" email
            // once the delay elapses — capturing real wall-clock time at the
            // moment of the push, exactly like a real SMTP catcher would.
            .with_body_from_request(move |_req| {
                std::thread::sleep(std::time::Duration::from_millis(SIMULATED_BACKEND_DELAY_MS));
                let captured_at_ms = chrono::Utc::now().timestamp_millis();
                store_for_mock.lock().unwrap().push(
                    "orders@shop.test",
                    &["customer@example.com".into()],
                    TEST_EMAIL,
                    captured_at_ms,
                );
                br#"{"id":8841}"#.to_vec()
            })
            .create_async()
            .await;

        let started_at_ms = chrono::Utc::now().timestamp_millis();
        let result = run_correlated_request_impl_with_registry(
            FireRequestInput {
                method: "POST".to_string(),
                url: format!("{}/orders", server.url()),
                body: None,
            },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            started_at_ms,
            WINDOW_MS,
        )
        .await
        .unwrap();

        mock.assert_async().await;

        // Collect comfortably past the CORRECT window end so the internal
        // sleep in `collect_correlation_window_impl` is skipped entirely.
        let collect_at_ms = chrono::Utc::now().timestamp_millis() + 1_000;
        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
            result.correlation_id,
            collect_at_ms,
        )
        .await
        .unwrap();

        let captured = window.emails.expect("the catcher is running, so emails must be Some");
        assert_eq!(
            captured.len(),
            1,
            "a request that takes ~{SIMULATED_BACKEND_DELAY_MS}ms must not shrink its own \
             {WINDOW_MS}ms window relative to when the response actually came back"
        );
        assert_eq!(captured[0].subject, "Order confirmation #8841");
    }

    #[tokio::test]
    async fn mail_sent_before_the_request_is_not_attributed_to_it() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = listening_email_state();
        let registry = CorrelationRegistry::new();

        emails
            .store()
            .lock()
            .unwrap()
            .push("old@shop.test", &["someone@example.com".into()], TEST_EMAIL, 5_000);

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
            DEFAULT_CORRELATION_WINDOW_MS,
        )
        .await
        .unwrap();
        mock.assert_async().await;

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
            result.correlation_id,
            10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
        )
        .await
        .unwrap();

        assert_eq!(window.emails, Some(vec![]), "pre-existing mail must not be attributed to this request");
    }

    #[tokio::test]
    async fn a_stopped_catcher_reports_emails_as_not_observed_rather_than_zero() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = EmailState::new();
        emails.set_status(crate::email_state::SmtpStatus {
            listening: false,
            port: crate::email_state::DEFAULT_SMTP_PORT,
            error: Some("SMTP port 1025 is unavailable".to_string()),
        });
        let registry = CorrelationRegistry::new();

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
            DEFAULT_CORRELATION_WINDOW_MS,
        )
        .await
        .unwrap();
        mock.assert_async().await;

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
            result.correlation_id,
            10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
        )
        .await
        .unwrap();

        assert_eq!(window.emails, None, "a catcher that is not listening means NOT OBSERVED, not zero mail");
    }

    // NOTE: this test was originally written (per the plan) to open a window
    // with `window_ms = 30_000` and then assert `window.emails == Some(vec![])`
    // when collecting at `now_ms = 40_001`. That passes identically whether
    // `window_ms` is genuinely threaded through or the implementation
    // silently ignores it and hardcodes `DEFAULT_CORRELATION_WINDOW_MS`
    // (5_000) instead: 40_001 is past BOTH windows' ends (40_000 and 15_000),
    // so `remaining_ms` is negative either way and no blocking occurs; and
    // with no email ever pushed, `EmailStore::between`'s upper bound never
    // gets a chance to matter, so an empty result says nothing about which
    // window length was actually used. Rewritten below to push a message at a
    // timestamp that only one of the two candidate window ends would include.
    #[tokio::test]
    async fn the_window_length_comes_from_the_caller_not_a_hardcoded_constant() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = listening_email_state();
        let registry = CorrelationRegistry::new();

        let store_for_mock = emails.store();
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .with_status(200)
            // Captured at 25_000: strictly AFTER where a hardcoded 5s default
            // window opened at 10_000 would end (10_000 + 5_000 = 15_000),
            // but strictly BEFORE where the real 30s window this test passes
            // ends (10_000 + 30_000 = 40_000). Only a `window_ms` that was
            // genuinely threaded through as 30_000 — not silently replaced by
            // the 5s default — includes this message in the collected window.
            .with_body_from_request(move |_req| {
                store_for_mock.lock().unwrap().push(
                    "orders@shop.test",
                    &["customer@example.com".into()],
                    TEST_EMAIL,
                    25_000,
                );
                b"pong".to_vec()
            })
            .create_async()
            .await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
            30_000, // a 30s window, not the 5s default
        )
        .await
        .unwrap();
        mock.assert_async().await;

        // Collecting at 40_001 is past the REAL window's end (40_000), so no
        // sleep occurs here regardless of which window length was used —
        // the differentiator is entirely in whether the 25_000-timestamped
        // message below survives `EmailStore::between`'s upper bound.
        let window = collect_correlation_window_impl(&registry, &logs, &emails, result.correlation_id, 40_001)
            .await
            .unwrap();

        // If `window_ms` had silently fallen back to the 5s default, the
        // window would have closed at 15_000 and this message (captured at
        // 25_000) would be excluded, failing this assertion.
        let captured = window.emails.expect("the catcher is running, so emails must be Some");
        assert_eq!(captured.len(), 1, "a real 30s window must include mail captured at 25_000");
        assert_eq!(captured[0].subject, "Order confirmation #8841");
        assert_eq!(captured[0].to, vec!["customer@example.com".to_string()]);
    }
}
