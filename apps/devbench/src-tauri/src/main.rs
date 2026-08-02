#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devbench::commands;
use devbench::email_state::{EmailState, SmtpStatus, DEFAULT_SMTP_PORT};
use devbench::local_db::LocalDb;
use devbench::log_state::LogState;
use devbench::smtp_catcher;
use devbench::startup_state::{format_db_init_error, DbInitError, StartupStatus};
use std::sync::Arc;
use tauri::Manager;

/// How often each log source is checked for appended bytes. 250 ms is 20x
/// finer than the 5 s correlation window and costs one `metadata()` call per
/// source per tick when nothing has changed.
const LOG_POLL_INTERVAL_MS: u64 = 250;

/// How often unflushed log lines are batch-written to SQLite. Slower than
/// LOG_POLL_INTERVAL_MS on purpose — this is a durability sweep, not a
/// latency-sensitive one; Live mode reads the in-memory buffers directly.
const LOG_FLUSH_INTERVAL_MS: u64 = 1_000;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            // Every git worktree shares one Tauri app data dir (keyed by the app
            // identifier, not the checkout path), so their migrations collide in
            // one sqlite file. This override lets each worktree point at its own.
            // `#[cfg(debug_assertions)]`-gated: it's a dev-only escape hatch, so a
            // stale exported var can't silently split a release build's data
            // across two databases with nothing but an `eprintln!` nobody sees.
            #[cfg(debug_assertions)]
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
            #[cfg(not(debug_assertions))]
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let db_path = data_dir.join("devbench.db");
            let init_result: Result<(LocalDb, u16), String> = tauri::async_runtime::block_on(async move {
                let db = LocalDb::connect(data_dir).await?;
                let port = devbench::commands::settings::get_settings_impl(&db.pool)
                    .await
                    .map(|s| s.smtp_port)
                    .unwrap_or(DEFAULT_SMTP_PORT);
                Ok((db, port))
            });

            let logs = Arc::new(LogState::new());
            app.manage(Arc::clone(&logs));

            // On success this is what the SMTP catcher binds below; on
            // failure there's no pool to persist captured mail into, so the
            // catcher never starts and the frontend shows a blocking error
            // screen instead (via `StartupStatus`, always managed either way).
            // Log persistence lives in this arm for the same reason: with no
            // pool there is nothing to restore from, seed from, or flush to,
            // so capture degrades to in-memory-only rather than failing.
            let smtp_target = match init_result {
                Ok((db, smtp_port)) => {
                    let smtp_pool = db.pool.clone();

                    // Seeding MUST run before restore: restoring a command source
                    // respawns its process immediately, whose reader task can start
                    // assigning ids before the next line of code otherwise would.
                    tauri::async_runtime::block_on(async {
                        if let Err(e) = devbench::commands::logs::seed_log_id_counter(&db.pool, &logs).await {
                            eprintln!("failed to seed log line id counter: {e}");
                        }
                        devbench::commands::logs::restore_persisted_sources(&db.pool, &logs).await;
                    });

                    let db_pool_for_flush = db.pool.clone();
                    handle.manage(db);
                    handle.manage(StartupStatus { db_error: None });

                    let logs_for_flush = Arc::clone(&logs);
                    tauri::async_runtime::spawn(async move {
                        let mut ticker =
                            tokio::time::interval(std::time::Duration::from_millis(LOG_FLUSH_INTERVAL_MS));
                        loop {
                            ticker.tick().await;
                            if let Err(e) =
                                devbench::commands::logs::flush_new_lines(&db_pool_for_flush, &logs_for_flush).await
                            {
                                eprintln!("log flush failed: {e}");
                            }
                            if let Err(e) = devbench::commands::logs::prune_log_lines(&db_pool_for_flush).await {
                                eprintln!("log prune failed: {e}");
                            }
                        }
                    });

                    Some((smtp_pool, smtp_port))
                }
                Err(error) => {
                    eprintln!("{}", format_db_init_error(&db_path.display().to_string(), &error));
                    handle.manage(StartupStatus {
                        db_error: Some(DbInitError { db_path: db_path.display().to_string(), error }),
                    });
                    None
                }
            };

            // One background task polls every FILE source. Command sources
            // capture via their own reader tasks, started when they're
            // spawned (restore, above, or add_log_source later).
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
            if let Some((smtp_pool, smtp_port)) = smtp_target {
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
            }
            app.manage(emails);

            app.manage(Arc::new(devbench::secrets::KeyringSecretStore) as Arc<dyn devbench::secrets::SecretStore>);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::startup::get_startup_status,
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
        .build(tauri::generate_context!())
        .expect("error while building devbench")
        .run(|app_handle, event| {
            // Last chance to persist anything still sitting in the
            // in-memory buffers, and to kill any still-running command
            // sources, before the process actually exits — bounds
            // worst-case data loss to an unclean exit, not a normal quit,
            // and doesn't depend on exactly when kill_on_drop's Drop impl
            // would otherwise fire for a detached reader task.
            if let tauri::RunEvent::Exit = event {
                let logs = app_handle.state::<Arc<LogState>>();
                // `LocalDb` is only managed when init succeeded, so this must
                // not be `state()` — that panics on the DB-failure path, which
                // is exactly when the app is most likely to be quit.
                let db = app_handle.try_state::<LocalDb>();
                tauri::async_runtime::block_on(async {
                    if let Some(db) = db {
                        if let Err(e) = devbench::commands::logs::flush_new_lines(&db.pool, &logs).await {
                            eprintln!("final log flush on shutdown failed: {e}");
                        }
                    }
                    logs.kill_all_commands().await;
                });
            }
        });
}
