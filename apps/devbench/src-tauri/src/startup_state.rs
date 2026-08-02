use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DbInitError {
    pub db_path: String,
    pub error: String,
}

/// Tauri-managed once, in `main.rs`'s `setup`, before any command can run —
/// `db_error: None` means `LocalDb` connected and is managed as usual.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StartupStatus {
    pub db_error: Option<DbInitError>,
}

/// The startup-error screen's explanation: what failed, the file involved,
/// the likely cause, and concrete remedies. `error` is sqlx's message
/// verbatim — it names the offending migration version, the most useful
/// diagnostic available.
pub fn format_db_init_error(db_path: &str, error: &str) -> String {
    format!(
        "DevBench could not open its local database:\n{db_path}\n\n\
Likely cause: this file was created by a different branch or version of \
DevBench whose database migrations don't match this one.\n\n\
To fix it, do one of the following:\n\
- Move or rename the file above, then relaunch — DevBench will create a fresh one.\n\
- In development, set DEVBENCH_DATA_DIR to point this checkout at its own \
database directory instead of sharing one with other checkouts.\n\n\
Underlying error: {error}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_db_path_and_carries_the_sqlx_error_verbatim() {
        let msg = format_db_init_error(
            "/tmp/x/devbench.db",
            "migration 5 was previously applied but has been modified",
        );
        assert!(msg.contains("/tmp/x/devbench.db"));
        assert!(msg.contains("migration 5 was previously applied but has been modified"));
    }

    #[test]
    fn names_both_remedies() {
        let msg = format_db_init_error("/tmp/x/devbench.db", "boom");
        assert!(msg.contains("DEVBENCH_DATA_DIR"));
        assert!(msg.to_lowercase().contains("move or rename"));
    }
}
