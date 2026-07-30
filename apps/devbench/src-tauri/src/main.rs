#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devbench::commands;
use devbench::local_db::LocalDb;
use tauri::Manager;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db::db_connect_and_list_tables,
            commands::db::list_table_rows,
            commands::request::fire_request,
            commands::history::save_history_entry,
            commands::history::list_history,
            commands::correlation::run_correlated_request,
            commands::sessions::create_session,
            commands::sessions::list_sessions,
            commands::sessions::list_archived_sessions,
            commands::sessions::rename_session,
            commands::sessions::archive_session,
            commands::sessions::restore_session,
            commands::sessions::delete_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devbench");
}
