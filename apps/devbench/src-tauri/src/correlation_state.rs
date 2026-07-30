use std::collections::HashMap;
use std::sync::Mutex;
use uuid::Uuid;

/// How long after the response DevBench keeps collecting log lines (and, from
/// Plan 3, emails) for the rollup.
///
/// Hardcoded on purpose: Settings > General (Plan 4) replaces this constant
/// with a stored, user-editable value. This is a scoping decision in the same
/// spirit as Plan 1's hardcoded `DEV_CONNECTION` — not a forgotten placeholder.
pub const DEFAULT_CORRELATION_WINDOW_MS: i64 = 5_000;

/// How long an unclaimed window is kept before being pruned. Generous enough
/// that a slow frontend still gets its data, small enough that abandoned
/// windows (window closed, app backgrounded) cannot accumulate.
const WINDOW_RETENTION_MS: i64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpenWindow {
    /// Buffer id recorded immediately BEFORE the request was fired. Everything
    /// with a greater id happened at or after the request.
    pub from_log_id: u64,
    pub window_ends_at_ms: i64,
}

#[derive(Default)]
pub struct CorrelationRegistry {
    windows: Mutex<HashMap<String, OpenWindow>>,
}

impl CorrelationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self, from_log_id: u64, window_ends_at_ms: i64) -> String {
        let id = Uuid::new_v4().to_string();
        if let Ok(mut windows) = self.windows.lock() {
            windows.retain(|_, w| w.window_ends_at_ms + WINDOW_RETENTION_MS > window_ends_at_ms);
            windows.insert(id.clone(), OpenWindow { from_log_id, window_ends_at_ms });
        }
        id
    }

    /// Removes and returns the window. A correlation is collected exactly once.
    pub fn take(&self, id: &str) -> Option<OpenWindow> {
        self.windows.lock().ok()?.remove(id)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.windows.lock().map(|w| w.len()).unwrap_or(0)
    }
}
