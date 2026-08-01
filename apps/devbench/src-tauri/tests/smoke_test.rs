use devbench::commands::correlation::run_correlated_request_impl;
use devbench::commands::db::{connection_string, DbConnectInput};
use devbench::commands::request::FireRequestInput;
use devbench::email_state::EmailState;
use devbench::log_state::{LogState, SourceKind};
use sqlx::postgres::PgPoolOptions;

fn test_connection() -> DbConnectInput {
    DbConnectInput {
        host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
        port: 5432,
        database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
        username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
        password: std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into()),
    }
}

// NOTE: this deliberately does NOT insert the "side effect" row before calling
// `run_correlated_request_impl` (as a naive transcription of the plan's brief
// would). `run_correlated_request_impl` takes its "before" snapshot as the
// first thing it does internally; a pre-seeded row would already be present
// in *both* the before and after snapshots taken inside the function, so the
// diff would come out empty and this test would pass or fail for the wrong
// reason (or not exercise the orchestration at all) — this is the exact
// pitfall Task 10's `run_correlated_request_reports_only_tables_that_actually_changed`
// test hit and solved; see `src/commands/correlation.rs` for the original
// writeup. This test reuses that same fix: the INSERT is performed
// synchronously from *inside* the mocked HTTP response callback, so it
// genuinely lands between the impl's internal before-snapshot and
// after-snapshot — see comment below.
#[tokio::test]
async fn firing_a_request_against_a_seeded_postgres_produces_the_expected_rollup() {
    let conn = test_connection();
    let pool = PgPoolOptions::new()
        .connect(&connection_string(&conn))
        .await
        .expect("requires a real local Postgres");

    sqlx::query("DROP TABLE IF EXISTS smoke_orders")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE smoke_orders (id serial PRIMARY KEY, status text)")
        .execute(&pool)
        .await
        .unwrap();

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
        // current-thread Tokio runtime running on a separate OS thread, so
        // `tokio::task::block_in_place` cannot be used from this closure (it
        // panics unless the *caller's* runtime is multi-threaded, and here
        // it's mockito's own internal runtime that's current, regardless of
        // this test's runtime flavor). Spawning a plain OS thread with its
        // own throwaway single-threaded Tokio runtime (and its own fresh
        // connection pool, to avoid driving any resource from a runtime
        // other than the one that created it) and `.join()`-ing it is what
        // actually works here: it performs a real, deterministic async
        // database write with no sleep or timing race. See
        // `src/commands/correlation.rs`'s
        // `run_correlated_request_reports_only_tables_that_actually_changed`
        // test for the original derivation of this pattern.
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
        conn,
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
    let conn = test_connection();
    let pool = PgPoolOptions::new()
        .connect(&format!(
            "postgres://{}:{}@{}:{}/{}",
            conn.username, conn.password, conn.host, conn.port, conn.database
        ))
        .await
        .expect("requires a real local Postgres");

    sqlx::query("DROP TABLE IF EXISTS smoke_log_orders").execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE smoke_log_orders (id serial PRIMARY KEY, status text)")
        .execute(&pool)
        .await
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("backend.log");
    std::fs::write(&log_path, "").unwrap();

    let logs = LogState::new();
    logs.add_source("backend.log".into(), SourceKind::File { path: log_path.clone() }).unwrap();
    logs.poll_all(1_000);

    let emails = EmailState::new();
    let registry = CorrelationRegistry::new();

    // The mocked backend does both things a real one would during the request:
    // writes a row and writes a log line.
    let mut server = mockito::Server::new_async().await;
    let insert_conn = format!(
        "postgres://{}:{}@{}:{}/{}",
        conn.username, conn.password, conn.host, conn.port, conn.database
    );
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
        conn,
        vec!["smoke_log_orders".to_string()],
        &logs,
        &emails,
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
        result.correlation_id,
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
    let conn = test_connection();
    let pool = PgPoolOptions::new()
        .connect(&format!(
            "postgres://{}:{}@{}:{}/{}",
            conn.username, conn.password, conn.host, conn.port, conn.database
        ))
        .await
        .expect("requires a real local Postgres");

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
    logs.add_source("backend.log".into(), SourceKind::File { path: log_path.clone() }).unwrap();
    logs.poll_all(1_000);

    // --- SMTP catcher on an OS-assigned port, so the test never collides
    //     with a real Mailhog on 1025 ---
    let emails = EmailState::new();
    let listener = smtp_catcher::bind(0).unwrap();
    let smtp_port = listener.local_addr().unwrap().port();
    let store = emails.store();
    std::thread::spawn(move || {
        let _ = smtp_catcher::serve(listener, store);
    });
    emails.set_status(SmtpStatus { listening: true, port: smtp_port, error: None });

    let registry = CorrelationRegistry::new();

    // The mocked backend does all three things a real one would during the
    // request: writes a row, writes a log line, and sends mail.
    let mut server = mockito::Server::new_async().await;
    let insert_conn = format!(
        "postgres://{}:{}@{}:{}/{}",
        conn.username, conn.password, conn.host, conn.port, conn.database
    );
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
    // `EmailStore::between`'s upper-bound check would reject every real
    // capture.
    let started_at_ms = chrono::Utc::now().timestamp_millis();

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/orders", server.url()),
            body: None,
        },
        conn,
        vec!["smoke_full_orders".to_string()],
        &logs,
        &emails,
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
        if emails.store().lock().unwrap().list(10).len() == 1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        result.correlation_id,
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
