use std::sync::Arc;
use tauri::State;

use crate::email_state::{
    clear_captured_emails, get_captured_email, list_captured_emails, CapturedEmail, EmailState,
    ListEmailsResult, SmtpStatus,
};
use crate::local_db::LocalDb;

/// Upper bound on one `list_emails` payload — the retention cap itself, so
/// this is belt-and-braces against a frontend bug asking for more.
const MAX_LIST_LIMIT: i64 = 5_000;

pub async fn list_emails_impl(
    pool: &sqlx::SqlitePool,
    session_id: Option<&str>,
    limit: i64,
) -> Result<ListEmailsResult, String> {
    list_captured_emails(pool, session_id, limit.clamp(1, MAX_LIST_LIMIT)).await
}

pub async fn get_email_impl(pool: &sqlx::SqlitePool, id: u64) -> Result<CapturedEmail, String> {
    get_captured_email(pool, id)
        .await?
        .ok_or_else(|| format!("no captured email with id {id} — it may have been evicted or cleared"))
}

pub async fn clear_emails_impl(pool: &sqlx::SqlitePool, session_id: Option<&str>) -> Result<(), String> {
    clear_captured_emails(pool, session_id).await
}

#[tauri::command]
pub async fn list_emails(
    db: State<'_, LocalDb>,
    session_id: Option<String>,
    limit: i64,
) -> Result<ListEmailsResult, String> {
    list_emails_impl(&db.pool, session_id.as_deref(), limit).await
}

#[tauri::command]
pub async fn get_email(db: State<'_, LocalDb>, id: u64) -> Result<CapturedEmail, String> {
    get_email_impl(&db.pool, id).await
}

#[tauri::command]
pub async fn clear_emails(db: State<'_, LocalDb>, session_id: Option<String>) -> Result<(), String> {
    clear_emails_impl(&db.pool, session_id.as_deref()).await
}

#[tauri::command]
pub async fn smtp_status(emails: State<'_, Arc<EmailState>>) -> Result<SmtpStatus, String> {
    Ok(emails.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_db::LocalDb;

    const SIMPLE: &str = "Subject: Hello\r\n\r\nbody\r\n";

    async fn seeded(count: usize) -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        for i in 0..count {
            crate::email_state::insert_captured_email(
                &db.pool,
                &format!("s{i}@x.test"),
                &["r@y.test".into()],
                SIMPLE,
                1_000 + i as i64,
            )
            .await
            .unwrap();
        }
        (dir, db)
    }

    #[tokio::test]
    async fn list_emails_returns_newest_first_and_clamps_the_limit() {
        let (_dir, db) = seeded(3).await;
        let listed = list_emails_impl(&db.pool, None, i64::MAX).await.unwrap();
        assert_eq!(listed.emails.len(), 3);
        assert_eq!(listed.emails[0].from, "s2@x.test");
    }

    #[tokio::test]
    async fn get_email_returns_the_full_message() {
        let (_dir, db) = seeded(1).await;
        let id = list_emails_impl(&db.pool, None, 10).await.unwrap().emails[0].id;
        let full = get_email_impl(&db.pool, id).await.unwrap();
        assert_eq!(full.subject, "Hello");
        assert!(full.raw.contains("body"));
    }

    #[tokio::test]
    async fn get_email_explains_why_a_missing_id_is_missing() {
        let (_dir, db) = seeded(1).await;
        let err = get_email_impl(&db.pool, 9_999).await.unwrap_err();
        assert!(err.contains("9999"));
        assert!(err.contains("evicted or cleared"));
    }

    #[tokio::test]
    async fn clear_emails_empties_the_inbox() {
        let (_dir, db) = seeded(2).await;
        clear_emails_impl(&db.pool, None).await.unwrap();
        assert_eq!(list_emails_impl(&db.pool, None, 10).await.unwrap().emails.len(), 0);
    }
}
