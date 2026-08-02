# DevBench Email Capture v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move captured outbound mail from an in-memory, 200-message ring buffer to a persisted, session-scoped SQLite table, with a durable link from a request to the emails it sent.

**Architecture:** A new `captured_emails` table (integer autoincrement id, nullable `session_id`/`request_id`) replaces `EmailState`'s in-memory `VecDeque`. The SMTP catcher writes to it synchronously via `tauri::async_runtime::block_on`, bridging its blocking thread to the async `SqlitePool` the same way `main.rs`'s `.setup()` already bridges for `LocalDb::connect`. Correlation's request↔email link is filled in after the fact by threading the already-generated `request_history` id through the existing two-call correlation flow, with no new timing logic.

**Tech Stack:** Rust (`sqlx` 0.8 / SQLite, `tauri` 2.0, `mailin-embedded`), TypeScript/React (Vitest + Testing Library).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-devbench-email-capture-design.md` — every task below implements a section of it; read it first if anything here is ambiguous.
- Mockup: `docs/mockups/devbench-email-capture.html` — the UI tasks (7, 12, 13) should match its layout/copy.
- Global retention cap: **5,000** rows (`MAX_CAPTURED_EMAILS`), evicted oldest-first, table-wide (not per-session).
- `captured_emails.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` — never `TEXT`/UUID. Correlation depends on numeric ordering.
- `list_emails`/`clear_emails` share identical session-scoping semantics: `Some(id)` filters to that session; `None` means **every row, unscoped** (matching `list_history_impl`'s established behavior) — never `session_id IS NULL`.
- All Rust tests use the existing `tempfile::tempdir()` + `LocalDb::connect(...)` pattern already used in `commands/history.rs` and `commands/settings.rs` tests — never a mocked pool.
- Run `bun run test` from `apps/devbench` for frontend tests; `cargo test` from `apps/devbench/src-tauri` for Rust tests, after each task.
- Comments stay sparse — only non-obvious rationale, per this repo's established style.

## File Structure

| File | Change |
|---|---|
| `src-tauri/migrations/0004_captured_emails.sql` | Create — schema |
| `src-tauri/src/email_state.rs` | Rewrite — VecDeque store → SQL-backed functions |
| `src-tauri/src/smtp_catcher.rs` | Modify — `CatcherHandler` takes `SqlitePool`, not `Arc<Mutex<EmailStore>>` |
| `src-tauri/src/commands/email.rs` | Modify — session-scoped list/get/clear |
| `src-tauri/src/commands/correlation.rs` | Modify — pool-threading (Task 4), then `history_id` linkage (Task 9) |
| `src-tauri/src/commands/history.rs` | Modify — `save_history_entry_impl` returns the generated id |
| `src-tauri/src/main.rs` | Modify — wire the SQLite pool to the catcher instead of the old store |
| `src/lib/tauri.ts` | Modify — types/wrappers for the above |
| `src/components/email/EmailTab.tsx` | Modify — session id + eviction count + `onOpenHistory` |
| `src/components/email/EmailInbox.tsx` | Modify — filter input, eviction footer |
| `src/components/email/EmailInbox.test.tsx` | Modify — new prop, new tests |
| `src/components/email/EmailViewer.tsx` | Modify — "Sent by" chip |
| `src/components/email/EmailViewer.test.tsx` | Modify — new tests (additive only) |
| `src/components/api/ApiTab.tsx` | Modify — thread `history_id`, accept `focusHistoryId` |
| `src/components/api/HistorySidebar.tsx` | Modify — `focusId` prop |
| `src/components/api/HistorySidebar.test.tsx` | Modify — new tests (additive only) |
| `src/components/shell/SplitContent.tsx` | Modify — thread `historyFocusId`/`onOpenHistory` |
| `src/components/shell/ToolPane.tsx` | Modify — thread `historyFocusId`/`onOpenHistory` |
| `src/App.tsx` | Modify — new `historyFocusId` state |

---

# Phase 1 — Persistence core

Delivers a fully working, testable feature on its own: captured mail survives restart, is session-scoped, and eviction is visible. Correlation continues to work exactly as it does today — just reading from SQL instead of memory.

### Task 1: Migration + persisted email store

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0004_captured_emails.sql`
- Modify: `apps/devbench/src-tauri/src/email_state.rs` (full rewrite)

**Interfaces:**
- Produces (used by every later task):
  ```rust
  pub const DEFAULT_SMTP_PORT: u16;              // unchanged
  pub const MAX_CAPTURED_EMAILS: i64;            // = 5_000, replaces MAX_INBOX_MESSAGES

  pub struct CapturedEmail { id: u64, captured_at_ms: i64, from: String, to: Vec<String>,
      subject: String, html_body: Option<String>, text_body: Option<String>, raw: String,
      size_bytes: usize, request_id: Option<String> }
  pub struct EmailSummary { id: u64, captured_at_ms: i64, from: String, to: Vec<String>,
      subject: String, size_bytes: usize }
  pub struct ListEmailsResult { emails: Vec<EmailSummary>, evicted_through_id: u64 }
  pub struct ParsedEmail { subject: String, html_body: Option<String>, text_body: Option<String> }
  pub fn parse_captured(raw: &str) -> ParsedEmail;                                    // unchanged

  pub async fn insert_captured_email(pool: &SqlitePool, from: &str, to: &[String], raw: &str, captured_at_ms: i64) -> Result<(), String>;
  pub async fn list_captured_emails(pool: &SqlitePool, session_id: Option<&str>, limit: i64) -> Result<ListEmailsResult, String>;
  pub async fn get_captured_email(pool: &SqlitePool, id: u64) -> Result<Option<CapturedEmail>, String>;
  pub async fn clear_captured_emails(pool: &SqlitePool, session_id: Option<&str>) -> Result<(), String>;
  pub async fn between_captured_emails(pool: &SqlitePool, after_id: u64, captured_before_or_at_ms: i64) -> Result<Vec<EmailSummary>, String>;
  pub async fn evicted_through_id(pool: &SqlitePool) -> Result<u64, String>;
  pub async fn current_max_email_id(pool: &SqlitePool) -> Result<u64, String>;

  pub struct SmtpStatus { listening: bool, port: u16, error: Option<String> }   // unchanged
  pub struct EmailState { /* status only */ }
  impl EmailState { pub fn new() -> Self; pub fn status(&self) -> SmtpStatus; pub fn set_status(&self, next: SmtpStatus); }
  ```
  Note: `EmailState::store()` is **removed** — every later task that used it now takes a `&SqlitePool` directly.

- [ ] **Step 1: Write the migration**

```sql
-- apps/devbench/src-tauri/migrations/0004_captured_emails.sql
CREATE TABLE captured_emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  request_id   TEXT REFERENCES request_history(id) ON DELETE SET NULL,
  captured_at  INTEGER NOT NULL,
  from_addr    TEXT NOT NULL,
  to_addrs     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  html_body    TEXT,
  text_body    TEXT,
  raw          TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL
);

CREATE INDEX idx_captured_emails_session ON captured_emails (session_id, captured_at DESC);
CREATE INDEX idx_captured_emails_request ON captured_emails (request_id);

CREATE TABLE captured_emails_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  evicted_through_id  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO captured_emails_state (id, evicted_through_id) VALUES (1, 0);
```

- [ ] **Step 2: Write the failing tests**

Replace the entire contents of `email_state.rs` with:

```rust
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
    /// `None` unless a correlated request's window observed this email
    /// (Task 9 is what ever sets this to `Some`).
    pub request_id: Option<String>,
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
        "SELECT id, captured_at, from_addr, to_addrs, subject, html_body, text_body, raw, size_bytes, request_id \
         FROM captured_emails WHERE id = ?",
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
    }))
}

/// Uses the SAME scoping semantics as `list_captured_emails` — deliberately.
/// If clearing used a narrower scope than listing (e.g. only
/// `session_id IS NULL` when unscoped), "Clear inbox" with no active session
/// would leave most of what's on screen untouched.
pub async fn clear_captured_emails(pool: &SqlitePool, session_id: Option<&str>) -> Result<(), String> {
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

/// The id the NEXT captured message would receive. Correlation snapshots this
/// before firing a request, then selects ids strictly greater (`between_captured_emails`).
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
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test email_state:: -- --test-threads=1`
Expected: all tests in `email_state.rs` PASS. (`--test-threads=1` avoids unrelated flakiness from unrelated parallel Postgres-dependent tests elsewhere in the crate; this file's tests are all self-contained SQLite.)

- [ ] **Step 4: Commit**

```bash
git add apps/devbench/src-tauri/migrations/0004_captured_emails.sql apps/devbench/src-tauri/src/email_state.rs
git commit -m "feat(devbench): persist captured emails in SQLite, session-scoped"
```

---

### Task 2: SMTP catcher writes to SQLite

**Files:**
- Modify: `apps/devbench/src-tauri/src/smtp_catcher.rs` (full rewrite)

**Interfaces:**
- Consumes: `email_state::insert_captured_email` (Task 1).
- Produces: `pub fn serve(listener: TcpListener, pool: SqlitePool) -> Result<(), String>` — signature changed from `(listener, Arc<Mutex<EmailStore>>)`. `CatcherHandler::new(pool: SqlitePool)` likewise changed.

- [ ] **Step 1: Replace the file**

```rust
use mailin_embedded::response::{self, Response};
use mailin_embedded::{Handler, Server, SslConfig};
use sqlx::SqlitePool;
use std::io;
use std::net::{IpAddr, TcpListener};

use crate::email_state::insert_captured_email;

/// Ceiling on one captured message. Checked INSIDE `Handler::data`.
pub const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;

/// Binds the catcher's socket, separately from `serve`, so a port conflict
/// surfaces as an ordinary `Result` at app startup.
pub fn bind(port: u16) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        format!("SMTP port {port} is unavailable ({e}) — another catcher (Mailhog/Mailpit) may be running")
    })
}

/// Runs the SMTP server. BLOCKS FOREVER — call on a dedicated thread.
pub fn serve(listener: TcpListener, pool: SqlitePool) -> Result<(), String> {
    let handler = CatcherHandler::new(pool);
    let mut server = Server::new(handler);
    server
        .with_name("devbench")
        .with_ssl(SslConfig::None)
        .map_err(|e| format!("failed to configure SMTP server: {e}"))?;
    server.with_tcp_listener(listener);
    server.serve().map_err(|e| format!("SMTP server stopped: {e}"))
}

#[derive(Clone)]
pub struct CatcherHandler {
    pool: SqlitePool,
    from: String,
    to: Vec<String>,
    data: Vec<u8>,
    overflowed: bool,
}

impl CatcherHandler {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool, from: String::new(), to: Vec::new(), data: Vec::new(), overflowed: false }
    }
}

impl Handler for CatcherHandler {
    fn helo(&mut self, _ip: IpAddr, _domain: &str) -> Response {
        response::OK
    }

    fn mail(&mut self, _ip: IpAddr, _domain: &str, from: &str) -> Response {
        self.from = from.to_string();
        response::OK
    }

    fn rcpt(&mut self, _to: &str) -> Response {
        response::OK
    }

    fn data_start(&mut self, _domain: &str, from: &str, _is8bit: bool, to: &[String]) -> Response {
        self.from = from.to_string();
        self.to = to.to_vec();
        self.data.clear();
        self.overflowed = false;
        response::OK
    }

    fn data(&mut self, buf: &[u8]) -> io::Result<()> {
        if self.overflowed {
            return Ok(());
        }
        if self.data.len() + buf.len() > MAX_MESSAGE_BYTES {
            self.overflowed = true;
            self.data.clear();
            self.data.shrink_to_fit();
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("message exceeds the {MAX_MESSAGE_BYTES}-byte limit"),
            ));
        }
        self.data.extend_from_slice(buf);
        Ok(())
    }

    fn data_end(&mut self) -> Response {
        if self.overflowed {
            return response::INTERNAL_ERROR;
        }
        let bytes = std::mem::take(&mut self.data);
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let captured_at_ms = chrono::Utc::now().timestamp_millis();

        // `mailin-embedded` calls every Handler method synchronously from
        // this blocking OS thread. `insert_captured_email` is async (it goes
        // through the SQLite pool), so this bridges exactly the way
        // `main.rs`'s synchronous `.setup()` closure already bridges to
        // async for `LocalDb::connect` — `tauri::async_runtime::block_on`
        // manages its own runtime independently of the caller's, so it
        // works from a foreign, non-tokio thread like this one.
        match tauri::async_runtime::block_on(insert_captured_email(
            &self.pool,
            &self.from,
            &self.to,
            &raw,
            captured_at_ms,
        )) {
            Ok(()) => response::OK,
            // A failed write is better rejected than silently dropped: the
            // sending backend sees a failure it can log, rather than
            // DevBench claiming zero mail.
            Err(_) => response::INTERNAL_ERROR,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email_state::{get_captured_email, list_captured_emails};
    use crate::local_db::LocalDb;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;

    fn read_reply(reader: &mut BufReader<TcpStream>) -> String {
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).unwrap();
            if n == 0 {
                return String::new();
            }
            if line.len() >= 4 && line.as_bytes()[3] == b' ' {
                return line;
            }
        }
    }

    async fn start_catcher() -> (u16, tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let pool = db.pool.clone();
        let listener = bind(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pool_for_server = pool.clone();
        std::thread::spawn(move || {
            let _ = serve(listener, pool_for_server);
        });
        (port, dir, pool)
    }

    async fn wait_for_messages(pool: &SqlitePool, want: usize) {
        for _ in 0..100 {
            if list_captured_emails(pool, None, 10).await.unwrap().emails.len() >= want {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for {want} captured message(s)");
    }

    #[tokio::test]
    async fn catches_a_message_sent_by_a_plain_smtp_client() {
        let (port, _dir, pool) = start_catcher().await;

        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);

        assert!(read_reply(&mut reader).starts_with("220"));
        write!(writer, "EHLO tester\r\n").unwrap();
        assert!(read_reply(&mut reader).starts_with("250"));
        write!(writer, "MAIL FROM:<orders@shop.test>\r\n").unwrap();
        assert!(read_reply(&mut reader).starts_with("250"));
        write!(writer, "RCPT TO:<customer@example.com>\r\n").unwrap();
        assert!(read_reply(&mut reader).starts_with("250"));
        write!(writer, "DATA\r\n").unwrap();
        assert!(read_reply(&mut reader).starts_with("354"));
        write!(
            writer,
            "Subject: Order confirmation #8841\r\nFrom: orders@shop.test\r\n\r\nThanks for your order, Jamie.\r\n.\r\n"
        )
        .unwrap();
        assert!(read_reply(&mut reader).starts_with("250"));
        write!(writer, "QUIT\r\n").unwrap();
        let _ = read_reply(&mut reader);

        wait_for_messages(&pool, 1).await;
        let listed = list_captured_emails(&pool, None, 10).await.unwrap().emails;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].from, "orders@shop.test");
        assert_eq!(listed[0].to, vec!["customer@example.com".to_string()]);
        assert_eq!(listed[0].subject, "Order confirmation #8841");

        let full = get_captured_email(&pool, listed[0].id).await.unwrap().unwrap();
        assert!(full.text_body.unwrap().contains("Thanks for your order"));
        assert!(full.raw.contains("Subject: Order confirmation #8841"));
    }

    #[tokio::test]
    async fn captures_the_envelope_recipient_even_when_it_is_absent_from_the_headers() {
        let (port, _dir, pool) = start_catcher().await;

        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);

        let _ = read_reply(&mut reader);
        write!(writer, "EHLO tester\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "MAIL FROM:<orders@shop.test>\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "RCPT TO:<audit@shop.test>\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "DATA\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "Subject: Receipt\r\nTo: customer@example.com\r\n\r\nbody\r\n.\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "QUIT\r\n").unwrap();

        wait_for_messages(&pool, 1).await;
        let listed = list_captured_emails(&pool, None, 10).await.unwrap().emails;
        assert_eq!(listed[0].to, vec!["audit@shop.test".to_string()]);
    }

    #[test]
    fn bind_reports_a_clear_error_when_the_port_is_already_taken() {
        let first = bind(0).unwrap();
        let port = first.local_addr().unwrap().port();
        let second = bind(port);
        assert!(second.is_err());
        let message = second.unwrap_err();
        assert!(message.contains(&port.to_string()));
        assert!(message.contains("Mailhog"), "the error must tell the user what to look for");
    }

    #[tokio::test]
    async fn data_rejects_a_message_past_the_size_cap_without_buffering_it() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let mut handler = CatcherHandler::new(db.pool.clone());
        handler.data_start("tester", "a@x.test", false, &["b@y.test".to_string()]);

        let chunk = vec![b'x'; 1024 * 1024];
        let mut rejected_at = None;
        for i in 0..20 {
            if handler.data(&chunk).is_err() {
                rejected_at = Some(i);
                break;
            }
        }
        assert!(rejected_at.is_some(), "an oversized message must be rejected");
        assert!(rejected_at.unwrap() <= 10, "rejection must happen at the cap, not after 20 MiB");

        handler.data_end();
        assert_eq!(
            list_captured_emails(&db.pool, None, 10).await.unwrap().emails.len(),
            0,
            "an overflowed message is not stored"
        );
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cd apps/devbench/src-tauri && cargo test smtp_catcher:: -- --test-threads=1`
Expected: all PASS. Note: this will not yet compile standalone — `main.rs` (Task 5) still calls `smtp_catcher::serve` with the old `Arc<Mutex<EmailStore>>` signature. Run `cargo test smtp_catcher::` specifically (not the whole crate) to verify this file in isolation; the full crate build is verified at the end of Task 5.

- [ ] **Step 3: Commit**

```bash
git add apps/devbench/src-tauri/src/smtp_catcher.rs
git commit -m "feat(devbench): SMTP catcher writes directly to the persisted email store"
```

---

### Task 3: Session-scoped list/get/clear commands

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/email.rs` (full rewrite)

**Interfaces:**
- Consumes: `email_state::{list_captured_emails, get_captured_email, clear_captured_emails}` (Task 1).
- Produces: `list_emails(db, session_id: Option<String>, limit: i64) -> Result<ListEmailsResult, String>`; `get_email(db, id: u64) -> Result<CapturedEmail, String>`; `clear_emails(db, session_id: Option<String>) -> Result<(), String>`; `smtp_status` unchanged.

- [ ] **Step 1: Replace the file**

```rust
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
```

- [ ] **Step 2: Run the tests**

Run: `cd apps/devbench/src-tauri && cargo test commands::email:: -- --test-threads=1`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/email.rs
git commit -m "feat(devbench): session-scoped list/get/clear commands for captured emails"
```

---

### Task 4: Thread the SQLite pool through correlation

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`

**Interfaces:**
- Consumes: `email_state::{current_max_email_id, between_captured_emails, evicted_through_id}` (Task 1).
- Produces: `run_correlated_request_impl_with_registry(..., emails: &EmailState, db: &sqlx::SqlitePool, registry: &CorrelationRegistry, ...)` and `collect_correlation_window_impl(..., emails: &EmailState, db: &sqlx::SqlitePool, correlation_id: String, now_ms: i64)` — both gain a `db: &sqlx::SqlitePool` parameter. This is a **mechanical** change: no new behavior, `EmailState.store()` (removed in Task 1) is replaced by these pool-based calls.

- [ ] **Step 1: Update the two impl functions**

In `run_correlated_request_impl_with_registry`, replace:
```rust
let from_email_id = emails.store().lock().map(|s| s.next_id().saturating_sub(1)).unwrap_or(0);
```
with a new `db: &sqlx::SqlitePool` parameter (inserted right after `emails: &EmailState,`) and:
```rust
let from_email_id = crate::email_state::current_max_email_id(db).await.unwrap_or(0);
```

In `collect_correlation_window_impl`, add the same new `db: &sqlx::SqlitePool` parameter (right after `emails: &EmailState,`, before `correlation_id: String`) and replace:
```rust
let (captured, emails_truncated) = if emails.status().listening {
    match emails.store().lock() {
        Ok(store) => (
            Some(store.between(window.from_email_id, window.window_ends_at_ms)),
            store.evicted_through_id() > window.from_email_id,
        ),
        Err(_) => (None, false),
    }
} else {
    (None, false)
};
```
with:
```rust
let (captured, emails_truncated) = if emails.status().listening {
    match crate::email_state::between_captured_emails(db, window.from_email_id, window.window_ends_at_ms).await {
        Ok(list) => {
            let evicted = crate::email_state::evicted_through_id(db).await.unwrap_or(0);
            (Some(list), evicted > window.from_email_id)
        }
        Err(_) => (None, false),
    }
} else {
    (None, false)
};
```

- [ ] **Step 2: Update the two tauri commands**

Replace the `run_correlated_request` command body's call:
```rust
let result = run_correlated_request_impl_with_registry(
    request,
    connection,
    watched_tables,
    &logs,
    &emails,
    &registry,
    chrono::Utc::now().timestamp_millis(),
    window_ms,
)
.await?;
```
with:
```rust
let result = run_correlated_request_impl_with_registry(
    request,
    connection,
    watched_tables,
    &logs,
    &emails,
    &db.pool,
    &registry,
    chrono::Utc::now().timestamp_millis(),
    window_ms,
)
.await?;
```

Replace the `collect_correlation_window` command:
```rust
#[tauri::command]
pub async fn collect_correlation_window(
    registry: State<'_, Arc<CorrelationRegistry>>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    correlation_id: String,
) -> Result<CorrelationWindowResult, String> {
    collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        correlation_id,
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}
```
with:
```rust
#[tauri::command]
pub async fn collect_correlation_window(
    registry: State<'_, Arc<CorrelationRegistry>>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    db: State<'_, LocalDb>,
    correlation_id: String,
) -> Result<CorrelationWindowResult, String> {
    collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &db.pool,
        correlation_id,
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}
```

- [ ] **Step 3: Update the test module**

Add a `db()` helper right before `fn test_connection()` in `mod tests`:
```rust
async fn db() -> (tempfile::TempDir, LocalDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
    (dir, db)
}
```
(`LocalDb` is already in scope via `use super::*;` at the top of `mod tests`.)

Rewrite these 9 tests exactly as follows (every other test in the file — the pure diff tests, the Postgres-snapshot tests, the plain `run_correlated_request_impl` tests, and the `save_correlation_history`/history tests — is untouched by this task; none of them reference `EmailState`, `.store()`, or these two impl functions):

```rust
#[tokio::test]
async fn a_correlated_request_opens_a_window_that_can_be_collected() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = EmailState::new();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("app.log");
    std::fs::write(&log_path, "").unwrap();
    logs.add_source("app.log".into(), log_path.clone()).unwrap();
    logs.poll_all(1_000);

    let mut server = mockito::Server::new_async().await;
    let log_path_for_mock = log_path.clone();
    let mock = server
        .mock("POST", "/orders")
        .with_status(201)
        .with_body_from_request(move |_req| {
            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new().append(true).open(&log_path_for_mock).unwrap();
            writeln!(f, r#"{{"level":"info","msg":"order created id=8841"}}"#).unwrap();
            f.flush().unwrap();
            br#"{"id":8841}"#.to_vec()
        })
        .create_async()
        .await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "POST".to_string(), url: format!("{}/orders", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        10_000,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .unwrap();

    mock.assert_async().await;
    assert!(!result.correlation_id.is_empty());

    logs.poll_all(10_100);

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id.clone(),
        10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    let lines = window.log_lines.expect("a source is running, so lines must be Some");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].message, "order created id=8841");
    assert_eq!(lines[0].level.as_deref(), Some("INFO"));
    assert!(!window.log_lines_truncated);
}

#[tokio::test]
async fn collecting_a_window_with_no_log_source_reports_not_observed_rather_than_zero() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = EmailState::new();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    let mut server = mockito::Server::new_async().await;
    let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        10_000,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .unwrap();
    mock.assert_async().await;

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    assert_eq!(window.log_lines, None, "no source configured means NOT OBSERVED, not zero lines");
}

#[tokio::test]
async fn collecting_an_unknown_correlation_id_is_an_error() {
    let logs = LogState::new();
    let emails = EmailState::new();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;
    let result =
        collect_correlation_window_impl(&registry, &logs, &emails, &edb.pool, "not-a-real-id".into(), 1_000)
            .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn a_window_can_only_be_collected_once() {
    let logs = LogState::new();
    let emails = EmailState::new();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;
    let id = registry.open(0, 0, 500);

    assert!(collect_correlation_window_impl(&registry, &logs, &emails, &edb.pool, id.clone(), 1_000).await.is_ok());
    assert!(collect_correlation_window_impl(&registry, &logs, &emails, &edb.pool, id, 1_000).await.is_err());
    assert_eq!(registry.len(), 0);
}

#[tokio::test]
async fn a_correlation_window_captures_mail_sent_during_the_request() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = listening_email_state();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    let pool_for_mock = edb.pool.clone();
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/orders")
        .with_status(201)
        .with_body_from_request(move |_req| {
            // `with_body_from_request`'s closure runs synchronously on
            // mockito's own dedicated runtime thread, not this test's tokio
            // runtime — the same foreign-thread shape as the real SMTP
            // catcher, so it needs the same `block_on` bridge production
            // code uses in `smtp_catcher.rs`.
            tauri::async_runtime::block_on(crate::email_state::insert_captured_email(
                &pool_for_mock,
                "orders@shop.test",
                &["customer@example.com".to_string()],
                TEST_EMAIL,
                10_100,
            ))
            .unwrap();
            br#"{"id":8841}"#.to_vec()
        })
        .create_async()
        .await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "POST".to_string(), url: format!("{}/orders", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        10_000,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .unwrap();

    mock.assert_async().await;

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    let captured = window.emails.expect("the catcher is running, so emails must be Some");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].subject, "Order confirmation #8841");
    assert_eq!(captured[0].to, vec!["customer@example.com".to_string()]);
    assert!(!window.emails_truncated);
}

#[tokio::test]
async fn a_slow_request_does_not_shrink_its_own_correlation_window() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = listening_email_state();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    const WINDOW_MS: i64 = 100;
    const SIMULATED_BACKEND_DELAY_MS: u64 = 200;

    let pool_for_mock = edb.pool.clone();
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/orders")
        .with_status(201)
        .with_body_from_request(move |_req| {
            std::thread::sleep(std::time::Duration::from_millis(SIMULATED_BACKEND_DELAY_MS));
            let captured_at_ms = chrono::Utc::now().timestamp_millis();
            tauri::async_runtime::block_on(crate::email_state::insert_captured_email(
                &pool_for_mock,
                "orders@shop.test",
                &["customer@example.com".to_string()],
                TEST_EMAIL,
                captured_at_ms,
            ))
            .unwrap();
            br#"{"id":8841}"#.to_vec()
        })
        .create_async()
        .await;

    let started_at_ms = chrono::Utc::now().timestamp_millis();
    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "POST".to_string(), url: format!("{}/orders", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        started_at_ms,
        WINDOW_MS,
    )
    .await
    .unwrap();

    mock.assert_async().await;

    let collect_at_ms = chrono::Utc::now().timestamp_millis() + 1_000;
    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        collect_at_ms,
    )
    .await
    .unwrap();

    let captured = window.emails.expect("the catcher is running, so emails must be Some");
    assert_eq!(
        captured.len(),
        1,
        "a request that takes ~{SIMULATED_BACKEND_DELAY_MS}ms must not shrink its own \
         {WINDOW_MS}ms window relative to when the response actually came back"
    );
    assert_eq!(captured[0].subject, "Order confirmation #8841");
}

#[tokio::test]
async fn mail_sent_before_the_request_is_not_attributed_to_it() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = listening_email_state();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    crate::email_state::insert_captured_email(
        &edb.pool,
        "old@shop.test",
        &["someone@example.com".to_string()],
        TEST_EMAIL,
        5_000,
    )
    .await
    .unwrap();

    let mut server = mockito::Server::new_async().await;
    let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        10_000,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .unwrap();
    mock.assert_async().await;

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    assert_eq!(window.emails, Some(vec![]), "pre-existing mail must not be attributed to this request");
}

#[tokio::test]
async fn a_stopped_catcher_reports_emails_as_not_observed_rather_than_zero() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = EmailState::new();
    emails.set_status(crate::email_state::SmtpStatus {
        listening: false,
        port: crate::email_state::DEFAULT_SMTP_PORT,
        error: Some("SMTP port 1025 is unavailable".to_string()),
    });
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    let mut server = mockito::Server::new_async().await;
    let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        10_000,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .unwrap();
    mock.assert_async().await;

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    assert_eq!(window.emails, None, "a catcher that is not listening means NOT OBSERVED, not zero mail");
}

#[tokio::test]
async fn the_window_length_comes_from_the_caller_not_a_hardcoded_constant() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = listening_email_state();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    let pool_for_mock = edb.pool.clone();
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("GET", "/ping")
        .with_status(200)
        .with_body_from_request(move |_req| {
            tauri::async_runtime::block_on(crate::email_state::insert_captured_email(
                &pool_for_mock,
                "orders@shop.test",
                &["customer@example.com".to_string()],
                TEST_EMAIL,
                25_000,
            ))
            .unwrap();
            b"pong".to_vec()
        })
        .create_async()
        .await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        10_000,
        30_000,
    )
    .await
    .unwrap();
    mock.assert_async().await;

    let window = collect_correlation_window_impl(&registry, &logs, &emails, &edb.pool, result.correlation_id, 40_001)
        .await
        .unwrap();

    let captured = window.emails.expect("the catcher is running, so emails must be Some");
    assert_eq!(captured.len(), 1, "a real 30s window must include mail captured at 25_000");
    assert_eq!(captured[0].subject, "Order confirmation #8841");
    assert_eq!(captured[0].to, vec!["customer@example.com".to_string()]);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/devbench/src-tauri && cargo test commands::correlation:: -- --test-threads=1`
Expected: the tests requiring a real local Postgres (`test_connection()`-based ones not listed above, e.g. `snapshot_and_diff_detects_a_real_update`) will fail/skip if Postgres isn't running locally — that's pre-existing and unrelated to this task. Every test listed in Step 3, plus the pure/history-only tests, must PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/correlation.rs
git commit -m "refactor(devbench): correlation reads captured emails from SQLite, not memory"
```

---

### Task 5: Wire the pool to the catcher in main.rs

**Files:**
- Modify: `apps/devbench/src-tauri/src/main.rs:24-91`

- [ ] **Step 1: Clone the pool before it's moved into `.manage()`, and pass it to the catcher**

Replace:
```rust
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
handle.manage(db);
```
with:
```rust
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
```

Replace:
```rust
match smtp_catcher::bind(smtp_port) {
    Ok(listener) => {
        let store = emails.store();
        emails.set_status(SmtpStatus {
            listening: true,
            port: smtp_port,
            error: None,
        });
        let emails_for_thread = Arc::clone(&emails);
        std::thread::spawn(move || {
            if let Err(e) = smtp_catcher::serve(listener, store) {
                emails_for_thread.set_status(SmtpStatus {
                    listening: false,
                    port: smtp_port,
                    error: Some(e),
                });
            }
        });
    }
```
with:
```rust
match smtp_catcher::bind(smtp_port) {
    Ok(listener) => {
        emails.set_status(SmtpStatus {
            listening: true,
            port: smtp_port,
            error: None,
        });
        let emails_for_thread = Arc::clone(&emails);
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
```

- [ ] **Step 2: Build the whole crate**

Run: `cd apps/devbench/src-tauri && cargo build`
Expected: builds with no errors. This is the first point where the full crate (all of Tasks 1-5 together) must compile.

- [ ] **Step 3: Run the full Rust test suite**

Run: `cd apps/devbench/src-tauri && cargo test -- --test-threads=1`
Expected: PASS (aside from any pre-existing Postgres-dependent tests, unaffected by this plan, that were already skipping/failing without a local Postgres before this work started).

- [ ] **Step 4: Commit**

```bash
git add apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): wire the SQLite pool to the SMTP catcher at startup"
```

---

### Task 6: Frontend types and IPC wrappers

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`

**Interfaces:**
- Produces: `ListEmailsResult`, updated `invokeListEmails(sessionId, limit)`, `invokeClearEmails(sessionId)`.

- [ ] **Step 1: Update the email section of `tauri.ts`**

Replace:
```ts
export interface EmailSummary {
  id: number;
  captured_at_ms: number;
  from: string;
  to: string[];
  subject: string;
  size_bytes: number;
}

export interface CapturedEmail extends EmailSummary {
  html_body: string | null;
  text_body: string | null;
  raw: string;
}

export interface SmtpStatus {
  listening: boolean;
  port: number;
  error: string | null;
}

export function invokeListEmails(limit: number): Promise<EmailSummary[]> {
  return invoke("list_emails", { limit });
}

export function invokeGetEmail(id: number): Promise<CapturedEmail> {
  return invoke("get_email", { id });
}

export function invokeClearEmails(): Promise<void> {
  return invoke("clear_emails");
}

export function invokeSmtpStatus(): Promise<SmtpStatus> {
  return invoke("smtp_status");
}
```
with:
```ts
export interface EmailSummary {
  id: number;
  captured_at_ms: number;
  from: string;
  to: string[];
  subject: string;
  size_bytes: number;
}

export interface CapturedEmail extends EmailSummary {
  html_body: string | null;
  text_body: string | null;
  raw: string;
  /** Set once a correlated request's window observes this email. */
  request_id: string | null;
}

export interface ListEmailsResult {
  emails: EmailSummary[];
  /** Highest id ever evicted by the 5,000-message cap. 0 = nothing evicted yet. */
  evicted_through_id: number;
}

export interface SmtpStatus {
  listening: boolean;
  port: number;
  error: string | null;
}

/** `sessionId` null lists every captured email regardless of session (the unscoped view) — same convention as `invokeListHistory`. */
export function invokeListEmails(sessionId: string | null, limit: number): Promise<ListEmailsResult> {
  return invoke("list_emails", { sessionId, limit });
}

export function invokeGetEmail(id: number): Promise<CapturedEmail> {
  return invoke("get_email", { id });
}

export function invokeClearEmails(sessionId: string | null): Promise<void> {
  return invoke("clear_emails", { sessionId });
}

export function invokeSmtpStatus(): Promise<SmtpStatus> {
  return invoke("smtp_status");
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/devbench && bun run typecheck` (or `bunx tsc --noEmit` if no such script exists — check `package.json`'s `scripts` first)
Expected: errors at every call site of `invokeListEmails`/`invokeClearEmails` (they're called with the old argument shape) — that's expected and fixed in Task 7.

- [ ] **Step 3: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts
git commit -m "feat(devbench): frontend types for session-scoped, eviction-aware email listing"
```

---

### Task 7: EmailTab / EmailInbox — session wiring, filter, eviction footer

**Files:**
- Modify: `apps/devbench/src/components/email/EmailTab.tsx`
- Modify: `apps/devbench/src/components/email/EmailInbox.tsx`
- Modify: `apps/devbench/src/components/email/EmailInbox.test.tsx`

**Interfaces:**
- Consumes: `invokeListEmails`, `invokeClearEmails` (Task 6); `useAppStore((s) => s.activeSessionId)` (existing, used identically by `ApiTab.tsx:39`).
- Produces: `EmailInbox` gains a required `evictedThroughId: number` prop.

- [ ] **Step 1: Update `EmailTab.tsx`**

Replace the whole file with:
```tsx
import { useCallback, useEffect, useState } from "react";
import { EmailInbox } from "./EmailInbox";
import { EmailViewer } from "./EmailViewer";
import { useAppStore } from "../../store/useAppStore";
import {
  invokeClearEmails,
  invokeGetEmail,
  invokeListEmails,
  invokeSmtpStatus,
  type CapturedEmail,
  type EmailSummary,
  type SmtpStatus,
} from "../../lib/tauri";

/** How often the inbox is refreshed. Mail is far rarer than log lines. */
const POLL_INTERVAL_MS = 1_000;
/** Matches the backend's global retention cap (`MAX_CAPTURED_EMAILS`). */
const LIST_LIMIT = 5_000;

export function EmailTab({ focusEmailId = null }: { focusEmailId?: number | null }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [evictedThroughId, setEvictedThroughId] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<CapturedEmail | null>(null);
  const [status, setStatus] = useState<SmtpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await invokeListEmails(activeSessionId, LIST_LIMIT);
      setEmails(result.emails);
      setEvictedThroughId(result.evicted_through_id);
    } catch {
      // A transient IPC failure is not worth tearing the pane down.
    }
  }, [activeSessionId]);

  useEffect(() => {
    invokeSmtpStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (focusEmailId !== null) setSelectedId(focusEmailId);
  }, [focusEmailId]);

  useEffect(() => {
    if (selectedId === null) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    invokeGetEmail(selectedId)
      .then((full) => {
        if (!cancelled) {
          setSelected(full);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSelected(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function handleClear() {
    try {
      await invokeClearEmails(activeSessionId);
      setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="-m-6 flex h-full flex-col">
      <div className="flex flex-1 overflow-hidden">
        <EmailInbox
          emails={emails}
          evictedThroughId={evictedThroughId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onClear={handleClear}
        />
        <div className="flex-1 overflow-hidden">
          {error ? (
            <div className="m-4 rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
          ) : (
            <EmailViewer email={selected} />
          )}
        </div>
      </div>
      <div className="border-t border-border px-4 py-2 text-xs text-text-muted">
        {status === null ? (
          "Checking SMTP catcher…"
        ) : status.listening ? (
          <>
            Listening on <b className="text-text">localhost:{status.port}</b> — point your backend's SMTP
            config here.
          </>
        ) : (
          <span className="text-danger">
            SMTP catcher is not running{status.error ? `: ${status.error}` : ""}. No mail is being caught.
          </span>
        )}
      </div>
    </div>
  );
}
```

(This task deliberately does **not** change `EmailViewer`'s call above — that's Task 12. It also does not change how a `get_email` "not found" error is handled: this branch has no persisted tab-state `emailId` yet, so there is nothing stale to gracefully recover from here. That handling belongs to whichever branch adds `{ emailId }` tab-state persistence, per the design spec's note on revisiting the v2 shell's tab-state decision.)

- [ ] **Step 2: Update `EmailInbox.tsx`**

Replace the whole file with:
```tsx
import { useState } from "react";
import type { EmailSummary } from "../../lib/tauri";

function shortTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function matchesFilter(email: EmailSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    email.subject.toLowerCase().includes(q) ||
    email.from.toLowerCase().includes(q) ||
    email.to.some((addr) => addr.toLowerCase().includes(q))
  );
}

export function EmailInbox({
  emails,
  evictedThroughId,
  selectedId,
  onSelect,
  onClear,
}: {
  emails: EmailSummary[];
  evictedThroughId: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onClear: () => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered = emails.filter((email) => matchesFilter(email, filter));

  return (
    <aside className="flex w-70 min-w-70 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border p-2.5 text-xs font-bold text-text-muted">
        Inbox
        {emails.length > 0 ? (
          <button onClick={onClear} className="rounded-sm px-1.5 py-0.5 hover:bg-surface-2">
            Clear inbox
          </button>
        ) : null}
      </div>
      {emails.length > 0 ? (
        <div className="border-b border-border p-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by subject or address…"
            className="w-full rounded-sm border border-border bg-bg px-2.5 py-1.5 text-xs text-text placeholder:text-text-faint"
          />
        </div>
      ) : null}
      {emails.length === 0 ? (
        <div className="p-4 text-xs text-text-faint">
          No mail caught yet. Point your backend's SMTP host at{" "}
          <code className="font-mono">localhost</code> and the port shown below.
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-4 text-xs text-text-faint">No messages match your filter.</div>
      ) : (
        <div className="flex flex-col overflow-y-auto">
          {filtered.map((email) => (
            <button
              key={email.id}
              onClick={() => onSelect(email.id)}
              aria-current={selectedId === email.id}
              className={`flex flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left ${
                selectedId === email.id ? "bg-surface-2" : "hover:bg-surface-2"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold text-text">{email.subject}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-text-faint">
                  {shortTime(email.captured_at_ms)}
                </span>
              </div>
              <span className="truncate font-mono text-xs text-text-muted">{email.from}</span>
            </button>
          ))}
        </div>
      )}
      {evictedThroughId > 0 ? (
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-faint">
          Showing latest <b className="text-text-muted">5,000</b> —{" "}
          <b className="text-text-muted">{evictedThroughId}</b> earlier evicted
        </div>
      ) : null}
    </aside>
  );
}
```

- [ ] **Step 3: Write the new failing tests**

Replace the whole of `EmailInbox.test.tsx` with:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmailInbox } from "./EmailInbox";
import type { EmailSummary } from "../../lib/tauri";

const emails: EmailSummary[] = [
  {
    id: 2,
    captured_at_ms: 1_800_000_000_000,
    from: "orders@shop.test",
    to: ["customer@example.com"],
    subject: "Order confirmation #8841",
    size_bytes: 512,
  },
  {
    id: 1,
    captured_at_ms: 1_700_000_000_000,
    from: "hello@shop.test",
    to: ["cus_2290@example.com"],
    subject: "Welcome to the beta",
    size_bytes: 256,
  },
];

describe("EmailInbox", () => {
  it("lists subjects and senders", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText("Order confirmation #8841")).toBeInTheDocument();
    expect(screen.getByText("orders@shop.test")).toBeInTheDocument();
  });

  it("marks the selected message", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={2} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByRole("button", { name: /Order confirmation/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Welcome to the beta/ })).toHaveAttribute("aria-current", "false");
  });

  it("selects a message when clicked", () => {
    const onSelect = vi.fn();
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={onSelect} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Welcome to the beta/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("shows an empty state that explains the SMTP setup", () => {
    render(<EmailInbox emails={[]} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText(/point your backend's SMTP/i)).toBeInTheDocument();
  });

  it("clears the inbox", () => {
    const onClear = vi.fn();
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear inbox" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("filters the list by subject", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Filter by subject or address/i), { target: { value: "beta" } });
    expect(screen.getByText("Welcome to the beta")).toBeInTheDocument();
    expect(screen.queryByText("Order confirmation #8841")).not.toBeInTheDocument();
  });

  it("filters the list by sender address", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Filter by subject or address/i), {
      target: { value: "orders@shop.test" },
    });
    expect(screen.getByText("Order confirmation #8841")).toBeInTheDocument();
    expect(screen.queryByText("Welcome to the beta")).not.toBeInTheDocument();
  });

  it("says so when no message matches the filter", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Filter by subject or address/i), {
      target: { value: "nonexistent" },
    });
    expect(screen.getByText("No messages match your filter.")).toBeInTheDocument();
  });

  it("shows how many earlier messages were evicted", () => {
    render(<EmailInbox emails={emails} evictedThroughId={212} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText(/212/)).toBeInTheDocument();
    expect(screen.getByText(/earlier evicted/)).toBeInTheDocument();
  });

  it("does not show an eviction note when nothing has been evicted", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.queryByText(/earlier evicted/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run the frontend tests**

Run: `cd apps/devbench && bun run test EmailInbox`
Expected: all PASS.

- [ ] **Step 5: Type-check the whole frontend**

Run: `cd apps/devbench && bun run typecheck` (or the project's equivalent — check `package.json`)
Expected: no errors (this resolves the errors left over from Task 6, since `EmailTab.tsx` now calls the updated wrappers correctly).

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/components/email/EmailTab.tsx apps/devbench/src/components/email/EmailInbox.tsx apps/devbench/src/components/email/EmailInbox.test.tsx
git commit -m "feat(devbench): session-scoped inbox, subject/address filter, eviction footer"
```

**Phase 1 complete.** Captured mail now persists across restarts, is scoped to the active session, and eviction is visible in the UI. Verify manually: run the app, send mail via `swaks --to a@b.test --server localhost:1025 --body hi`, confirm it survives an app restart.

---

# Phase 2 — Correlation linkage + "Sent by" jump

Builds on Phase 1's schema (`request_id` column already exists from Task 1's migration). Adds the durable link and its UI.

### Task 8: `save_history_entry_impl` returns the generated id

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/history.rs`

**Interfaces:**
- Produces: `save_history_entry_impl(pool, entry) -> Result<String, String>` (was `Result<(), String>`).

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `history.rs` (the module already has a `db()` helper — reuse it):
```rust
#[tokio::test]
async fn returns_the_generated_id_so_callers_can_link_to_it_later() {
    let (_dir, db) = db().await;
    let id = save_history_entry_impl(
        &db.pool,
        HistoryEntryInput {
            method: "POST".to_string(),
            url: "/api/orders".to_string(),
            status_code: 201,
            response_body: "{}".to_string(),
            duration_ms: 12,
            session_id: None,
        },
    )
    .await
    .unwrap();

    let entries = list_history_impl(&db.pool, None).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].id, id, "the returned id must be the row's actual primary key");
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/devbench/src-tauri && cargo test commands::history::tests::returns_the_generated_id`
Expected: FAIL — compile error, `save_history_entry_impl` returns `()`, not `String`.

- [ ] **Step 3: Change the return type**

Replace:
```rust
pub async fn save_history_entry_impl(
    pool: &sqlx::SqlitePool,
    entry: HistoryEntryInput,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let fired_at = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at, session_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&entry.method)
    .bind(&entry.url)
    .bind(entry.status_code as i64)
    .bind(&entry.response_body)
    .bind(entry.duration_ms as i64)
    .bind(&fired_at)
    .bind(&entry.session_id)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to save history entry: {e}"))?;

    Ok(())
}
```
with:
```rust
pub async fn save_history_entry_impl(
    pool: &sqlx::SqlitePool,
    entry: HistoryEntryInput,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let fired_at = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at, session_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&entry.method)
    .bind(&entry.url)
    .bind(entry.status_code as i64)
    .bind(&entry.response_body)
    .bind(entry.duration_ms as i64)
    .bind(&fired_at)
    .bind(&entry.session_id)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to save history entry: {e}"))?;

    Ok(id)
}
```

And update the `save_history_entry` tauri command (its own public IPC contract stays `Result<(), String>` — nothing consumes an id from it):
```rust
#[tauri::command]
pub async fn save_history_entry(
    db: State<'_, LocalDb>,
    entry: HistoryEntryInput,
) -> Result<(), String> {
    save_history_entry_impl(&db.pool, entry).await?;
    Ok(())
}
```

- [ ] **Step 4: Run all history tests**

Run: `cd apps/devbench/src-tauri && cargo test commands::history::`
Expected: all PASS, including the new one and every pre-existing test (they all discard the return value via `.unwrap();` with no binding, so a `String` instead of `()` doesn't break them).

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/history.rs
git commit -m "feat(devbench): save_history_entry_impl returns the row's generated id"
```

---

### Task 9: Thread `history_id` through correlation and link captured emails

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`

**Interfaces:**
- Consumes: `save_history_entry_impl` returning `Result<String, String>` (Task 8).
- Produces: `CorrelationResult.history_id: Option<String>`; `collect_correlation_window_impl(..., correlation_id: String, history_id: Option<&str>, now_ms: i64)`; `collect_correlation_window` command gains a `history_id: Option<String>` parameter.

- [ ] **Step 1: `CorrelationResult` gains `history_id`**

Replace:
```rust
#[derive(Debug, Serialize)]
pub struct CorrelationResult {
    /// Handle for the second phase (`collect_correlation_window`). Filled in
    /// by Task 6; a fixed placeholder until then.
    pub correlation_id: String,
    pub response: FireRequestOutput,
    /// `None` means the DB could not be verified — never rendered as "0 writes".
    /// `Some(vec![])` means it WAS verified and nothing changed.
    pub table_diffs: Option<Vec<TableDiff>>,
    pub db_error: Option<String>,
}
```
with:
```rust
#[derive(Debug, Serialize)]
pub struct CorrelationResult {
    /// Handle for the second phase (`collect_correlation_window`).
    pub correlation_id: String,
    pub response: FireRequestOutput,
    /// `None` means the DB could not be verified — never rendered as "0 writes".
    /// `Some(vec![])` means it WAS verified and nothing changed.
    pub table_diffs: Option<Vec<TableDiff>>,
    pub db_error: Option<String>,
    /// The `request_history` row's id, once saved — `None` only if that save
    /// itself failed. Threaded into `collect_correlation_window` so it can
    /// attach `request_id` to whichever captured emails the window observes.
    pub history_id: Option<String>,
}
```

In `run_correlated_request_impl`, replace:
```rust
    Ok(CorrelationResult {
        correlation_id: String::new(),
        response,
        table_diffs,
        db_error,
    })
```
with:
```rust
    Ok(CorrelationResult {
        correlation_id: String::new(),
        response,
        table_diffs,
        db_error,
        history_id: None,
    })
```

- [ ] **Step 2: `save_correlation_history` returns the id it saved**

Replace:
```rust
async fn save_correlation_history(
    pool: &sqlx::SqlitePool,
    method: &str,
    url: &str,
    response: &FireRequestOutput,
    session_id: Option<&str>,
) {
    let entry = HistoryEntryInput {
        method: method.to_string(),
        url: url.to_string(),
        status_code: response.status_code,
        response_body: response.body.clone(),
        duration_ms: response.duration_ms,
        session_id: session_id.map(str::to_string),
    };
    if let Err(e) = save_history_entry_impl(pool, entry).await {
        eprintln!("failed to save request history entry after a successful correlated request: {e}");
    }
}
```
with:
```rust
async fn save_correlation_history(
    pool: &sqlx::SqlitePool,
    method: &str,
    url: &str,
    response: &FireRequestOutput,
    session_id: Option<&str>,
) -> Option<String> {
    let entry = HistoryEntryInput {
        method: method.to_string(),
        url: url.to_string(),
        status_code: response.status_code,
        response_body: response.body.clone(),
        duration_ms: response.duration_ms,
        session_id: session_id.map(str::to_string),
    };
    match save_history_entry_impl(pool, entry).await {
        Ok(id) => Some(id),
        Err(e) => {
            eprintln!("failed to save request history entry after a successful correlated request: {e}");
            None
        }
    }
}
```

- [ ] **Step 3: `run_correlated_request` command records the id**

Replace:
```rust
    let result = run_correlated_request_impl_with_registry(
        request,
        connection,
        watched_tables,
        &logs,
        &emails,
        &db.pool,
        &registry,
        chrono::Utc::now().timestamp_millis(),
        window_ms,
    )
    .await?;
    save_correlation_history(&db.pool, &method, &url, &result.response, session_id.as_deref()).await;
    Ok(result)
```
with:
```rust
    let mut result = run_correlated_request_impl_with_registry(
        request,
        connection,
        watched_tables,
        &logs,
        &emails,
        &db.pool,
        &registry,
        chrono::Utc::now().timestamp_millis(),
        window_ms,
    )
    .await?;
    result.history_id =
        save_correlation_history(&db.pool, &method, &url, &result.response, session_id.as_deref()).await;
    Ok(result)
```

- [ ] **Step 4: `collect_correlation_window_impl` links captured emails**

Replace:
```rust
pub async fn collect_correlation_window_impl(
    registry: &CorrelationRegistry,
    logs: &crate::log_state::LogState,
    emails: &EmailState,
    db: &sqlx::SqlitePool,
    correlation_id: String,
    now_ms: i64,
) -> Result<CorrelationWindowResult, String> {
    let window = registry
        .take(&correlation_id)
        .ok_or_else(|| format!("no open correlation window with id {correlation_id}"))?;

    let remaining_ms = window.window_ends_at_ms - now_ms;
    if remaining_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(remaining_ms as u64)).await;
    }

    let log_lines = logs.collect_window(window.from_log_id, window.window_ends_at_ms);
    let log_lines_truncated = log_lines.is_some()
        && logs.read_since(window.from_log_id, None, 1).dropped > 0;

    let (captured, emails_truncated) = if emails.status().listening {
        match crate::email_state::between_captured_emails(db, window.from_email_id, window.window_ends_at_ms).await {
            Ok(list) => {
                let evicted = crate::email_state::evicted_through_id(db).await.unwrap_or(0);
                (Some(list), evicted > window.from_email_id)
            }
            Err(_) => (None, false),
        }
    } else {
        (None, false)
    };

    Ok(CorrelationWindowResult {
        log_lines,
        log_lines_truncated,
        emails: captured,
        emails_truncated,
    })
}
```
with:
```rust
pub async fn collect_correlation_window_impl(
    registry: &CorrelationRegistry,
    logs: &crate::log_state::LogState,
    emails: &EmailState,
    db: &sqlx::SqlitePool,
    correlation_id: String,
    history_id: Option<&str>,
    now_ms: i64,
) -> Result<CorrelationWindowResult, String> {
    let window = registry
        .take(&correlation_id)
        .ok_or_else(|| format!("no open correlation window with id {correlation_id}"))?;

    let remaining_ms = window.window_ends_at_ms - now_ms;
    if remaining_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(remaining_ms as u64)).await;
    }

    let log_lines = logs.collect_window(window.from_log_id, window.window_ends_at_ms);
    let log_lines_truncated = log_lines.is_some()
        && logs.read_since(window.from_log_id, None, 1).dropped > 0;

    let (captured, emails_truncated) = if emails.status().listening {
        match crate::email_state::between_captured_emails(db, window.from_email_id, window.window_ends_at_ms).await {
            Ok(list) => {
                let evicted = crate::email_state::evicted_through_id(db).await.unwrap_or(0);
                (Some(list), evicted > window.from_email_id)
            }
            Err(_) => (None, false),
        }
    } else {
        (None, false)
    };

    // Persist the link now that both halves are known: which request (via
    // `history_id`, saved right after the response) sent which emails (via
    // `captured`, only known once the window closes). Neither the timing
    // above nor the None-vs-Some(vec![]) semantics are touched by this.
    if let (Some(hid), Some(list)) = (history_id, &captured) {
        if !list.is_empty() {
            let ids: Vec<i64> = list.iter().map(|e| e.id as i64).collect();
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("UPDATE captured_emails SET request_id = ? WHERE id IN ({placeholders})");
            let mut q = sqlx::query(&sql).bind(hid);
            for id in &ids {
                q = q.bind(id);
            }
            if let Err(e) = q.execute(db).await {
                eprintln!("failed to link captured emails to request {hid}: {e}");
            }
        }
    }

    Ok(CorrelationWindowResult {
        log_lines,
        log_lines_truncated,
        emails: captured,
        emails_truncated,
    })
}
```

- [ ] **Step 5: `collect_correlation_window` command gains `history_id`**

Replace:
```rust
#[tauri::command]
pub async fn collect_correlation_window(
    registry: State<'_, Arc<CorrelationRegistry>>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    db: State<'_, LocalDb>,
    correlation_id: String,
) -> Result<CorrelationWindowResult, String> {
    collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &db.pool,
        correlation_id,
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}
```
with:
```rust
#[tauri::command]
pub async fn collect_correlation_window(
    registry: State<'_, Arc<CorrelationRegistry>>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    db: State<'_, LocalDb>,
    correlation_id: String,
    history_id: Option<String>,
) -> Result<CorrelationWindowResult, String> {
    collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &db.pool,
        correlation_id,
        history_id.as_deref(),
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}
```

- [ ] **Step 6: Update every `collect_correlation_window_impl` call from Task 4**

Every call to `collect_correlation_window_impl` written in Task 4 now takes one more argument — that's **10 call sites across 9 tests**: one call each in `a_correlated_request_opens_a_window_that_can_be_collected`, `collecting_a_window_with_no_log_source_reports_not_observed_rather_than_zero`, `collecting_an_unknown_correlation_id_is_an_error`, `a_correlation_window_captures_mail_sent_during_the_request`, `a_slow_request_does_not_shrink_its_own_correlation_window`, `mail_sent_before_the_request_is_not_attributed_to_it`, `a_stopped_catcher_reports_emails_as_not_observed_rather_than_zero`, and `the_window_length_comes_from_the_caller_not_a_hardcoded_constant` — **and two calls** in `a_window_can_only_be_collected_once` (it collects the same window twice, once successfully and once to confirm the second collection errors; both calls need the new argument). Insert `None,` as the new parameter, positioned right after the `correlation_id` argument and right before the trailing `now_ms`/timestamp argument, at every one of these 10 call sites. For example, in `collecting_an_unknown_correlation_id_is_an_error`, this line:
```rust
    let result =
        collect_correlation_window_impl(&registry, &logs, &emails, &edb.pool, "not-a-real-id".into(), 1_000)
            .await;
```
becomes:
```rust
    let result =
        collect_correlation_window_impl(&registry, &logs, &emails, &edb.pool, "not-a-real-id".into(), None, 1_000)
            .await;
```
— the same single-token insertion applies at every other call site listed above.

- [ ] **Step 7: Write the two new linkage tests**

Add to `mod tests`:
```rust
#[tokio::test]
async fn a_completed_window_links_its_captured_emails_to_the_request_that_sent_them() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = listening_email_state();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    let pool_for_mock = edb.pool.clone();
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/orders")
        .with_status(201)
        .with_body_from_request(move |_req| {
            tauri::async_runtime::block_on(crate::email_state::insert_captured_email(
                &pool_for_mock,
                "orders@shop.test",
                &["customer@example.com".to_string()],
                TEST_EMAIL,
                10_100,
            ))
            .unwrap();
            br#"{"id":8841}"#.to_vec()
        })
        .create_async()
        .await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "POST".to_string(), url: format!("{}/orders", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        10_000,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .unwrap();
    mock.assert_async().await;

    let history_id = save_correlation_history(&edb.pool, "POST", "/orders", &result.response, None).await;

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        history_id.as_deref(),
        10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    let captured = window.emails.expect("the catcher is running, so emails must be Some");
    assert_eq!(captured.len(), 1);

    let linked = crate::email_state::get_captured_email(&edb.pool, captured[0].id).await.unwrap().unwrap();
    assert_eq!(linked.request_id, history_id, "the captured email must be linked to the request that sent it");
}

#[tokio::test]
async fn mail_outside_the_window_is_never_linked_to_a_request_that_did_not_send_it() {
    let conn = test_connection();
    let logs = LogState::new();
    let emails = listening_email_state();
    let registry = CorrelationRegistry::new();
    let (_edb_dir, edb) = db().await;

    // Captured well before this request fired — the existing "not
    // attributed" guarantee (`mail_sent_before_the_request_is_not_attributed_to_it`)
    // must extend to the new UPDATE, not just to the returned list.
    crate::email_state::insert_captured_email(
        &edb.pool,
        "old@shop.test",
        &["someone@example.com".to_string()],
        TEST_EMAIL,
        5_000,
    )
    .await
    .unwrap();

    let mut server = mockito::Server::new_async().await;
    let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
        conn,
        vec![],
        &logs,
        &emails,
        &edb.pool,
        &registry,
        10_000,
        DEFAULT_CORRELATION_WINDOW_MS,
    )
    .await
    .unwrap();
    mock.assert_async().await;

    let history_id = save_correlation_history(&edb.pool, "GET", "/ping", &result.response, None).await;

    collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        &edb.pool,
        result.correlation_id,
        history_id.as_deref(),
        10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    let old_email_id = crate::email_state::list_captured_emails(&edb.pool, None, 10).await.unwrap().emails[0].id;
    let old_email = crate::email_state::get_captured_email(&edb.pool, old_email_id).await.unwrap().unwrap();
    assert_eq!(old_email.request_id, None, "mail sent before the request must never be linked to it");
}
```

- [ ] **Step 8: Run the tests**

Run: `cd apps/devbench/src-tauri && cargo test commands::correlation:: -- --test-threads=1`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/correlation.rs
git commit -m "feat(devbench): link captured emails to the request that sent them"
```

---

### Task 10: `get_email` returns the linked request's method/url

**Files:**
- Modify: `apps/devbench/src-tauri/src/email_state.rs`

**Interfaces:**
- Produces: `CapturedEmail` gains `request_method: Option<String>`, `request_url: Option<String>`. This **supersedes** Task 1's `get_captured_email` (which read `request_id` only, with no join).

- [ ] **Step 1: Write the failing tests**

Add to `email_state.rs`'s `mod tests`:
```rust
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/devbench/src-tauri && cargo test email_state::tests::a_captured_email_linked_to_a_request`
Expected: FAIL — compile error, `CapturedEmail` has no `request_method`/`request_url` field yet.

- [ ] **Step 3: Add the fields and the join**

Replace the `CapturedEmail` struct's `request_id` field line:
```rust
    /// `None` unless a correlated request's window observed this email
    /// (Task 9 is what ever sets this to `Some`).
    pub request_id: Option<String>,
```
with:
```rust
    /// `None` unless a correlated request's window observed this email.
    pub request_id: Option<String>,
    /// Populated by a `LEFT JOIN request_history` in `get_captured_email` —
    /// `None` whenever `request_id` is `None`.
    pub request_method: Option<String>,
    pub request_url: Option<String>,
```

Replace `get_captured_email` entirely:
```rust
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
```

- [ ] **Step 4: Run all email_state and commands::email tests**

Run: `cd apps/devbench/src-tauri && cargo test email_state:: commands::email:: -- --test-threads=1`
Expected: all PASS, including Task 1's `a_freshly_captured_email_has_no_request_id` (unaffected — it never checks the new fields) and Task 3's `get_email_returns_the_full_message` (unaffected).

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src/email_state.rs
git commit -m "feat(devbench): get_email returns the linked request's method and url"
```

---

### Task 11: Frontend types + ApiTab threads `history_id`

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Modify: `apps/devbench/src/components/api/ApiTab.tsx:99`

**Interfaces:**
- Produces: `CorrelationResult.history_id`, `CapturedEmail.request_method`/`request_url`, updated `invokeCollectCorrelationWindow(correlationId, historyId)`.

- [ ] **Step 1: Update `tauri.ts`**

Replace:
```ts
export interface CorrelationResult {
  correlation_id: string;
  response: FireRequestOutput;
  /** `null` means the database could not be verified — never render this as "0 writes". */
  table_diffs: TableDiff[] | null;
  db_error: string | null;
}
```
with:
```ts
export interface CorrelationResult {
  correlation_id: string;
  response: FireRequestOutput;
  /** `null` means the database could not be verified — never render this as "0 writes". */
  table_diffs: TableDiff[] | null;
  db_error: string | null;
  /** The saved request_history row's id, once known — null only if that save itself failed. */
  history_id: string | null;
}
```

Replace:
```ts
export interface CapturedEmail extends EmailSummary {
  html_body: string | null;
  text_body: string | null;
  raw: string;
  /** Set once a correlated request's window observes this email. */
  request_id: string | null;
}
```
with:
```ts
export interface CapturedEmail extends EmailSummary {
  html_body: string | null;
  text_body: string | null;
  raw: string;
  /** Set once a correlated request's window observes this email. */
  request_id: string | null;
  request_method: string | null;
  request_url: string | null;
}
```

Replace:
```ts
export function invokeCollectCorrelationWindow(correlationId: string): Promise<CorrelationWindowResult> {
  return invoke("collect_correlation_window", { correlationId });
}
```
with:
```ts
export function invokeCollectCorrelationWindow(
  correlationId: string,
  historyId: string | null,
): Promise<CorrelationWindowResult> {
  return invoke("collect_correlation_window", { correlationId, historyId });
}
```

- [ ] **Step 2: Update `ApiTab.tsx`'s call site**

In `handleResult` (`ApiTab.tsx`), replace:
```ts
      const window = await invokeCollectCorrelationWindow(correlation.correlation_id);
```
with:
```ts
      const window = await invokeCollectCorrelationWindow(correlation.correlation_id, correlation.history_id);
```

- [ ] **Step 3: Type-check**

Run: `cd apps/devbench && bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/components/api/ApiTab.tsx
git commit -m "feat(devbench): thread history_id through the correlation window collection call"
```

---

### Task 12: EmailViewer — "Sent by" chip

**Files:**
- Modify: `apps/devbench/src/components/email/EmailViewer.tsx`
- Modify: `apps/devbench/src/components/email/EmailViewer.test.tsx` (additive only — existing tests untouched)

**Interfaces:**
- Produces: `EmailViewer` gains an optional `onOpenHistory?: (requestId: string) => void` prop.

- [ ] **Step 1: Add the chip**

In the header block (right after the `from ... to ...` line), insert:
```tsx
        {email.request_id && email.request_method && email.request_url ? (
          <button
            onClick={() => onOpenHistory?.(email.request_id as string)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-text-muted hover:text-text"
          >
            Sent by{" "}
            <b className="font-mono font-semibold text-text">
              {email.request_method} {email.request_url}
            </b>
            <span className="text-text-faint">→ view in History</span>
          </button>
        ) : null}
```

And update the component's props to accept the new callback:
```tsx
export function EmailViewer({
  email,
  onOpenHistory,
}: {
  email: CapturedEmail | null;
  onOpenHistory?: (requestId: string) => void;
}) {
```
(The full new header block, for placement reference, sits right after `<div className="mt-1 font-mono text-xs text-text-muted">from {email.from} · to {email.to.join(", ")}</div>` and before the closing `</div>` of the header `<div className="border-b border-border p-4">` block.)

- [ ] **Step 2: Add the new tests**

Append to `EmailViewer.test.tsx` (add `render, screen, fireEvent` from `@testing-library/react` and `vi` from `vitest` to the file's existing imports if not already present — `EmailInbox.test.tsx` uses this exact same import set):
```tsx
describe("EmailViewer — Sent by link", () => {
  const linkedEmail: CapturedEmail = {
    id: 1,
    captured_at_ms: 1_800_000_000_000,
    from: "orders@shop.test",
    to: ["customer@example.com"],
    subject: "Order confirmation #8841",
    size_bytes: 512,
    html_body: "<p>Thanks!</p>",
    text_body: "Thanks!",
    raw: "Subject: Order confirmation #8841\r\n\r\nThanks!",
    request_id: "hist-1",
    request_method: "POST",
    request_url: "/api/checkout",
  };

  it("shows the Sent by chip when the email is linked to a request", () => {
    render(<EmailViewer email={linkedEmail} />);
    expect(screen.getByText(/Sent by/)).toBeInTheDocument();
    expect(screen.getByText("POST /api/checkout")).toBeInTheDocument();
  });

  it("calls onOpenHistory with the request id when the chip is clicked", () => {
    const onOpenHistory = vi.fn();
    render(<EmailViewer email={linkedEmail} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByText(/Sent by/));
    expect(onOpenHistory).toHaveBeenCalledWith("hist-1");
  });

  it("shows no Sent by chip when the email has no linked request", () => {
    const unlinked: CapturedEmail = { ...linkedEmail, request_id: null, request_method: null, request_url: null };
    render(<EmailViewer email={unlinked} />);
    expect(screen.queryByText(/Sent by/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd apps/devbench && bun run test EmailViewer`
Expected: all PASS, including every pre-existing test in the file (this task only adds a new conditionally-rendered block and a new optional prop — no existing rendering path changes for an email with `request_id: null`).

- [ ] **Step 4: Commit**

```bash
git add apps/devbench/src/components/email/EmailViewer.tsx apps/devbench/src/components/email/EmailViewer.test.tsx
git commit -m "feat(devbench): EmailViewer shows which request sent a captured email"
```

---

### Task 13: Wire the "Sent by" jump to History

**Files:**
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/components/shell/SplitContent.tsx`
- Modify: `apps/devbench/src/components/shell/ToolPane.tsx`
- Modify: `apps/devbench/src/components/email/EmailTab.tsx`
- Modify: `apps/devbench/src/components/api/ApiTab.tsx`
- Modify: `apps/devbench/src/components/api/HistorySidebar.tsx`
- Modify: `apps/devbench/src/components/api/HistorySidebar.test.tsx` (additive only)

**Interfaces:**
- Produces: a `historyFocusId`/`onOpenHistory` pair threaded from `App.tsx` down to `ApiTab`, mirroring the existing `emailFocusId`/`onOpenEmail` pair exactly (`App.tsx:35,98`). `HistorySidebar` gains a `focusId?: string | null` prop.

- [ ] **Step 1: `App.tsx` — new state**

Replace:
```tsx
  const [dbFocusTable, setDbFocusTable] = useState<string | null>(null);
  const [emailFocusId, setEmailFocusId] = useState<number | null>(null);
```
with:
```tsx
  const [dbFocusTable, setDbFocusTable] = useState<string | null>(null);
  const [emailFocusId, setEmailFocusId] = useState<number | null>(null);
  const [historyFocusId, setHistoryFocusId] = useState<string | null>(null);
```

Replace:
```tsx
        <SplitContent
          dbFocusTable={dbFocusTable}
          emailFocusId={emailFocusId}
          onOpenTableInDb={setDbFocusTable}
          onOpenEmail={setEmailFocusId}
        />
```
with:
```tsx
        <SplitContent
          dbFocusTable={dbFocusTable}
          emailFocusId={emailFocusId}
          historyFocusId={historyFocusId}
          onOpenTableInDb={setDbFocusTable}
          onOpenEmail={setEmailFocusId}
          onOpenHistory={setHistoryFocusId}
        />
```

- [ ] **Step 2: `SplitContent.tsx` — thread it through**

Replace:
```tsx
export function SplitContent({
  dbFocusTable,
  emailFocusId,
  onOpenTableInDb,
  onOpenEmail,
}: {
  dbFocusTable: string | null;
  emailFocusId: number | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
}) {
```
with:
```tsx
export function SplitContent({
  dbFocusTable,
  emailFocusId,
  historyFocusId,
  onOpenTableInDb,
  onOpenEmail,
  onOpenHistory,
}: {
  dbFocusTable: string | null;
  emailFocusId: number | null;
  historyFocusId: string | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
  onOpenHistory: (id: string | null) => void;
}) {
```

Replace:
```tsx
  const paneProps = { dbFocusTable, emailFocusId, onOpenTableInDb, onOpenEmail };
```
with:
```tsx
  const paneProps = { dbFocusTable, emailFocusId, historyFocusId, onOpenTableInDb, onOpenEmail, onOpenHistory };
```

- [ ] **Step 3: `ToolPane.tsx` — route it to `ApiTab` and `EmailTab`**

Replace:
```tsx
export function ToolPane({
  tab,
  dbFocusTable,
  emailFocusId,
  onOpenTableInDb,
  onOpenEmail,
}: {
  tab: TabId;
  dbFocusTable: string | null;
  emailFocusId: number | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);

  switch (tab) {
    case "api":
      return <ApiTab onOpenTableInDb={onOpenTableInDb} onOpenEmail={onOpenEmail} />;
    case "db":
      return (
        <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
      );
    case "log":
      return <LogTab />;
    case "email":
      return <EmailTab focusEmailId={emailFocusId} />;
  }
}
```
with:
```tsx
export function ToolPane({
  tab,
  dbFocusTable,
  emailFocusId,
  historyFocusId,
  onOpenTableInDb,
  onOpenEmail,
  onOpenHistory,
}: {
  tab: TabId;
  dbFocusTable: string | null;
  emailFocusId: number | null;
  historyFocusId: string | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
  onOpenHistory: (id: string | null) => void;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);

  switch (tab) {
    case "api":
      return <ApiTab onOpenTableInDb={onOpenTableInDb} onOpenEmail={onOpenEmail} focusHistoryId={historyFocusId} />;
    case "db":
      return (
        <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
      );
    case "log":
      return <LogTab />;
    case "email":
      return <EmailTab focusEmailId={emailFocusId} onOpenHistory={onOpenHistory} />;
  }
}
```

- [ ] **Step 4: `EmailTab.tsx` — mirror the existing `handleOpenEmail`/`handleOpenDb` pattern**

Add the import and prop, and a handler that switches tabs before calling up — mirroring `ApiTab.tsx`'s existing `handleOpenEmail` (`setActiveTab("email"); onOpenEmail(emailId);`) in the opposite direction.

Replace:
```tsx
import { useCallback, useEffect, useState } from "react";
import { EmailInbox } from "./EmailInbox";
import { EmailViewer } from "./EmailViewer";
import { useAppStore } from "../../store/useAppStore";
```
(No new import needed — `setActiveTab("api")` below is a plain string literal, matching how `ApiTab.tsx:160,165` already call `setActiveTab("db")`/`setActiveTab("email")` with no `TabId` cast; `TabId` itself is exactly the `"api" | "db" | "log" | "email"` union, so the literal is already assignable.)

Replace:
```tsx
export function EmailTab({ focusEmailId = null }: { focusEmailId?: number | null }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
```
with:
```tsx
export function EmailTab({
  focusEmailId = null,
  onOpenHistory,
}: {
  focusEmailId?: number | null;
  onOpenHistory: (id: string | null) => void;
}) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
```

Add, right before the `return (` statement:
```tsx
  function handleOpenHistory(requestId: string) {
    setActiveTab("api");
    onOpenHistory(requestId);
  }
```

Replace:
```tsx
            <EmailViewer email={selected} />
```
with:
```tsx
            <EmailViewer email={selected} onOpenHistory={handleOpenHistory} />
```

- [ ] **Step 5: `ApiTab.tsx` — accept and forward `focusHistoryId`**

Replace:
```tsx
export function ApiTab({
  onOpenTableInDb,
  onOpenEmail,
}: {
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (emailId: number | null) => void;
}) {
```
with:
```tsx
export function ApiTab({
  onOpenTableInDb,
  onOpenEmail,
  focusHistoryId,
}: {
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (emailId: number | null) => void;
  focusHistoryId?: string | null;
}) {
```

Replace:
```tsx
      <HistorySidebar
        onSelect={handleHistorySelect}
        refreshKey={historyRefreshKey}
        sessionId={activeSessionId}
      />
```
with:
```tsx
      <HistorySidebar
        onSelect={handleHistorySelect}
        refreshKey={historyRefreshKey}
        sessionId={activeSessionId}
        focusId={focusHistoryId}
      />
```

- [ ] **Step 6: `HistorySidebar.tsx` — `focusId` prop, auto-select once loaded, highlight**

Replace:
```tsx
export function HistorySidebar({
  onSelect,
  refreshKey,
  sessionId,
}: {
  onSelect: (entry: HistoryEntry) => void;
  /** Bump this (e.g. a counter) to trigger a refetch, such as after a new entry is saved. */
  refreshKey?: number;
  /** `null`/omitted = unscoped: every request ever fired. Otherwise only this session's. */
  sessionId?: string | null;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [failed, setFailed] = useState(false);
```
with:
```tsx
export function HistorySidebar({
  onSelect,
  refreshKey,
  sessionId,
  focusId,
}: {
  onSelect: (entry: HistoryEntry) => void;
  /** Bump this (e.g. a counter) to trigger a refetch, such as after a new entry is saved. */
  refreshKey?: number;
  /** `null`/omitted = unscoped: every request ever fired. Otherwise only this session's. */
  sessionId?: string | null;
  /** Deep-linked from Email's "Sent by" chip — selects and highlights this entry once loaded. */
  focusId?: string | null;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [failed, setFailed] = useState(false);
```

Add, right after the existing fetch `useEffect` (before the `return (`):
```tsx
  // A focusId that arrives before the fetch resolves must not be silently
  // dropped — this re-runs once `entries` actually contains the match.
  useEffect(() => {
    if (!focusId) return;
    const match = entries.find((e) => e.id === focusId);
    if (match) onSelect(match);
  }, [focusId, entries, onSelect]);
```

Replace:
```tsx
          entries.map((entry) => (
            <button
              key={entry.id}
              onClick={() => onSelect(entry)}
              className="flex flex-col gap-0.5 rounded-sm p-2 text-left hover:bg-surface-2"
            >
```
with:
```tsx
          entries.map((entry) => (
            <button
              key={entry.id}
              onClick={() => onSelect(entry)}
              aria-current={focusId === entry.id}
              className={`flex flex-col gap-0.5 rounded-sm p-2 text-left hover:bg-surface-2 ${
                focusId === entry.id ? "bg-surface-2" : ""
              }`}
            >
```

- [ ] **Step 7: Add tests for the new `focusId` behavior**

Append to `HistorySidebar.test.tsx`:
```tsx
it("selects the focused entry once it has loaded, mirroring a manual click", async () => {
  const onSelect = vi.fn();
  vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([entry({ id: "hist-1", url: "/api/checkout" })]);

  render(<HistorySidebar onSelect={onSelect} focusId="hist-1" />);

  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "hist-1" })));
});

it("highlights the focused row", async () => {
  vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([entry({ id: "hist-1", url: "/api/checkout" })]);

  render(<HistorySidebar onSelect={() => {}} focusId="hist-1" />);

  await waitFor(() =>
    expect(screen.getByRole("button", { name: /checkout/ })).toHaveAttribute("aria-current", "true"),
  );
});
```

- [ ] **Step 8: Run all frontend tests and type-check**

Run: `cd apps/devbench && bun run test && bun run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src/App.tsx apps/devbench/src/components/shell/SplitContent.tsx apps/devbench/src/components/shell/ToolPane.tsx apps/devbench/src/components/email/EmailTab.tsx apps/devbench/src/components/api/ApiTab.tsx apps/devbench/src/components/api/HistorySidebar.tsx apps/devbench/src/components/api/HistorySidebar.test.tsx
git commit -m "feat(devbench): wire the Sent-by chip to jump to and highlight its History entry"
```

**Phase 2 complete.** Firing a correlated request now durably links whichever captured emails its window observes to that request; opening one of those emails and clicking "Sent by ..." jumps to the API tab with the matching History row selected and highlighted.

---

## Manual verification (both phases)

Automated tests cover every unit above; these two checks confirm the whole feature end to end in the real app, which `bun run test`/`cargo test` cannot:

1. Launch the app, send a test email via `swaks --to a@b.test --server localhost:1025 --body hi` (or any SMTP client), confirm it appears in the Email tab within ~1s, then **restart the app** and confirm it's still there.
2. Fire a correlated request against a backend that sends mail, wait for the rollup's Email chip to resolve, open the Email tab, select that message, and confirm the "Sent by ..." chip is present and clicking it jumps to History with the right row highlighted.
