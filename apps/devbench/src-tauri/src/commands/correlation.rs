use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Pool, Postgres, Row};
use std::collections::HashMap;

use super::db::{connection_string, DbConnectInput};
use super::request::{fire_request_impl, FireRequestInput, FireRequestOutput};

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
    let sql = format!("SELECT {pk_col}::text as pk, md5(t::text) as hash FROM {table} t");
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
    pub response: FireRequestOutput,
    pub table_diffs: Vec<TableDiff>,
}

pub async fn run_correlated_request_impl(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
) -> Result<CorrelationResult, String> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(&connection))
        .await
        .map_err(|e| format!("connection failed: {e}"))?;

    let mut before_snapshots = Vec::with_capacity(watched_tables.len());
    for table in &watched_tables {
        let pk_col = get_primary_key_column(&pool, table).await?;
        let snapshot = snapshot_table(&pool, table, &pk_col).await?;
        before_snapshots.push((table.clone(), pk_col, snapshot));
    }

    let response = fire_request_impl(request).await?;

    let mut table_diffs = Vec::with_capacity(watched_tables.len());
    for (table, pk_col, before) in before_snapshots {
        let after = snapshot_table(&pool, &table, &pk_col).await?;
        let diff = diff_table_snapshots(&table, &before, &after);
        if diff.inserted > 0 || diff.updated > 0 || diff.deleted > 0 {
            table_diffs.push(diff);
        }
    }

    Ok(CorrelationResult { response, table_diffs })
}

#[tauri::command]
pub async fn run_correlated_request(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
) -> Result<CorrelationResult, String> {
    run_correlated_request_impl(request, connection, watched_tables).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::db::{connection_string, DbConnectInput};
    use sqlx::postgres::PgPoolOptions;

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
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(result.response.status_code, 201);
        assert_eq!(result.table_diffs.len(), 1);
        assert_eq!(result.table_diffs[0].table, "orders_e2e");
        assert_eq!(result.table_diffs[0].inserted, 1);

        sqlx::query("DROP TABLE orders_e2e").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE untouched_e2e").execute(&pool).await.unwrap();
    }
}
