#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devbench::commands;
use devbench::local_db::LocalDb;
use devbench::log_state::LogState;
use std::sync::Arc;
use tauri::Manager;

/// How often each log source is checked for appended bytes. 250 ms is 20x
/// finer than the 5 s correlation window and costs one `metadata()` call per
/// source per tick when nothing has changed.
const LOG_POLL_INTERVAL_MS: u64 = 250;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            tauri::async_runtime::block_on(async move {
                let db = LocalDb::connect(data_dir)
                    .await
                    .expect("failed to initialize local database");
                handle.manage(db);
            });

            let logs = Arc::new(LogState::new());
            app.manage(Arc::clone(&logs));

            // One background task polls every source. It outlives every
            // request; correlation windows read from the buffer it fills,
            // which is why no lines are lost between the two correlation calls.
            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_millis(LOG_POLL_INTERVAL_MS));
                loop {
                    ticker.tick().await;
                    let now_ms = chrono::Utc::now().timestamp_millis();
                    logs.poll_all(now_ms);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db::db_connect_and_list_tables,
            commands::db::list_table_rows,
            commands::request::fire_request,
            commands::history::save_history_entry,
            commands::history::list_history,
            commands::correlation::run_correlated_request,
            commands::logs::add_log_source,
            commands::logs::remove_log_source,
            commands::logs::list_log_sources,
            commands::logs::read_log_lines,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devbench");
}
