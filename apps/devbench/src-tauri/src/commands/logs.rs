use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::log_state::{LogPage, LogSourceStatus, LogState};

/// Upper bound on how many lines one `read_log_lines` call returns. Keeps a
/// single IPC payload bounded even if the frontend asks for everything.
const MAX_READ_LIMIT: usize = 2_000;

#[derive(Debug, Deserialize)]
pub struct AddLogSourceInput {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct ReadLogLinesInput {
    pub after_id: u64,
    pub source_id: Option<String>,
    pub limit: usize,
}

pub fn add_log_source_impl(state: &LogState, input: AddLogSourceInput) -> Result<LogSourceStatus, String> {
    let label = if input.label.trim().is_empty() {
        // Falling back to the file name beats an unlabelled row in the sidebar.
        PathBuf::from(&input.path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| input.path.clone())
    } else {
        input.label.trim().to_string()
    };
    state.add_source(label, PathBuf::from(input.path))
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
    input: AddLogSourceInput,
) -> Result<LogSourceStatus, String> {
    add_log_source_impl(&logs, input)
}

#[tauri::command]
pub async fn remove_log_source(logs: State<'_, Arc<LogState>>, id: String) -> Result<(), String> {
    logs.remove_source(&id)
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

    #[test]
    fn add_log_source_falls_back_to_the_file_name_when_no_label_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.log");
        std::fs::write(&path, "").unwrap();

        let state = LogState::new();
        let source = add_log_source_impl(
            &state,
            AddLogSourceInput { label: "   ".into(), path: path.display().to_string() },
        )
        .unwrap();

        assert_eq!(source.label, "server.log");
        assert_eq!(source.state, "live");
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

    #[test]
    fn remove_log_source_errors_on_an_unknown_id() {
        let state = LogState::new();
        assert!(state.remove_source("nope").is_err());
    }
}
