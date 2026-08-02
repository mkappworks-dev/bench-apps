use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::local_db::LocalDb;
use crate::log_state::{LogPage, LogSourceStatus, LogState};

/// Upper bound on how many lines one `read_log_lines` call returns. Keeps a
/// single IPC payload bounded even if the frontend asks for everything.
const MAX_READ_LIMIT: usize = 2_000;

#[derive(Debug, Deserialize)]
pub struct AddLogSourceInput {
    pub label: String,
    /// Required for kind = "file" (the default). The current frontend has
    /// no concept of `kind` and always sends this shape — `#[serde(default)]`
    /// on `kind` below means an old-shaped `{label, path}` payload still
    /// deserializes exactly as it did before this change.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default = "default_source_kind")]
    pub kind: String,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

fn default_source_kind() -> String {
    "file".to_string()
}

pub fn parse_source_kind(input: &AddLogSourceInput) -> Result<crate::log_state::SourceKind, String> {
    match input.kind.as_str() {
        "file" => {
            let path = input.path.as_deref().ok_or_else(|| "path is required for a file source".to_string())?;
            Ok(crate::log_state::SourceKind::File { path: PathBuf::from(path) })
        }
        "command" => {
            let program = input.program.clone().ok_or_else(|| "program is required for a command source".to_string())?;
            Ok(crate::log_state::SourceKind::Command {
                program,
                args: input.args.clone(),
                cwd: input.cwd.clone().map(PathBuf::from),
            })
        }
        other => Err(format!("unknown log source kind: {other}")),
    }
}

pub async fn persist_log_source(
    pool: &SqlitePool,
    status: &crate::log_state::LogSourceStatus,
    kind: &crate::log_state::SourceKind,
) -> Result<(), String> {
    let (kind_str, path, program, args, cwd): (&str, Option<String>, Option<String>, Option<String>, Option<String>) = match kind {
        crate::log_state::SourceKind::File { path } => ("file", Some(path.display().to_string()), None, None, None),
        crate::log_state::SourceKind::Command { program, args, cwd } => (
            "command",
            None,
            Some(program.clone()),
            Some(serde_json::to_string(args).map_err(|e| format!("failed to encode args: {e}"))?),
            cwd.as_ref().map(|c| c.display().to_string()),
        ),
    };
    sqlx::query(
        "INSERT INTO log_sources (id, label, kind, path, program, args, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&status.id)
    .bind(&status.label)
    .bind(kind_str)
    .bind(path)
    .bind(program)
    .bind(args)
    .bind(cwd)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(|e| format!("failed to persist log source {}: {e}", status.id))?;
    Ok(())
}

pub struct PersistedSource {
    pub id: String,
    pub label: String,
    pub kind: crate::log_state::SourceKind,
}

/// A malformed individual row (unknown `kind`, missing `path`/`program`,
/// unparseable `args` JSON) is logged and skipped rather than failing the
/// whole load — one corrupted row must not take every other source down
/// with it. A failure fetching the rows at all (a real DB/query problem, a
/// different class of failure) still returns `Err`.
pub async fn load_persisted_sources(pool: &SqlitePool) -> Result<Vec<PersistedSource>, String> {
    let rows = sqlx::query("SELECT id, label, kind, path, program, args, cwd FROM log_sources")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to load log sources: {e}"))?;

    let mut sources = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        let label: String = row.get("label");
        let kind_str: String = row.get("kind");
        let kind = match kind_str.as_str() {
            "file" => {
                let path: Option<String> = row.get("path");
                match path {
                    Some(path) => crate::log_state::SourceKind::File { path: PathBuf::from(path) },
                    None => {
                        eprintln!("skipping persisted log source {id}: kind=file but has no path");
                        continue;
                    }
                }
            }
            "command" => {
                let program: Option<String> = row.get("program");
                let program = match program {
                    Some(p) => p,
                    None => {
                        eprintln!("skipping persisted log source {id}: kind=command but has no program");
                        continue;
                    }
                };
                let args_json: Option<String> = row.get("args");
                let args: Vec<String> = match args_json {
                    Some(json) => match serde_json::from_str(&json) {
                        Ok(args) => args,
                        Err(e) => {
                            eprintln!("skipping persisted log source {id}: malformed args JSON: {e}");
                            continue;
                        }
                    },
                    None => Vec::new(),
                };
                let cwd: Option<String> = row.get("cwd");
                crate::log_state::SourceKind::Command { program, args, cwd: cwd.map(PathBuf::from) }
            }
            other => {
                eprintln!("skipping persisted log source {id}: unknown kind {other}");
                continue;
            }
        };
        sources.push(PersistedSource { id, label, kind });
    }
    Ok(sources)
}

/// Deletes only the `log_sources` config row. Deliberately does NOT touch
/// `log_lines` — removing a source stops new capture, it doesn't erase that
/// source's history from Search.
pub async fn delete_persisted_source(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM log_sources WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to delete persisted log source {id}: {e}"))?;
    // A silent no-op here is how a stale/mismatched id (e.g. an in-memory
    // source whose id diverged from its DB row) used to slip through
    // undetected instead of surfacing as the bug it is.
    if result.rows_affected() == 0 {
        return Err(format!("no persisted log source with id {id}"));
    }
    Ok(())
}

/// Flushes unflushed lines before anything else: `state.remove_source` drops
/// the source's whole buffer, and without this a source removed within one
/// flush interval of capturing a line would take that line down with it.
/// Then deletes the persisted row before touching in-memory state — if this
/// were reversed and the DB delete failed AFTER the in-memory removal already
/// succeeded, the source would vanish from `list_sources` while its row
/// stayed behind to resurrect on the next restart — the exact split-brain
/// this ordering exists to avoid.
pub async fn remove_log_source_impl(state: &LogState, pool: &SqlitePool, id: &str) -> Result<(), String> {
    flush_new_lines(pool, state).await?;
    delete_persisted_source(pool, id).await?;
    state.remove_source(id)
}

/// Re-adds every persisted source on startup — re-stats the file or
/// re-spawns the command, exactly like `add_log_source` does for a brand
/// new source. A source whose file is gone or whose command fails to spawn
/// is skipped with a logged error rather than crashing startup; it simply
/// doesn't reappear in `list_sources` (the same outcome as if it had never
/// been added), rather than being force-inserted into a broken state.
pub async fn restore_persisted_sources(pool: &SqlitePool, logs: &Arc<LogState>) {
    let rows = match load_persisted_sources(pool).await {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("failed to load persisted log sources: {e}");
            return;
        }
    };
    for row in rows {
        let id = row.id.clone();
        let result = match row.kind {
            crate::log_state::SourceKind::File { .. } => logs.add_source_with_id(row.id, row.label, row.kind),
            crate::log_state::SourceKind::Command { program, args, cwd } => {
                crate::log_state::spawn_command_source_with_id(Arc::clone(logs), row.id, row.label, program, args, cwd).await
            }
        };
        if let Err(e) = result {
            eprintln!("failed to restore log source {id}: {e}");
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ReadLogLinesInput {
    pub after_id: u64,
    pub source_id: Option<String>,
    pub limit: usize,
}

pub async fn add_log_source_impl(
    state: &Arc<LogState>,
    pool: &SqlitePool,
    input: AddLogSourceInput,
) -> Result<crate::log_state::LogSourceStatus, String> {
    let label = if input.label.trim().is_empty() {
        match (&input.kind[..], input.path.as_deref()) {
            ("file", Some(path)) => PathBuf::from(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string()),
            _ => input.program.clone().unwrap_or_else(|| "log source".to_string()),
        }
    } else {
        input.label.trim().to_string()
    };

    let kind = parse_source_kind(&input)?;
    let status = match kind.clone() {
        crate::log_state::SourceKind::File { .. } => state.add_source(label, kind.clone())?,
        crate::log_state::SourceKind::Command { program, args, cwd } => {
            crate::log_state::spawn_command_source(Arc::clone(state), label, program, args, cwd).await?
        }
    };
    // The source is already live (and, for a command, its child already
    // spawned) at this point — if persisting fails, undo that instead of
    // returning an error while leaving a source the caller was told doesn't
    // exist still running and unreachable through any future remove call.
    if let Err(e) = persist_log_source(pool, &status, &kind).await {
        let _ = state.remove_source(&status.id);
        return Err(e);
    }
    Ok(status)
}

/// Global cap on persisted lines, mirroring the in-memory ring buffer's own
/// eviction philosophy: oldest rows go first once the cap is exceeded.
/// Hardcoded on purpose — a Settings row is a scoped-out future extension,
/// same pattern as `DEFAULT_CORRELATION_WINDOW_MS`.
pub const MAX_PERSISTED_LINES: i64 = 100_000;

/// Reconciles `LogState`'s in-memory id counter with whatever is already
/// durable in `log_lines`, so a restarted session's freshly-assigned ids
/// (which start back at 1 in a brand new `LogState`) never collide with a
/// previous session's still-persisted primary keys. Must run before any line
/// can be captured or flushed — `restore_persisted_sources` can immediately
/// start emitting lines from respawned command sources, so this has to run
/// BEFORE that call, not merely "alongside" it.
pub async fn seed_log_id_counter(pool: &SqlitePool, logs: &LogState) -> Result<(), String> {
    let max_id: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) FROM log_lines")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("failed to read the highest persisted log line id: {e}"))?;
    logs.seed_next_id(max_id as u64 + 1);
    Ok(())
}

/// Batched in one transaction, not one implicit commit per row: a bursty
/// tick's lines land atomically (all or none) and pay one fsync-equivalent
/// instead of one per line.
pub async fn flush_new_lines(pool: &SqlitePool, logs: &LogState) -> Result<usize, String> {
    let batch = logs.take_unflushed();
    if batch.is_empty() {
        return Ok(0);
    }
    let mut tx = pool.begin().await.map_err(|e| format!("failed to begin log flush transaction: {e}"))?;
    let mut written = 0;
    for line in &batch {
        sqlx::query(
            "INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(line.id as i64)
        .bind(&line.source_id)
        .bind(line.captured_at_ms)
        .bind(&line.timestamp)
        .bind(&line.level)
        .bind(&line.message)
        .bind(&line.raw)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("failed to flush log line {}: {e}", line.id))?;
        written += 1;
    }
    tx.commit().await.map_err(|e| format!("failed to commit log line flush: {e}"))?;
    Ok(written)
}

pub async fn prune_log_lines(pool: &SqlitePool) -> Result<u64, String> {
    prune_log_lines_to_cap(pool, MAX_PERSISTED_LINES).await
}

/// Split out from `prune_log_lines` so a test can prune to a small cap
/// without waiting to accumulate 100,000 real rows.
async fn prune_log_lines_to_cap(pool: &SqlitePool, cap: i64) -> Result<u64, String> {
    let result = sqlx::query("DELETE FROM log_lines WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM log_lines)")
        .bind(cap)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to prune log_lines: {e}"))?;
    Ok(result.rows_affected())
}

pub fn read_log_lines_impl(state: &LogState, input: ReadLogLinesInput) -> LogPage {
    state.read_since(
        input.after_id,
        input.source_id.as_deref(),
        input.limit.clamp(1, MAX_READ_LIMIT),
    )
}

#[tauri::command]
pub async fn add_log_source(
    logs: State<'_, Arc<LogState>>,
    db: State<'_, LocalDb>,
    input: AddLogSourceInput,
) -> Result<crate::log_state::LogSourceStatus, String> {
    add_log_source_impl(logs.inner(), &db.pool, input).await
}

#[tauri::command]
pub async fn remove_log_source(logs: State<'_, Arc<LogState>>, db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    remove_log_source_impl(&logs, &db.pool, &id).await
}

#[tauri::command]
pub async fn list_log_sources(logs: State<'_, Arc<LogState>>) -> Result<Vec<LogSourceStatus>, String> {
    Ok(logs.list_sources())
}

#[tauri::command]
pub async fn read_log_lines(
    logs: State<'_, Arc<LogState>>,
    input: ReadLogLinesInput,
) -> Result<LogPage, String> {
    Ok(read_log_lines_impl(&logs, input))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The current, unmodified frontend only ever sends this shape — proves
    // the backward-compatibility claim at the serde level, not just via
    // struct literals built with all fields spelled out.
    #[test]
    fn add_log_source_input_deserializes_from_the_pre_task_4_shape() {
        let input: AddLogSourceInput = serde_json::from_str(r#"{"label":"app","path":"/tmp/app.log"}"#).unwrap();
        assert_eq!(input.label, "app");
        assert_eq!(input.path.as_deref(), Some("/tmp/app.log"));
        assert_eq!(input.kind, "file");
        assert_eq!(input.program, None);
        assert_eq!(input.args, Vec::<String>::new());
        assert_eq!(input.cwd, None);
    }

    #[test]
    fn parse_source_kind_rejects_a_command_input_with_no_program() {
        let input = AddLogSourceInput {
            label: "x".into(),
            path: None,
            kind: "command".into(),
            program: None,
            args: Vec::new(),
            cwd: None,
        };
        let err = parse_source_kind(&input).unwrap_err();
        assert!(err.contains("program"), "{err}");
    }

    #[test]
    fn parse_source_kind_rejects_an_unrecognized_kind() {
        let input = AddLogSourceInput {
            label: "x".into(),
            path: None,
            kind: "pipe".into(),
            program: None,
            args: Vec::new(),
            cwd: None,
        };
        let err = parse_source_kind(&input).unwrap_err();
        assert!(err.contains("pipe"), "{err}");
    }

    #[tokio::test]
    async fn persist_and_load_round_trips_a_file_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let state = LogState::new();
        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let status = state.add_source("app.log".into(), kind.clone()).unwrap();

        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        let loaded = load_persisted_sources(&db.pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, status.id);
        assert_eq!(loaded[0].label, "app.log");
        assert_eq!(loaded[0].kind, crate::log_state::SourceKind::File { path });
    }

    #[tokio::test]
    async fn persist_and_load_round_trips_a_command_source_including_its_args() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        let state = LogState::new();
        let kind = crate::log_state::SourceKind::Command {
            program: "npm".into(),
            args: vec!["run".into(), "dev".into()],
            cwd: Some(PathBuf::from("/home/dev/app")),
        };
        let status = state.add_source("web".into(), kind.clone()).unwrap();

        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        let loaded = load_persisted_sources(&db.pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].kind, kind);
    }

    #[tokio::test]
    async fn load_persisted_sources_skips_a_row_with_malformed_args_json_but_still_loads_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();
        let good_kind = crate::log_state::SourceKind::File { path: path.clone() };
        let good_status = LogState::new().add_source("app.log".into(), good_kind.clone()).unwrap();
        persist_log_source(&db.pool, &good_status, &good_kind).await.unwrap();

        // Inserted directly — persist_log_source can never itself produce
        // invalid args JSON, so this simulates on-disk corruption.
        sqlx::query("INSERT INTO log_sources (id, label, kind, program, args, created_at) VALUES (?, ?, 'command', ?, ?, ?)")
            .bind("src-bad-args")
            .bind("broken")
            .bind("npm")
            .bind("not valid json")
            .bind("2026-07-31T00:00:00Z")
            .execute(&db.pool)
            .await
            .unwrap();

        let loaded = load_persisted_sources(&db.pool).await.unwrap();
        assert_eq!(loaded.len(), 1, "the malformed row must be skipped individually, not abort the whole batch");
        assert_eq!(loaded[0].id, good_status.id);
    }

    #[tokio::test]
    async fn load_persisted_sources_skips_a_row_with_an_unknown_kind_but_still_loads_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();
        let good_kind = crate::log_state::SourceKind::File { path: path.clone() };
        let good_status = LogState::new().add_source("app.log".into(), good_kind.clone()).unwrap();
        persist_log_source(&db.pool, &good_status, &good_kind).await.unwrap();

        sqlx::query("INSERT INTO log_sources (id, label, kind, created_at) VALUES (?, ?, 'pipe', ?)")
            .bind("src-bad-kind")
            .bind("mystery")
            .bind("2026-07-31T00:00:00Z")
            .execute(&db.pool)
            .await
            .unwrap();

        let loaded = load_persisted_sources(&db.pool).await.unwrap();
        assert_eq!(loaded.len(), 1, "the unknown-kind row must be skipped individually, not abort the whole batch");
        assert_eq!(loaded[0].id, good_status.id);
    }

    #[tokio::test]
    async fn add_log_source_falls_back_to_the_file_name_when_no_label_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.log");
        std::fs::write(&path, "").unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        let state = Arc::new(LogState::new());
        let source = add_log_source_impl(
            &state,
            &db.pool,
            AddLogSourceInput {
                label: "   ".into(),
                path: Some(path.display().to_string()),
                kind: "file".into(),
                program: None,
                args: Vec::new(),
                cwd: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(source.label, "server.log");
        assert_eq!(source.state, "live");
    }

    // The only other add_log_source_impl test above exercises kind="file";
    // this covers the Command dispatch arm (parse_source_kind ->
    // spawn_command_source -> persist_log_source) end to end through the
    // same entry point the add_log_source tauri command actually calls.
    #[tokio::test]
    async fn add_log_source_impl_spawns_and_persists_a_command_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let state = Arc::new(LogState::new());

        let status = add_log_source_impl(
            &state,
            &db.pool,
            AddLogSourceInput {
                label: "web".into(),
                path: None,
                kind: "command".into(),
                program: Some("sh".into()),
                args: vec!["-c".into(), "echo hi".into()],
                cwd: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(status.kind, "command");
        assert_eq!(status.state, "live");
        assert_eq!(status.path, "sh -c echo hi");

        // LogState::add_source alone would produce identical status fields
        // for a Command kind without ever running anything — this only
        // passes if spawn_command_source's reader task actually captured
        // the process's real stdout, proving the dispatch arm was taken.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let page = state.read_since(0, Some(&status.id), 100);
        assert!(page.lines.iter().any(|l| l.message == "hi"), "{:?}", page.lines);

        let loaded = load_persisted_sources(&db.pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, status.id);
        assert_eq!(
            loaded[0].kind,
            crate::log_state::SourceKind::Command { program: "sh".into(), args: vec!["-c".into(), "echo hi".into()], cwd: None }
        );
    }

    #[tokio::test]
    async fn add_log_source_impl_falls_back_to_the_program_name_when_no_label_is_given_for_a_command_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let state = Arc::new(LogState::new());

        let status = add_log_source_impl(
            &state,
            &db.pool,
            AddLogSourceInput {
                label: "   ".into(),
                path: None,
                kind: "command".into(),
                program: Some("sh".into()),
                args: vec!["-c".into(), "echo hi".into()],
                cwd: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(status.label, "sh");
    }

    #[tokio::test]
    async fn add_log_source_impl_rolls_back_the_in_memory_source_when_persisting_fails() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();
        let state = Arc::new(LogState::new());

        // Forces persist_log_source to fail on a real DB error, with no
        // dependence on guessing the freshly-minted source id.
        db.pool.close().await;

        let result = add_log_source_impl(
            &state,
            &db.pool,
            AddLogSourceInput {
                label: "app".into(),
                path: Some(path.display().to_string()),
                kind: "file".into(),
                program: None,
                args: Vec::new(),
                cwd: None,
            },
        )
        .await;

        assert!(result.is_err(), "a persist failure must surface as an error");
        assert_eq!(
            state.list_sources().len(),
            0,
            "the in-memory source must be rolled back, not left live with no persisted row behind it"
        );
    }

    #[test]
    fn read_log_lines_clamps_an_absurd_limit() {
        let state = LogState::new();
        let page = read_log_lines_impl(
            &state,
            ReadLogLinesInput { after_id: 0, source_id: None, limit: usize::MAX },
        );
        // No sources, so nothing to read — the point is that it returns rather
        // than trying to allocate for usize::MAX lines.
        assert_eq!(page.lines.len(), 0);
    }

    #[tokio::test]
    async fn remove_log_source_errors_on_an_unknown_id() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let state = LogState::new();
        assert!(remove_log_source_impl(&state, &db.pool, "nope").await.is_err());
    }

    #[tokio::test]
    async fn removing_a_source_deletes_its_persisted_row_but_keeps_its_line_history() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let state = Arc::new(LogState::new());
        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let status = state.add_source("app.log".into(), kind.clone()).unwrap();
        persist_log_source(&db.pool, &status, &kind).await.unwrap();
        sqlx::query("INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) VALUES (1, ?, 1000, NULL, NULL, 'hello', 'hello')")
            .bind(&status.id)
            .execute(&db.pool)
            .await
            .unwrap();

        remove_log_source_impl(&state, &db.pool, &status.id).await.unwrap();

        let remaining_sources = load_persisted_sources(&db.pool).await.unwrap();
        assert!(remaining_sources.is_empty(), "the config row must be gone so restore doesn't resurrect it");

        let line_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_lines WHERE source_id = ?")
            .bind(&status.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(line_count, 1, "history must survive — removing a source stops capture, it doesn't erase Search history");
    }

    #[tokio::test]
    async fn removing_a_source_flushes_its_unflushed_lines_before_deleting_it() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let state = Arc::new(LogState::new());
        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let status = state.add_source("app.log".into(), kind.clone()).unwrap();
        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        state.poll_all(1_000);
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "captured but never flushed").unwrap();
        f.flush().unwrap();
        state.poll_all(2_000);

        remove_log_source_impl(&state, &db.pool, &status.id).await.unwrap();

        let line_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_lines WHERE source_id = ?")
            .bind(&status.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(line_count, 1, "the line captured just before removal must survive, not be discarded along with the buffer");
    }

    #[tokio::test]
    async fn restore_persisted_sources_re_adds_every_saved_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let bootstrap_state = LogState::new();
        let status = bootstrap_state.add_source("app.log".into(), kind.clone()).unwrap();
        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        // Simulate a restart: a fresh, empty LogState.
        let fresh_state = Arc::new(LogState::new());
        assert_eq!(fresh_state.list_sources().len(), 0);

        restore_persisted_sources(&db.pool, &fresh_state).await;

        let sources = fresh_state.list_sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].label, "app.log");
        assert_eq!(sources[0].state, "live");
    }

    #[tokio::test]
    async fn restore_persisted_sources_keeps_the_persisted_source_id() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let bootstrap_state = LogState::new();
        let status = bootstrap_state.add_source("app.log".into(), kind.clone()).unwrap();
        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        let fresh_state = Arc::new(LogState::new());
        restore_persisted_sources(&db.pool, &fresh_state).await;

        let sources = fresh_state.list_sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, status.id, "the restored source must keep the persisted id, not mint a new one");
    }

    #[tokio::test]
    async fn a_source_removed_after_a_restart_stays_removed() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let bootstrap_state = LogState::new();
        let status = bootstrap_state.add_source("app.log".into(), kind.clone()).unwrap();
        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        // Simulate a restart, then remove the source using the id the
        // restored session actually sees (what the frontend would send).
        let restarted_state = Arc::new(LogState::new());
        restore_persisted_sources(&db.pool, &restarted_state).await;
        let restored_id = restarted_state.list_sources()[0].id.clone();

        remove_log_source_impl(&restarted_state, &db.pool, &restored_id).await.unwrap();

        assert!(
            load_persisted_sources(&db.pool).await.unwrap().is_empty(),
            "the persisted row must actually be gone, not left behind under a different id"
        );

        // A second restart must not resurrect it.
        let second_restart_state = Arc::new(LogState::new());
        restore_persisted_sources(&db.pool, &second_restart_state).await;
        assert_eq!(second_restart_state.list_sources().len(), 0);
    }

    // Not in the brief's test list, added because `restore_persisted_sources`'s
    // Command branch (calling `spawn_command_source`) was otherwise untested —
    // only its File branch had coverage.
    #[tokio::test]
    async fn restore_persisted_sources_respawns_a_command_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        let bootstrap_state = Arc::new(LogState::new());
        let status = crate::log_state::spawn_command_source(
            Arc::clone(&bootstrap_state),
            "web".into(),
            "sh".into(),
            vec!["-c".into(), "echo restored-hello".into()],
            None,
        )
        .await
        .unwrap();
        let kind =
            crate::log_state::SourceKind::Command { program: "sh".into(), args: vec!["-c".into(), "echo restored-hello".into()], cwd: None };
        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        let fresh_state = Arc::new(LogState::new());
        restore_persisted_sources(&db.pool, &fresh_state).await;

        let sources = fresh_state.list_sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].label, "web");
        assert_eq!(sources[0].kind, "command");
        assert_eq!(sources[0].id, status.id, "restore must keep the persisted id, not mint a new one");

        // len==1/label/kind alone would stay green even if the Command arm
        // were replaced with a no-op registration that never spawns
        // anything — only actually observing the respawned process's real
        // stdout proves the respawn happened.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let page = fresh_state.read_since(0, Some(&sources[0].id), 100);
        assert!(page.lines.iter().any(|l| l.message == "restored-hello"), "{:?}", page.lines);
    }

    #[tokio::test]
    async fn restore_persisted_sources_skips_a_source_whose_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        // Persists a source pointing at a file that will NOT exist on restore.
        sqlx::query("INSERT INTO log_sources (id, label, kind, path, created_at) VALUES (?, ?, 'file', ?, ?)")
            .bind("src-gone")
            .bind("gone.log")
            .bind(dir.path().join("gone.log").display().to_string())
            .bind("2026-07-31T00:00:00Z")
            .execute(&db.pool)
            .await
            .unwrap();

        let state = Arc::new(LogState::new());
        restore_persisted_sources(&db.pool, &state).await;

        assert_eq!(state.list_sources().len(), 0);
    }

    #[tokio::test]
    async fn migration_0006_creates_usable_log_sources_and_log_lines_tables() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        sqlx::query(
            "INSERT INTO log_sources (id, label, kind, path, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("src1")
        .bind("server.log")
        .bind("file")
        .bind("/tmp/app.log")
        .bind("2026-07-31T00:00:00Z")
        .execute(&db.pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(1i64)
        .bind("src1")
        .bind(1_000i64)
        .bind(Option::<String>::None)
        .bind("INFO")
        .bind("started")
        .bind("started")
        .execute(&db.pool)
        .await
        .unwrap();

        let source_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_sources")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let line_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_lines WHERE source_id = 'src1'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(source_count, 1);
        assert_eq!(line_count, 1);
    }

    #[tokio::test]
    async fn flush_new_lines_writes_exactly_the_unflushed_lines() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let state = LogState::new();
        state.add_source("app.log".into(), crate::log_state::SourceKind::File { path: path.clone() }).unwrap();
        state.poll_all(1_000);
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "one").unwrap();
        writeln!(f, "two").unwrap();
        f.flush().unwrap();
        state.poll_all(2_000);

        let written = flush_new_lines(&db.pool, &state).await.unwrap();
        assert_eq!(written, 2);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_lines").fetch_one(&db.pool).await.unwrap();
        assert_eq!(count, 2);

        // A second flush with nothing new writes nothing.
        let written_again = flush_new_lines(&db.pool, &state).await.unwrap();
        assert_eq!(written_again, 0);
    }

    #[tokio::test]
    async fn prune_log_lines_keeps_only_the_most_recent_rows() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        for i in 1..=10i64 {
            sqlx::query(
                "INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) VALUES (?, 'src1', ?, NULL, NULL, ?, ?)",
            )
            .bind(i)
            .bind(1_000 + i)
            .bind(format!("line {i}"))
            .bind(format!("line {i}"))
            .execute(&db.pool)
            .await
            .unwrap();
        }

        // Prune to a cap of 4: rows with id 1..=6 should go, 7..=10 should remain.
        let deleted = prune_log_lines_to_cap(&db.pool, 4).await.unwrap();
        assert_eq!(deleted, 6);

        let remaining_ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM log_lines ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
        assert_eq!(remaining_ids, vec![7, 8, 9, 10]);
    }

    // Reproduces a restart: a previous session already persisted a row with
    // id 1. A fresh LogState (exactly what main.rs constructs on every
    // launch) starts its id counter at 1 too, unless seeded — so the very
    // first line captured this session collides with that old row's primary
    // key. Without `seed_log_id_counter`, this test fails: `flush_new_lines`
    // returns Err on the collision, and because `take_unflushed` already
    // advanced its cursor before the INSERT ran, that line is gone for good.
    #[tokio::test]
    async fn seeding_the_id_counter_prevents_a_restarted_session_from_colliding_with_persisted_ids() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        sqlx::query(
            "INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) VALUES (1, 'src-old', 1000, NULL, NULL, 'from last session', 'from last session')",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        let state = LogState::new();
        seed_log_id_counter(&db.pool, &state).await.unwrap();

        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();
        state.add_source("app.log".into(), crate::log_state::SourceKind::File { path: path.clone() }).unwrap();
        state.poll_all(1_000);
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "from this session").unwrap();
        f.flush().unwrap();
        state.poll_all(2_000);

        let written = flush_new_lines(&db.pool, &state).await.expect("flush must not collide with a previous session's ids");
        assert_eq!(written, 1);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_lines").fetch_one(&db.pool).await.unwrap();
        assert_eq!(count, 2, "the previous session's row and the new one must both survive");
    }
}
