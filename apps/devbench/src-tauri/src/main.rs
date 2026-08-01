#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devbench::commands;
use devbench::email_state::{EmailState, SmtpStatus, DEFAULT_SMTP_PORT};
use devbench::local_db::LocalDb;
use devbench::log_state::LogState;
use devbench::smtp_catcher;
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
            // Every git worktree shares one Tauri app data dir (keyed by the app
            // identifier, not the checkout path), so their migrations collide in
            // one sqlite file. This override lets each worktree point at its own.
            let data_dir = match std::env::var("DEVBENCH_DATA_DIR") {
                Ok(dir) if !dir.is_empty() => {
                    eprintln!("DEVBENCH_DATA_DIR override active: using {dir}");
                    std::path::PathBuf::from(dir)
                }
                _ => app
                    .path()
                    .app_data_dir()
                    .expect("failed to resolve app data dir"),
            };
            let (db, smtp_port) = tauri::async_runtime::block_on(async move {
                let db = LocalDb::connect(data_dir)
                    .await
                    .expect("failed to initialize local database");
                let port = devbench::commands::settings::get_settings_impl(&db.pool)
                    .await
                    .map(|s| s.smtp_port)
                    .unwrap_or(DEFAULT_SMTP_PORT);
                (db, port)
            });
            let smtp_pool = db.pool.clone();
            handle.manage(db);

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

            app.manage(Arc::new(devbench::correlation_state::CorrelationRegistry::new()));

            let emails = Arc::new(EmailState::new());
            // Bind BEFORE spawning: `serve()` blocks forever and can only
            // report a bind failure by returning, so a port conflict would
            // otherwise be invisible. Binding here turns it into a status the
            // Email tab can show — and deliberately does NOT abort startup,
            // because an app that refuses to launch cannot offer the "change
            // the port in Settings" shortcut the spec asks for.
            match smtp_catcher::bind(smtp_port) {
                Ok(listener) => {
                    emails.set_status(SmtpStatus {
                        listening: true,
                        port: smtp_port,
                        error: None,
                    });
                    let emails_for_thread = Arc::clone(&emails);
                    // A dedicated OS thread, not a tokio task: mailin-embedded
                    // is blocking and runs its own scoped threadpool.
                    std::thread::spawn(move || {
                        if let Err(e) = smtp_catcher::serve(listener, smtp_pool) {
                            emails_for_thread.set_status(SmtpStatus {
                                listening: false,
                                port: smtp_port,
                                error: Some(e),
                            });
                        }
                    });
                }
                Err(e) => {
                    eprintln!("SMTP catcher did not start: {e}");
                    emails.set_status(SmtpStatus {
                        listening: false,
                        port: smtp_port,
                        error: Some(e),
                    });
                }
            }
            app.manage(emails);

            app.manage(Arc::new(devbench::secrets::KeyringSecretStore) as Arc<dyn devbench::secrets::SecretStore>);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db::db_connect_and_list_tables,
            commands::db::list_table_rows,
            commands::request::fire_request,
            commands::history::save_history_entry,
            commands::history::list_history,
            commands::correlation::run_correlated_request,
            commands::correlation::collect_correlation_window,
            commands::logs::add_log_source,
            commands::logs::remove_log_source,
            commands::logs::list_log_sources,
            commands::logs::read_log_lines,
            commands::email::list_emails,
            commands::email::get_email,
            commands::email::clear_emails,
            commands::email::smtp_status,
            commands::sessions::create_session,
            commands::sessions::list_sessions,
            commands::sessions::list_archived_sessions,
            commands::sessions::rename_session,
            commands::sessions::archive_session,
            commands::sessions::restore_session,
            commands::sessions::delete_session,
            commands::tabs::list_tabs,
            commands::tabs::create_tab,
            commands::tabs::close_tab,
            commands::tabs::set_tab_state,
            commands::tabs::move_tab,
            commands::watched::list_watched_tables,
            commands::watched::set_watched_table,
            commands::settings::get_settings,
            commands::settings::set_setting,
            commands::provider::get_provider_status,
            commands::provider::set_provider_api_key,
            commands::provider::clear_provider_api_key,
            commands::mcp::list_mcp_servers,
            commands::mcp::add_mcp_server,
            commands::mcp::remove_mcp_server,
            commands::mcp::check_mcp_server,
            commands::chat::send_chat_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devbench");
}
