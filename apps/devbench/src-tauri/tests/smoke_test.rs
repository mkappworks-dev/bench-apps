use devbench::commands::correlation::run_correlated_request_impl;
use devbench::commands::db::{connection_string, DbConnectInput};
use devbench::commands::request::FireRequestInput;
use devbench::log_state::LogState;
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
