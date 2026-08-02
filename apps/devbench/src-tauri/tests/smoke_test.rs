use devbench::commands::correlation::run_correlated_request_impl;
use devbench::commands::request::FireRequestInput;
use devbench::connection_registry::postgres_connection_string;
use devbench::email_state::EmailState;
use devbench::local_db::LocalDb;
use devbench::log_state::LogState;
use sqlx::postgres::PgPoolOptions;

fn test_connection_string() -> String {
    let host = std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into());
    let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into());
    let username = std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into());
    let password = std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into());
    postgres_connection_string(&host, 5432, &database, &username, Some(&password), "disable")
}

async fn test_pool() -> sqlx::PgPool {
    PgPoolOptions::new()
        .connect(&test_connection_string())
        .await
        .expect("requires a real local Postgres — see CONTRIBUTING for setup")
}

// Correlation now reads captured mail from SQLite, so this file needs a
// local pool too.
async fn local_db() -> (tempfile::TempDir, LocalDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
    (dir, db)
}

// Deliberately does NOT insert the "side effect" row before calling
// `run_correlated_request_impl`: it takes its "before" snapshot as the first
// thing it does internally, so a pre-seeded row would already be in both
// snapshots and the diff would come out empty regardless of whether the
// orchestration works. See `src/commands/correlation.rs`'s
// `run_correlated_request_reports_only_tables_that_actually_changed` for the
// canonical explanation of the mock-callback timing this relies on. The
// insert instead happens inside the mocked HTTP response callback below.
#[tokio::test]
async fn firing_a_request_against_a_seeded_postgres_produces_the_expected_rollup() {
    let pool = test_pool().await;

    sqlx::query("DROP TABLE IF EXISTS smoke_orders")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE smoke_orders (id serial PRIMARY KEY, status text)")
        .execute(&pool)
        .await
        .unwrap();

    let mut server = mockito::Server::new_async().await;
    let insert_conn_str = test_connection_string();
    let mock = server
        .mock("POST", "/orders")
        .with_status(201)
        // The mocked endpoint doesn't actually touch Postgres; the insert is
        // simulated by running it synchronously from inside this callback, so
        // it lands strictly between `run_correlated_request_impl`'s internal
        // before- and after-snapshot. See `src/commands/correlation.rs`'s
        // canonical comment on
        // `run_correlated_request_reports_only_tables_that_actually_changed`
        // for why this needs a throwaway OS thread + runtime rather than
        // `block_on`/`block_in_place`.
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
                    sqlx::query("INSERT INTO smoke_orders (status) VALUES ('pending')")
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
        Some(pool.clone()),
        vec!["smoke_orders".to_string()],
        &LogState::new(),
    )
    .await
    .expect("correlated request should succeed");

    mock.assert_async().await;
    assert_eq!(result.response.status_code, 201);
    let diffs = result.table_diffs.expect("table_diffs should be present");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].table, "smoke_orders");
    assert_eq!(diffs[0].inserted, 1);

    sqlx::query("DROP TABLE smoke_orders")
        .execute(&pool)
        .await
        .unwrap();
}

use devbench::commands::correlation::{
    collect_correlation_window_impl, run_correlated_request_impl_with_registry,
};
use devbench::correlation_state::{CorrelationRegistry, DEFAULT_CORRELATION_WINDOW_MS};

#[tokio::test]
async fn firing_a_request_correlates_both_db_writes_and_log_lines() {
    let pool = test_pool().await;

    sqlx::query("DROP TABLE IF EXISTS smoke_log_orders").execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE smoke_log_orders (id serial PRIMARY KEY, status text)")
        .execute(&pool)
        .await
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("backend.log");
    std::fs::write(&log_path, "").unwrap();

    let logs = LogState::new();
    logs.add_source("backend.log".into(), log_path.clone()).unwrap();
    logs.poll_all(1_000);

    let emails = EmailState::new();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = local_db().await;

    // The mocked backend does both things a real one would during the request:
    // writes a row and writes a log line.
    let mut server = mockito::Server::new_async().await;
    let insert_conn = test_connection_string();
    let log_for_mock = log_path.clone();
    let mock = server
        .mock("POST", "/orders")
        .with_status(201)
        .with_body_from_request(move |_req| {
            let conn_str = insert_conn.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                rt.block_on(async {
                    let p = PgPoolOptions::new().max_connections(1).connect(&conn_str).await.unwrap();
                    sqlx::query("INSERT INTO smoke_log_orders (status) VALUES ('pending')")
                        .execute(&p)
                        .await
                        .unwrap();
                });
            })
            .join()
            .unwrap();

            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new().append(true).open(&log_for_mock).unwrap();
            writeln!(f, r#"{{"level":"info","msg":"order created id=1"}}"#).unwrap();
            writeln!(f, r#"{{"level":"warn","msg":"inventory low"}}"#).unwrap();
            f.flush().unwrap();

            br#"{"id":1}"#.to_vec()
        })
        .create_async()
        .await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/orders", server.url()),
            body: None,
        },
        Some(pool.clone()),
        vec!["smoke_log_orders".to_string()],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        50_000,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .expect("correlated request should succeed");

    mock.assert_async().await;

    let diffs = result.table_diffs.expect("DB should have been verified");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].table, "smoke_log_orders");
    assert_eq!(diffs[0].inserted, 1);
    assert_eq!(result.db_error, None);

    logs.poll_all(50_100);

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        None,
        50_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    let lines = window.log_lines.expect("a source is configured, so lines must be Some");
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].level.as_deref(), Some("INFO"));
    assert_eq!(lines[1].level.as_deref(), Some("WARN"));

    sqlx::query("DROP TABLE smoke_log_orders").execute(&pool).await.unwrap();
}

use devbench::email_state::SmtpStatus;
use devbench::smtp_catcher;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;

/// Reads SMTP reply lines until one has a space after the code.
fn read_smtp_reply(reader: &mut BufReader<TcpStream>) -> String {
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 {
            return String::new();
        }
        if line.len() >= 4 && line.as_bytes()[3] == b' ' {
            return line;
        }
    }
}

/// Sends one message through a real SMTP conversation, exactly as a target
/// backend's mailer would.
fn send_test_mail(port: u16, subject: &str) {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);

    assert!(read_smtp_reply(&mut reader).starts_with("220"));
    write!(writer, "EHLO backend\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "MAIL FROM:<orders@shop.test>\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "RCPT TO:<customer@example.com>\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "DATA\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "Subject: {subject}\r\n\r\nThanks for your order.\r\n.\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "QUIT\r\n").unwrap();
    read_smtp_reply(&mut reader);
}

#[tokio::test]
async fn firing_a_request_correlates_db_writes_log_lines_and_sent_mail() {
    let pool = test_pool().await;

    sqlx::query("DROP TABLE IF EXISTS smoke_full_orders").execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE smoke_full_orders (id serial PRIMARY KEY, status text)")
        .execute(&pool)
        .await
        .unwrap();

    // --- log source ---
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("backend.log");
    std::fs::write(&log_path, "").unwrap();
    let logs = LogState::new();
    logs.add_source("backend.log".into(), log_path.clone()).unwrap();
    logs.poll_all(1_000);

    // --- SMTP catcher on an OS-assigned port, so the test never collides
    //     with a real Mailhog on 1025 ---
    let emails = EmailState::new();
    let (_edb_dir, edb) = local_db().await;
    let listener = smtp_catcher::bind(0).unwrap();
    let smtp_port = listener.local_addr().unwrap().port();
    let catcher_pool = edb.pool.clone();
    std::thread::spawn(move || {
        let _ = smtp_catcher::serve(listener, catcher_pool);
    });
    emails.set_status(SmtpStatus { listening: true, port: smtp_port, error: None });

    let registry = CorrelationRegistry::new();

    // The mocked backend does all three things a real one would during the
    // request: writes a row, writes a log line, and sends mail.
    let mut server = mockito::Server::new_async().await;
    let insert_conn = test_connection_string();
    let log_for_mock = log_path.clone();
    let mock = server
        .mock("POST", "/orders")
        .with_status(201)
        .with_body_from_request(move |_req| {
            let conn_str = insert_conn.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                rt.block_on(async {
                    let p = PgPoolOptions::new().max_connections(1).connect(&conn_str).await.unwrap();
                    sqlx::query("INSERT INTO smoke_full_orders (status) VALUES ('pending')")
                        .execute(&p)
                        .await
                        .unwrap();
                });
            })
            .join()
            .unwrap();

            let mut f = std::fs::OpenOptions::new().append(true).open(&log_for_mock).unwrap();
            writeln!(f, r#"{{"level":"info","msg":"order created id=1"}}"#).unwrap();
            f.flush().unwrap();

            send_test_mail(smtp_port, "Order confirmation #8841");

            br#"{"id":1}"#.to_vec()
        })
        .create_async()
        .await;

    // Real wall-clock "now", captured once so the window's cursors and
    // `window_ends_at_ms` are all derived from the same instant. The SMTP
    // catcher timestamps captured mail with `chrono::Utc::now()` (a real
    // epoch-millis value, ~1.7+ trillion) rather than a synthetic small
    // integer, so the window bound must be drawn from the same real clock or
    // `between_captured_emails`'s upper-bound check would reject every real
    // capture.
    let started_at_ms = chrono::Utc::now().timestamp_millis();

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/orders", server.url()),
            body: None,
        },
        Some(pool.clone()),
        vec!["smoke_full_orders".to_string()],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        started_at_ms,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .expect("correlated request should succeed");

    mock.assert_async().await;

    // --- DB ---
    let diffs = result.table_diffs.expect("DB should have been verified");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].table, "smoke_full_orders");
    assert_eq!(diffs[0].inserted, 1);

    // The tailer and the SMTP handler both run outside this task; drive the
    // tailer explicitly and give the catcher thread a moment to finish DATA.
    for _ in 0..100 {
        logs.poll_all(chrono::Utc::now().timestamp_millis());
        if devbench::email_state::list_captured_emails(&edb.pool, None, 10).await.unwrap().emails.len() == 1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        None,
        chrono::Utc::now().timestamp_millis() + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    // --- Log ---
    let lines = window.log_lines.expect("a source is configured, so lines must be Some");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].message, "order created id=1");

    // --- Email ---
    let captured = window.emails.expect("the catcher is listening, so emails must be Some");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].subject, "Order confirmation #8841");
    assert_eq!(captured[0].from, "orders@shop.test");
    assert_eq!(captured[0].to, vec!["customer@example.com".to_string()]);

    sqlx::query("DROP TABLE smoke_full_orders").execute(&pool).await.unwrap();
}

use devbench::commands::history::{save_history_entry_impl, HistoryEntryInput};
use devbench::commands::sessions::create_session_impl;
use devbench::commands::settings::set_setting_impl;
use devbench::email_state::{get_captured_email, list_captured_emails};

async fn wait_for_captured_count(pool: &sqlx::SqlitePool, want: usize) {
    for _ in 0..100 {
        if list_captured_emails(pool, None, 10).await.unwrap().emails.len() >= want {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("timed out waiting for {want} captured email(s)");
}

// Proves captured mail persists on disk, not just in the live pool's cache —
// only a fresh `LocalDb::connect` against the same directory can show that.
#[tokio::test]
async fn captured_mail_survives_dropping_and_reconnecting_the_local_db() {
    let dir = tempfile::tempdir().unwrap();
    let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

    let listener = smtp_catcher::bind(0).unwrap();
    let smtp_port = listener.local_addr().unwrap().port();
    let catcher_pool = db.pool.clone();
    std::thread::spawn(move || {
        let _ = smtp_catcher::serve(listener, catcher_pool);
    });

    send_test_mail(smtp_port, "Receipt #4471");
    wait_for_captured_count(&db.pool, 1).await;

    let dir_path = dir.path().to_path_buf();
    drop(db);

    let reconnected = LocalDb::connect(dir_path).await.unwrap();
    let after = list_captured_emails(&reconnected.pool, None, 10).await.unwrap();
    assert_eq!(after.emails.len(), 1);
    assert_eq!(after.emails[0].subject, "Receipt #4471");
    assert_eq!(after.emails[0].from, "orders@shop.test");
    assert_eq!(after.emails[0].to, vec!["customer@example.com".to_string()]);

    let full = get_captured_email(&reconnected.pool, after.emails[0].id).await.unwrap().unwrap();
    assert!(full.raw.contains("Receipt #4471"));
}

#[tokio::test]
async fn mail_captured_through_the_real_catcher_is_scoped_to_the_active_session() {
    let (_edb_dir, edb) = local_db().await;

    let listener = smtp_catcher::bind(0).unwrap();
    let smtp_port = listener.local_addr().unwrap().port();
    let catcher_pool = edb.pool.clone();
    std::thread::spawn(move || {
        let _ = smtp_catcher::serve(listener, catcher_pool);
    });

    let session_a = create_session_impl(&edb.pool, "Order flow", None).await.unwrap();
    let session_b = create_session_impl(&edb.pool, "Checkout", None).await.unwrap();

    set_setting_impl(&edb.pool, "active_session_id", &session_a.id).await.unwrap();
    send_test_mail(smtp_port, "Order flow receipt");
    wait_for_captured_count(&edb.pool, 1).await;

    set_setting_impl(&edb.pool, "active_session_id", &session_b.id).await.unwrap();
    send_test_mail(smtp_port, "Checkout receipt");
    wait_for_captured_count(&edb.pool, 2).await;

    let in_a = list_captured_emails(&edb.pool, Some(&session_a.id), 10).await.unwrap();
    assert_eq!(in_a.emails.len(), 1);
    assert_eq!(in_a.emails[0].subject, "Order flow receipt");

    let in_b = list_captured_emails(&edb.pool, Some(&session_b.id), 10).await.unwrap();
    assert_eq!(in_b.emails.len(), 1);
    assert_eq!(in_b.emails[0].subject, "Checkout receipt");
}

// With `watched_tables` empty, `table_diffs`/`db_error` are never touched
// either way, so unlike this file's other tests, this one does not actually
// need a reachable Postgres to pass — `None` is passed for the pool.
#[tokio::test]
async fn a_correlated_requests_captured_mail_is_linked_to_the_request_end_to_end() {
    let emails = EmailState::new();
    let (_edb_dir, edb) = local_db().await;
    let listener = smtp_catcher::bind(0).unwrap();
    let smtp_port = listener.local_addr().unwrap().port();
    let catcher_pool = edb.pool.clone();
    std::thread::spawn(move || {
        let _ = smtp_catcher::serve(listener, catcher_pool);
    });
    emails.set_status(SmtpStatus { listening: true, port: smtp_port, error: None });

    let registry = CorrelationRegistry::new();
    let logs = LogState::new();

    // `send_test_mail` is plain blocking `std::net` I/O, not tokio, so unlike
    // the DB-writing mocks elsewhere in this file it can run directly inside
    // mockito's callback with no OS-thread bridge needed.
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/checkout")
        .with_status(201)
        .with_body_from_request(move |_req| {
            send_test_mail(smtp_port, "Checkout receipt #9001");
            br#"{"id":9001}"#.to_vec()
        })
        .create_async()
        .await;

    let started_at_ms = chrono::Utc::now().timestamp_millis();
    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "POST".to_string(), url: format!("{}/checkout", server.url()), body: None },
        None,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        started_at_ms,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .expect("correlated request should succeed");
    mock.assert_async().await;

    let history_id = save_history_entry_impl(
        &edb.pool,
        HistoryEntryInput {
            method: "POST".to_string(),
            url: "/checkout".to_string(),
            status_code: result.response.status_code,
            response_body: result.response.body.clone(),
            duration_ms: result.response.duration_ms,
            session_id: None,
        },
    )
    .await
    .expect("history save should succeed");

    wait_for_captured_count(&edb.pool, 1).await;

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        Some(history_id.as_str()),
        chrono::Utc::now().timestamp_millis() + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    let captured = window.emails.expect("the catcher is listening, so emails must be Some");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].subject, "Checkout receipt #9001");

    let linked = get_captured_email(&edb.pool, captured[0].id).await.unwrap().unwrap();
    assert_eq!(linked.request_id.as_deref(), Some(history_id.as_str()));
    assert_eq!(linked.request_method.as_deref(), Some("POST"));
    assert_eq!(linked.request_url.as_deref(), Some("/checkout"));
}
