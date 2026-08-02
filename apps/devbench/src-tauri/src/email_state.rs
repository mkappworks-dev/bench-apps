use serde::Serialize;
use sqlx::{Row, SqlitePool};
use std::sync::Mutex;

/// Port the local SMTP catcher listens on. Point your backend's SMTP config
/// here — the same integration Mailhog and Mailpit ask for.
pub const DEFAULT_SMTP_PORT: u16 = 1025;

/// Global cap on persisted captured mail, across every session. Eviction
/// removes the oldest rows table-wide; `captured_emails_state` records how
/// far, so a correlation window (or the inbox footer) can detect it lost some.
pub const MAX_CAPTURED_EMAILS: i64 = 5_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CapturedEmail {
    pub id: u64,
    pub captured_at_ms: i64,
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub html_body: Option<String>,
    pub text_body: Option<String>,
    pub raw: String,
    pub size_bytes: usize,
    /// `None` unless a correlated request's window observed this email.
    pub request_id: Option<String>,
    /// Populated by a `LEFT JOIN request_history` in `get_captured_email` —
    /// `None` whenever `request_id` is `None`.
    pub request_method: Option<String>,
    pub request_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EmailSummary {
    pub id: u64,
    pub captured_at_ms: i64,
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub size_bytes: usize,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ListEmailsResult {
    pub emails: Vec<EmailSummary>,
    pub evicted_through_id: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedEmail {
    pub subject: String,
    pub html_body: Option<String>,
    pub text_body: Option<String>,
}

/// Lifts subject and bodies out of an RFC 5322 message. From/to are NOT taken
/// from here — they come from the SMTP envelope (see `smtp_catcher.rs`).
pub fn parse_captured(raw: &str) -> ParsedEmail {
    let parsed = mail_parser::MessageParser::default().parse(raw);
    match parsed {
        Some(message) => {
            let html_body = message.html_part(0).and_then(|part| match &part.body {
                mail_parser::PartType::Html(html) => Some(html.to_string()),
                _ => None,
            });
            let text_body = message.text_part(0).and_then(|part| match &part.body {
                mail_parser::PartType::Text(text) => Some(text.to_string()),
                _ => None,
            });
            ParsedEmail {
                subject: message.subject().unwrap_or("(no subject)").to_string(),
                html_body,
                text_body,
            }
        }
        None => ParsedEmail {
            subject: "(unparseable message)".to_string(),
            html_body: None,
            text_body: None,
        },
    }
}

async fn active_session_id(pool: &SqlitePool) -> Option<String> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = 'active_session_id'")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()?;
    let value: String = row.get("value");
    if value.is_empty() { None } else { Some(value) }
}

/// Deletes rows beyond `cap`, oldest first, and bumps
/// `captured_emails_state.evicted_through_id` to the highest id it deleted.
/// A private, cap-parameterized helper (rather than hardcoding
/// `MAX_CAPTURED_EMAILS` inline) so tests can exercise real eviction without
/// inserting 5,000 rows.
async fn evict_overflow(pool: &SqlitePool, cap: i64) -> Result<(), String> {
    let cutoff: Option<i64> = sqlx::query("SELECT id FROM captured_emails ORDER BY id DESC LIMIT 1 OFFSET ?")
        .bind(cap)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("failed to look up eviction cutoff: {e}"))?
        .map(|r| r.get::<i64, _>("id"));

    let Some(cutoff_id) = cutoff else { return Ok(()) };

    sqlx::query("UPDATE captured_emails_state SET evicted_through_id = ?1 WHERE id = 1 AND evicted_through_id < ?1")
        .bind(cutoff_id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to record eviction high-water mark: {e}"))?;

    sqlx::query("DELETE FROM captured_emails WHERE id <= ?")
        .bind(cutoff_id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to evict overflow captured emails: {e}"))?;
    Ok(())
}

/// Inserts a captured message, tagging it with whatever session is active
/// right now, and evicts overflow beyond `MAX_CAPTURED_EMAILS`. Called from
/// the SMTP catcher thread via `block_on` (see `smtp_catcher.rs`).
pub async fn insert_captured_email(
    pool: &SqlitePool,
    from: &str,
    to: &[String],
    raw: &str,
    captured_at_ms: i64,
) -> Result<(), String> {
    let parsed = parse_captured(raw);
    let session_id = active_session_id(pool).await;
    let to_json = serde_json::to_string(to).map_err(|e| format!("failed to encode recipients: {e}"))?;

    sqlx::query(
        "INSERT INTO captured_emails \
         (session_id, captured_at, from_addr, to_addrs, subject, html_body, text_body, raw, size_bytes) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(captured_at_ms)
    .bind(from)
    .bind(&to_json)
    .bind(&parsed.subject)
    .bind(&parsed.html_body)
    .bind(&parsed.text_body)
    .bind(raw)
    .bind(raw.len() as i64)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to store captured email: {e}"))?;

    evict_overflow(pool, MAX_CAPTURED_EMAILS).await
}

/// `session_id: None` mirrors `list_history_impl`'s unscoped case exactly:
/// every row, not `session_id IS NULL` — two distinct queries, not one
/// `(?1 IS NULL OR session_id = ?1)` predicate, for the same index-usage
/// reason `history.rs` already settled.
pub async fn list_captured_emails(
    pool: &SqlitePool,
    session_id: Option<&str>,
    limit: i64,
) -> Result<ListEmailsResult, String> {
    const COLUMNS: &str =
        "SELECT id, captured_at, from_addr, to_addrs, subject, size_bytes FROM captured_emails";

    let rows = match session_id {
        Some(id) => {
            sqlx::query(&format!("{COLUMNS} WHERE session_id = ? ORDER BY id DESC LIMIT ?"))
                .bind(id)
                .bind(limit)
                .fetch_all(pool)
                .await
        }
        None => {
            sqlx::query(&format!("{COLUMNS} ORDER BY id DESC LIMIT ?"))
                .bind(limit)
                .fetch_all(pool)
                .await
        }
    }
    .map_err(|e| format!("failed to list captured emails: {e}"))?;

    let emails = rows
        .into_iter()
        .map(|r| EmailSummary {
            id: r.get::<i64, _>("id") as u64,
            captured_at_ms: r.get("captured_at"),
            from: r.get("from_addr"),
            to: serde_json::from_str(&r.get::<String, _>("to_addrs")).unwrap_or_default(),
            subject: r.get("subject"),
            size_bytes: r.get::<i64, _>("size_bytes") as usize,
        })
        .collect();

    Ok(ListEmailsResult { emails, evicted_through_id: evicted_through_id(pool).await? })
}

pub async fn get_captured_email(pool: &SqlitePool, id: u64) -> Result<Option<CapturedEmail>, String> {
    let row = sqlx::query(
        "SELECT ce.id, ce.captured_at, ce.from_addr, ce.to_addrs, ce.subject, ce.html_body, ce.text_body, \
                ce.raw, ce.size_bytes, ce.request_id, rh.method AS request_method, rh.url AS request_url \
         FROM captured_emails ce \
         LEFT JOIN request_history rh ON rh.id = ce.request_id \
         WHERE ce.id = ?",
    )
    .bind(id as i64)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("failed to look up captured email {id}: {e}"))?;

    Ok(row.map(|r| CapturedEmail {
        id: r.get::<i64, _>("id") as u64,
        captured_at_ms: r.get("captured_at"),
        from: r.get("from_addr"),
        to: serde_json::from_str(&r.get::<String, _>("to_addrs")).unwrap_or_default(),
        subject: r.get("subject"),
        html_body: r.get("html_body"),
        text_body: r.get("text_body"),
        raw: r.get("raw"),
        size_bytes: r.get::<i64, _>("size_bytes") as usize,
        request_id: r.get("request_id"),
        request_method: r.get("request_method"),
        request_url: r.get("request_url"),
    }))
}

/// Uses the SAME scoping semantics as `list_captured_emails` — deliberately.
/// If clearing used a narrower scope than listing (e.g. only
/// `session_id IS NULL` when unscoped), "Clear inbox" with no active session
/// would leave most of what's on screen untouched.
pub async fn clear_captured_emails(pool: &SqlitePool, session_id: Option<&str>) -> Result<(), String> {
    // Advance the high-water mark first, the same way `evict_overflow` does,
    // to whichever id is highest among the rows this call is about to delete.
    // Without this, an in-flight correlation window whose `from_email_id`
    // predates the clear would report `emails: Some([])` instead of
    // `emails_truncated: true` — "this request sent no mail" when mail was
    // actually captured and then cleared, the exact false negative principle
    // 4 forbids.
    let max_id: Option<i64> = match session_id {
        Some(id) => {
            sqlx::query("SELECT MAX(id) as id FROM captured_emails WHERE session_id = ?").bind(id).fetch_one(pool).await
        }
        None => sqlx::query("SELECT MAX(id) as id FROM captured_emails").fetch_one(pool).await,
    }
    .map_err(|e| format!("failed to look up max captured email id before clearing: {e}"))?
    .get::<Option<i64>, _>("id");

    if let Some(id) = max_id {
        sqlx::query("UPDATE captured_emails_state SET evicted_through_id = ?1 WHERE id = 1 AND evicted_through_id < ?1")
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| format!("failed to record eviction high-water mark before clearing: {e}"))?;
    }

    match session_id {
        Some(id) => sqlx::query("DELETE FROM captured_emails WHERE session_id = ?").bind(id).execute(pool).await,
        None => sqlx::query("DELETE FROM captured_emails").execute(pool).await,
    }
    .map_err(|e| format!("failed to clear captured emails: {e}"))?;
    Ok(())
}

pub async fn between_captured_emails(
    pool: &SqlitePool,
    after_id: u64,
    captured_before_or_at_ms: i64,
) -> Result<Vec<EmailSummary>, String> {
    let rows = sqlx::query(
        "SELECT id, captured_at, from_addr, to_addrs, subject, size_bytes FROM captured_emails \
         WHERE id > ? AND captured_at <= ? ORDER BY id ASC",
    )
    .bind(after_id as i64)
    .bind(captured_before_or_at_ms)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to look up captured emails in window: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| EmailSummary {
            id: r.get::<i64, _>("id") as u64,
            captured_at_ms: r.get("captured_at"),
            from: r.get("from_addr"),
            to: serde_json::from_str(&r.get::<String, _>("to_addrs")).unwrap_or_default(),
            subject: r.get("subject"),
            size_bytes: r.get::<i64, _>("size_bytes") as usize,
        })
        .collect())
}

pub async fn evicted_through_id(pool: &SqlitePool) -> Result<u64, String> {
    let row = sqlx::query("SELECT evicted_through_id FROM captured_emails_state WHERE id = 1")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("failed to read eviction high-water mark: {e}"))?;
    Ok(row.get::<i64, _>("evicted_through_id") as u64)
}

/// The current highest captured-email id (0 if none exist yet). Correlation
/// snapshots this before firing a request, then selects ids strictly greater
/// (`between_captured_emails`).
pub async fn current_max_email_id(pool: &SqlitePool) -> Result<u64, String> {
    let row = sqlx::query("SELECT COALESCE(MAX(id), 0) as id FROM captured_emails")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("failed to read current max captured email id: {e}"))?;
    Ok(row.get::<i64, _>("id") as u64)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SmtpStatus {
    pub listening: bool,
    pub port: u16,
    pub error: Option<String>,
}

/// Tauri-managed email state: just the catcher's health. The inbox itself
/// lives in SQLite now (see the functions above), not here.
pub struct EmailState {
    status: Mutex<SmtpStatus>,
}

impl EmailState {
    pub fn new() -> Self {
        Self { status: Mutex::new(SmtpStatus { listening: false, port: DEFAULT_SMTP_PORT, error: None }) }
    }

    pub fn status(&self) -> SmtpStatus {
        match self.status.lock() {
            Ok(s) => s.clone(),
            Err(_) => SmtpStatus {
                listening: false,
                port: DEFAULT_SMTP_PORT,
                error: Some("SMTP status unavailable".to_string()),
            },
        }
    }

    pub fn set_status(&self, next: SmtpStatus) {
        if let Ok(mut s) = self.status.lock() {
            *s = next;
        }
    }
}

impl Default for EmailState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_db::LocalDb;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    const SIMPLE: &str = "Subject: Order confirmation #8841\r\n\
                          From: orders@shop.test\r\n\
                          To: customer@example.com\r\n\
                          \r\n\
                          Thanks for your order, Jamie.\r\n";

    #[test]
    fn parses_the_subject_and_a_plain_text_body() {
        let parsed = parse_captured(SIMPLE);
        assert_eq!(parsed.subject, "Order confirmation #8841");
        assert!(parsed.text_body.unwrap().contains("Thanks for your order"));
        assert_eq!(parsed.html_body, None);
    }

    #[test]
    fn parses_an_html_body_out_of_a_multipart_message() {
        let raw = "Subject: Welcome\r\n\
                   Content-Type: multipart/alternative; boundary=b1\r\n\
                   \r\n\
                   --b1\r\n\
                   Content-Type: text/plain\r\n\
                   \r\n\
                   plain version\r\n\
                   --b1\r\n\
                   Content-Type: text/html\r\n\
                   \r\n\
                   <h1>html version</h1>\r\n\
                   --b1--\r\n";
        let parsed = parse_captured(raw);
        assert_eq!(parsed.subject, "Welcome");
        assert!(parsed.text_body.unwrap().contains("plain version"));
        assert!(parsed.html_body.unwrap().contains("<h1>html version</h1>"));
    }

    #[test]
    fn a_message_with_no_subject_header_is_labelled_not_dropped() {
        let parsed = parse_captured("From: a@b.test\r\n\r\nbody only\r\n");
        assert_eq!(parsed.subject, "(no subject)");
    }

    #[tokio::test]
    async fn inserts_and_lists_a_captured_email_newest_first() {
        let (_dir, db) = db().await;
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();
        insert_captured_email(&db.pool, "c@x.test", &["d@y.test".into()], SIMPLE, 2_000).await.unwrap();

        let result = list_captured_emails(&db.pool, None, 10).await.unwrap();
        assert_eq!(result.emails.len(), 2);
        assert_eq!(result.emails[0].from, "c@x.test", "newest first");
        assert_eq!(result.evicted_through_id, 0);
    }

    #[tokio::test]
    async fn get_returns_the_full_message_including_raw_source() {
        let (_dir, db) = db().await;
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();
        let id = list_captured_emails(&db.pool, None, 10).await.unwrap().emails[0].id;

        let full = get_captured_email(&db.pool, id).await.unwrap().unwrap();
        assert_eq!(full.subject, "Order confirmation #8841");
        assert_eq!(full.to, vec!["b@y.test".to_string()]);
        assert!(full.raw.contains("Thanks for your order"));
        assert_eq!(full.size_bytes, SIMPLE.len());
    }

    #[tokio::test]
    async fn a_freshly_captured_email_has_no_request_id() {
        let (_dir, db) = db().await;
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();
        let id = list_captured_emails(&db.pool, None, 10).await.unwrap().emails[0].id;
        assert_eq!(get_captured_email(&db.pool, id).await.unwrap().unwrap().request_id, None);
    }

    #[tokio::test]
    async fn a_captured_email_linked_to_a_request_carries_its_method_and_url() {
        use crate::commands::history::{save_history_entry_impl, HistoryEntryInput};

        let (_dir, db) = db().await;
        let history_id = save_history_entry_impl(
            &db.pool,
            HistoryEntryInput {
                method: "POST".to_string(),
                url: "/api/checkout".to_string(),
                status_code: 201,
                response_body: "{}".to_string(),
                duration_ms: 12,
                session_id: None,
            },
        )
        .await
        .unwrap();

        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();
        let id = list_captured_emails(&db.pool, None, 10).await.unwrap().emails[0].id;
        sqlx::query("UPDATE captured_emails SET request_id = ? WHERE id = ?")
            .bind(&history_id)
            .bind(id as i64)
            .execute(&db.pool)
            .await
            .unwrap();

        let full = get_captured_email(&db.pool, id).await.unwrap().unwrap();
        assert_eq!(full.request_id.as_deref(), Some(history_id.as_str()));
        assert_eq!(full.request_method.as_deref(), Some("POST"));
        assert_eq!(full.request_url.as_deref(), Some("/api/checkout"));
    }

    #[tokio::test]
    async fn an_unlinked_captured_email_has_no_request_method_or_url() {
        let (_dir, db) = db().await;
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();
        let id = list_captured_emails(&db.pool, None, 10).await.unwrap().emails[0].id;

        let full = get_captured_email(&db.pool, id).await.unwrap().unwrap();
        assert_eq!(full.request_method, None);
        assert_eq!(full.request_url, None);
    }

    #[tokio::test]
    async fn get_returns_none_for_a_missing_id() {
        let (_dir, db) = db().await;
        assert_eq!(get_captured_email(&db.pool, 9_999).await.unwrap(), None);
    }

    #[tokio::test]
    async fn captures_the_currently_active_session_at_insert_time() {
        use crate::commands::sessions::create_session_impl;
        use crate::commands::settings::set_setting_impl;

        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        set_setting_impl(&db.pool, "active_session_id", &session.id).await.unwrap();

        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();

        let scoped = list_captured_emails(&db.pool, Some(&session.id), 10).await.unwrap();
        assert_eq!(scoped.emails.len(), 1);
    }

    #[tokio::test]
    async fn with_no_active_session_captured_mail_lands_unattributed() {
        let (_dir, db) = db().await;
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();

        let all = list_captured_emails(&db.pool, None, 10).await.unwrap();
        assert_eq!(all.emails.len(), 1);
    }

    #[tokio::test]
    async fn listing_with_no_session_filter_returns_every_email_not_just_unattributed_ones() {
        use crate::commands::sessions::create_session_impl;
        use crate::commands::settings::set_setting_impl;

        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        set_setting_impl(&db.pool, "active_session_id", &session.id).await.unwrap();
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();

        let unscoped = list_captured_emails(&db.pool, None, 10).await.unwrap();
        assert_eq!(unscoped.emails.len(), 1, "a session-tagged row must still show up in the unscoped view");
    }

    #[tokio::test]
    async fn listing_scoped_to_one_session_excludes_another_sessions_mail() {
        use crate::commands::sessions::create_session_impl;
        use crate::commands::settings::set_setting_impl;

        let (_dir, db) = db().await;
        let a = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        let b = create_session_impl(&db.pool, "Checkout", None).await.unwrap();

        set_setting_impl(&db.pool, "active_session_id", &a.id).await.unwrap();
        insert_captured_email(&db.pool, "in-a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();

        set_setting_impl(&db.pool, "active_session_id", &b.id).await.unwrap();
        insert_captured_email(&db.pool, "in-b@x.test", &["b@y.test".into()], SIMPLE, 2_000).await.unwrap();

        let in_a = list_captured_emails(&db.pool, Some(&a.id), 10).await.unwrap();
        assert_eq!(in_a.emails.len(), 1);
        assert_eq!(in_a.emails[0].from, "in-a@x.test");

        let in_b = list_captured_emails(&db.pool, Some(&b.id), 10).await.unwrap();
        assert_eq!(in_b.emails.len(), 1);
        assert_eq!(in_b.emails[0].from, "in-b@x.test");
    }

    #[tokio::test]
    async fn clear_with_no_session_filter_empties_every_row() {
        let (_dir, db) = db().await;
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();

        clear_captured_emails(&db.pool, None).await.unwrap();

        assert_eq!(list_captured_emails(&db.pool, None, 10).await.unwrap().emails.len(), 0);
    }

    #[tokio::test]
    async fn clear_scoped_to_a_session_leaves_other_sessions_mail_untouched() {
        use crate::commands::sessions::create_session_impl;
        use crate::commands::settings::set_setting_impl;

        let (_dir, db) = db().await;
        let a = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        let b = create_session_impl(&db.pool, "Checkout", None).await.unwrap();

        set_setting_impl(&db.pool, "active_session_id", &a.id).await.unwrap();
        insert_captured_email(&db.pool, "in-a@x.test", &["x@y.test".into()], SIMPLE, 1_000).await.unwrap();
        set_setting_impl(&db.pool, "active_session_id", &b.id).await.unwrap();
        insert_captured_email(&db.pool, "in-b@x.test", &["x@y.test".into()], SIMPLE, 2_000).await.unwrap();

        clear_captured_emails(&db.pool, Some(&a.id)).await.unwrap();

        assert_eq!(list_captured_emails(&db.pool, Some(&a.id), 10).await.unwrap().emails.len(), 0);
        assert_eq!(list_captured_emails(&db.pool, Some(&b.id), 10).await.unwrap().emails.len(), 1);
    }

    // Regression test: clearing must advance the high-water mark, not just
    // delete rows — otherwise an in-flight window whose `from_email_id`
    // predates the clear reports `emails: Some([])` instead of truncation, a
    // false negative.
    #[tokio::test]
    async fn clearing_advances_the_eviction_mark_so_an_open_window_can_detect_it() {
        let (_dir, db) = db().await;
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();
        let id = list_captured_emails(&db.pool, None, 10).await.unwrap().emails[0].id;

        clear_captured_emails(&db.pool, None).await.unwrap();

        assert_eq!(
            evicted_through_id(&db.pool).await.unwrap(),
            id,
            "clearing must advance the mark to the highest id it deleted, not just delete rows"
        );
    }

    #[tokio::test]
    async fn clearing_an_empty_inbox_leaves_the_eviction_mark_untouched() {
        let (_dir, db) = db().await;
        clear_captured_emails(&db.pool, None).await.unwrap();
        assert_eq!(evicted_through_id(&db.pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn ids_are_never_reused_after_clearing() {
        let (_dir, db) = db().await;
        insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000).await.unwrap();
        let first_id = list_captured_emails(&db.pool, None, 10).await.unwrap().emails[0].id;

        clear_captured_emails(&db.pool, None).await.unwrap();
        insert_captured_email(&db.pool, "c@x.test", &["d@y.test".into()], SIMPLE, 2_000).await.unwrap();
        let second_id = list_captured_emails(&db.pool, None, 10).await.unwrap().emails[0].id;

        assert!(second_id > first_id, "AUTOINCREMENT must never reuse a row's id");
    }

    #[tokio::test]
    async fn eviction_past_a_cap_drops_the_oldest_row_and_records_how_far() {
        let (_dir, db) = db().await;
        for i in 0..3 {
            insert_captured_email(&db.pool, "a@x.test", &["b@y.test".into()], SIMPLE, 1_000 + i).await.unwrap();
        }
        // Exercises the same eviction logic `insert_captured_email` uses in
        // production, with a cap small enough to test without inserting
        // thousands of rows.
        evict_overflow(&db.pool, 2).await.unwrap();

        let result = list_captured_emails(&db.pool, None, 10).await.unwrap();
        assert_eq!(result.emails.len(), 2);
        assert_eq!(result.evicted_through_id, 1);
    }

    #[tokio::test]
    async fn a_new_email_state_reports_not_listening_until_the_catcher_binds() {
        let state = EmailState::new();
        let status = state.status();
        assert!(!status.listening);
        assert_eq!(status.error, None);
    }

    #[tokio::test]
    async fn a_bind_failure_is_recorded_as_status_rather_than_being_thrown_away() {
        let state = EmailState::new();
        state.set_status(SmtpStatus {
            listening: false,
            port: DEFAULT_SMTP_PORT,
            error: Some("SMTP port 1025 is unavailable".to_string()),
        });
        let status = state.status();
        assert!(!status.listening);
        assert!(status.error.unwrap().contains("1025"));
    }
}
