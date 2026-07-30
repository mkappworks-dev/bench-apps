use std::sync::Arc;
use tauri::State;

use crate::email_state::{CapturedEmail, EmailState, EmailSummary, SmtpStatus};

/// Upper bound on one `list_emails` payload. The inbox itself is capped at
/// 200, so this is belt-and-braces against a frontend bug asking for more.
const MAX_LIST_LIMIT: usize = 200;

pub fn list_emails_impl(state: &EmailState, limit: usize) -> Result<Vec<EmailSummary>, String> {
    let store = state.store();
    let guard = store.lock().map_err(|_| "email store poisoned".to_string())?;
    Ok(guard.list(limit.clamp(1, MAX_LIST_LIMIT)))
}

pub fn get_email_impl(state: &EmailState, id: u64) -> Result<CapturedEmail, String> {
    let store = state.store();
    let guard = store.lock().map_err(|_| "email store poisoned".to_string())?;
    guard
        .get(id)
        .ok_or_else(|| format!("no captured email with id {id} — it may have been evicted or cleared"))
}

pub fn clear_emails_impl(state: &EmailState) -> Result<(), String> {
    let store = state.store();
    let mut guard = store.lock().map_err(|_| "email store poisoned".to_string())?;
    guard.clear();
    Ok(())
}

#[tauri::command]
pub async fn list_emails(
    emails: State<'_, Arc<EmailState>>,
    limit: usize,
) -> Result<Vec<EmailSummary>, String> {
    list_emails_impl(&emails, limit)
}

#[tauri::command]
pub async fn get_email(emails: State<'_, Arc<EmailState>>, id: u64) -> Result<CapturedEmail, String> {
    get_email_impl(&emails, id)
}

#[tauri::command]
pub async fn clear_emails(emails: State<'_, Arc<EmailState>>) -> Result<(), String> {
    clear_emails_impl(&emails)
}

#[tauri::command]
pub async fn smtp_status(emails: State<'_, Arc<EmailState>>) -> Result<SmtpStatus, String> {
    Ok(emails.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = "Subject: Hello\r\n\r\nbody\r\n";

    fn seeded(count: usize) -> EmailState {
        let state = EmailState::new();
        {
            let store = state.store();
            let mut guard = store.lock().unwrap();
            for i in 0..count {
                guard.push(&format!("s{i}@x.test"), &["r@y.test".into()], SIMPLE, 1_000 + i as i64);
            }
        }
        state
    }

    #[test]
    fn list_emails_returns_newest_first_and_clamps_the_limit() {
        let state = seeded(3);
        let listed = list_emails_impl(&state, usize::MAX).unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].from, "s2@x.test");
    }

    #[test]
    fn get_email_returns_the_full_message() {
        let state = seeded(1);
        let id = list_emails_impl(&state, 10).unwrap()[0].id;
        let full = get_email_impl(&state, id).unwrap();
        assert_eq!(full.subject, "Hello");
        assert!(full.raw.contains("body"));
    }

    #[test]
    fn get_email_explains_why_a_missing_id_is_missing() {
        let state = seeded(1);
        let err = get_email_impl(&state, 9_999).unwrap_err();
        assert!(err.contains("9999"));
        assert!(err.contains("evicted or cleared"));
    }

    #[test]
    fn clear_emails_empties_the_inbox() {
        let state = seeded(2);
        clear_emails_impl(&state).unwrap();
        assert_eq!(list_emails_impl(&state, 10).unwrap().len(), 0);
    }
}
