use serde::Serialize;
use std::collections::VecDeque;

/// Port the local SMTP catcher listens on. Point your backend's SMTP config
/// here — the same integration Mailhog and Mailpit ask for.
///
/// Hardcoded on purpose: Settings > General (Plan 4) replaces this constant
/// with a stored, user-editable value, at which point the spec's "shortcut
/// into Settings to change the port" becomes live. Same scoping shape as
/// Plan 1's `DEV_CONNECTION` and Plan 2's `DEFAULT_CORRELATION_WINDOW_MS`.
pub const DEFAULT_SMTP_PORT: u16 = 1025;

/// How many messages are kept. Old ones are evicted; `evicted_through_id`
/// lets a correlation window detect that it lost some.
pub const MAX_INBOX_MESSAGES: usize = 200;

/// A message the catcher accepted, in full.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CapturedEmail {
    pub id: u64,
    /// DevBench's own clock when `DATA` completed. Correlation windows are
    /// bounded by this, never by the message's `Date:` header — the header
    /// comes from the target backend and may be skewed, absent, or unparsed.
    pub captured_at_ms: i64,
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub html_body: Option<String>,
    pub text_body: Option<String>,
    pub raw: String,
    pub size_bytes: usize,
}

/// What the inbox list and the rollup carry. Deliberately excludes the bodies
/// and the raw source so listing 200 messages does not push megabytes across
/// the Tauri IPC boundary to render subject lines.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EmailSummary {
    pub id: u64,
    pub captured_at_ms: i64,
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub size_bytes: usize,
}

impl From<&CapturedEmail> for EmailSummary {
    fn from(e: &CapturedEmail) -> Self {
        Self {
            id: e.id,
            captured_at_ms: e.captured_at_ms,
            from: e.from.clone(),
            to: e.to.clone(),
            subject: e.subject.clone(),
            size_bytes: e.size_bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedEmail {
    pub subject: String,
    pub html_body: Option<String>,
    pub text_body: Option<String>,
}

/// Lifts subject and bodies out of an RFC 5322 message. From/to are NOT taken
/// from here — they come from the SMTP envelope, which is what the backend
/// actually addressed the mail to (a Bcc recipient exists in the envelope and
/// never in the headers).
pub fn parse_captured(raw: &str) -> ParsedEmail {
    let parsed = mail_parser::MessageParser::default().parse(raw);
    match parsed {
        Some(message) => {
            // `Message::body_html`/`body_text` synthesize a converted
            // representation when only one genuine part exists (e.g. a
            // plain-text-only message gets an auto-generated HTML body).
            // That's the wrong contract here: html_body/text_body must
            // reflect what the backend actually sent, so a part is only
            // reported when it is genuinely that MIME type.
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
            // An unparseable message is still a real message: keep it, show
            // the raw view, and say the subject is unknown rather than
            // dropping it and reporting one fewer email than was sent.
            subject: "(unparseable message)".to_string(),
            html_body: None,
            text_body: None,
        },
    }
}

pub struct EmailStore {
    messages: VecDeque<CapturedEmail>,
    capacity: usize,
    next_id: u64,
    evicted_through_id: u64,
}

impl EmailStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            messages: VecDeque::with_capacity(capacity.min(64)),
            capacity,
            next_id: 1,
            evicted_through_id: 0,
        }
    }

    /// The id the NEXT captured message will receive. Correlation snapshots
    /// this before firing a request, then selects ids strictly greater.
    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    /// Highest id dropped from the inbox. A caller whose `from_id` is at or
    /// below this knows its view is incomplete.
    pub fn evicted_through_id(&self) -> u64 {
        self.evicted_through_id
    }

    pub fn push(&mut self, from: &str, to: &[String], raw: &str, captured_at_ms: i64) -> u64 {
        let parsed = parse_captured(raw);
        let id = self.next_id;
        self.next_id += 1;
        self.messages.push_back(CapturedEmail {
            id,
            captured_at_ms,
            from: from.to_string(),
            to: to.to_vec(),
            subject: parsed.subject,
            html_body: parsed.html_body,
            text_body: parsed.text_body,
            raw: raw.to_string(),
            size_bytes: raw.len(),
        });
        while self.messages.len() > self.capacity {
            if let Some(dropped) = self.messages.pop_front() {
                self.evicted_through_id = dropped.id;
            }
        }
        id
    }

    /// Newest first — an inbox is read from the top.
    pub fn list(&self, limit: usize) -> Vec<EmailSummary> {
        self.messages.iter().rev().take(limit).map(EmailSummary::from).collect()
    }

    pub fn get(&self, id: u64) -> Option<CapturedEmail> {
        self.messages.iter().find(|m| m.id == id).cloned()
    }

    /// Empties the inbox. Ids are NOT rewound: an in-flight correlation window
    /// holding a `from_id` must never be able to match a later message.
    pub fn clear(&mut self) {
        if let Some(last) = self.messages.back() {
            self.evicted_through_id = last.id;
        }
        self.messages.clear();
    }

    /// Messages captured strictly after `after_id` and no later than
    /// `captured_before_or_at_ms`. The correlation-window selector, matching
    /// `LogBuffer::between` so correlation treats both sources identically.
    pub fn between(&self, after_id: u64, captured_before_or_at_ms: i64) -> Vec<EmailSummary> {
        self.messages
            .iter()
            .filter(|m| m.id > after_id && m.captured_at_ms <= captured_before_or_at_ms)
            .map(EmailSummary::from)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn store_assigns_increasing_ids_and_lists_newest_first() {
        let mut store = EmailStore::new(MAX_INBOX_MESSAGES);
        let first = store.push("a@x.test", &["b@y.test".into()], SIMPLE, 1_000);
        let second = store.push("c@x.test", &["d@y.test".into()], SIMPLE, 2_000);
        assert!(second > first);

        let listed = store.list(10);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, second, "inbox shows newest first");
        assert_eq!(listed[0].from, "c@x.test");
    }

    #[test]
    fn store_get_returns_the_full_message_including_raw_source() {
        let mut store = EmailStore::new(MAX_INBOX_MESSAGES);
        let id = store.push("a@x.test", &["b@y.test".into()], SIMPLE, 1_000);
        let full = store.get(id).unwrap();
        assert_eq!(full.subject, "Order confirmation #8841");
        assert_eq!(full.to, vec!["b@y.test".to_string()]);
        assert!(full.raw.contains("Thanks for your order"));
        assert_eq!(full.size_bytes, SIMPLE.len());
    }

    #[test]
    fn store_evicts_oldest_and_records_how_far_it_evicted() {
        let mut store = EmailStore::new(2);
        for _ in 0..4 {
            store.push("a@x.test", &["b@y.test".into()], SIMPLE, 1_000);
        }
        assert_eq!(store.list(10).len(), 2);
        assert_eq!(store.evicted_through_id(), 2);
    }

    #[test]
    fn store_between_selects_by_id_lower_bound_and_capture_time_upper_bound() {
        let mut store = EmailStore::new(MAX_INBOX_MESSAGES);
        store.push("a@x.test", &["b@y.test".into()], SIMPLE, 1_000);
        let from_id = store.next_id() - 1;
        store.push("inside@x.test", &["b@y.test".into()], SIMPLE, 1_500);
        store.push("after@x.test", &["b@y.test".into()], SIMPLE, 9_999);

        let selected = store.between(from_id, 2_000);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].from, "inside@x.test");
    }

    #[test]
    fn clear_empties_the_inbox_without_rewinding_ids() {
        let mut store = EmailStore::new(MAX_INBOX_MESSAGES);
        store.push("a@x.test", &["b@y.test".into()], SIMPLE, 1_000);
        let next_before = store.next_id();
        store.clear();
        assert_eq!(store.list(10).len(), 0);
        assert_eq!(store.next_id(), next_before, "ids must never be reused");
    }
}
