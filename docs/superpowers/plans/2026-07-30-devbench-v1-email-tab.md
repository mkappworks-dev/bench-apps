# DevBench v1 — Email Tab & Email Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Email tab (local SMTP catcher on port 1025, inbox, message viewer) and extend the "what happened" rollup from two observed sources to three. When this plan is done the full DevBench differentiator is complete: fire one request and see the rows it changed, the lines it logged, and the mail it sent, in one place, with zero instrumentation of the target backend beyond one SMTP config line.

**Architecture:** A blocking SMTP server (`mailin-embedded`) runs on a dedicated OS thread with a `TcpListener` that DevBench binds itself at startup — so "port 1025 already in use" is a clear error before the app finishes launching, not a silently dead catcher. Its `Handler` accumulates each `DATA` payload incrementally with a per-chunk 10 MiB cap (the same shape as `fire_request`'s body reader), then pushes the captured message into a bounded in-memory inbox shared with the Tauri commands via `Arc<Mutex<…>>`. Correlation reuses the two-phase machinery Plan 2 built: `run_correlated_request` already snapshots a cursor and opens a window; this plan snapshots the *email* cursor alongside the log cursor, and `collect_correlation_window` returns both.

**Tech Stack:** Unchanged, plus two new Rust crates: `mailin-embedded` 0.8 (embeddable SMTP **server**, MIT OR Apache-2.0) and `mail-parser` 0.11 (RFC 5322/MIME parser, Apache-2.0 OR MIT). No new frontend dependencies.

## Global Constraints

- **This plan adds a native build dependency chain through `aws-lc-sys`, but `cmake` is NOT always required.** `mailin-embedded` 0.8.3 depends on `rustls` with default features, which enables the `aws-lc-rs` provider and therefore builds `aws-lc-sys` from C source — confirmed via `cargo tree -i aws-lc-sys` against DevBench's exact dependency set: `aws-lc-sys → aws-lc-rs → rustls → mailin-embedded`. **Corrected during Task 1's implementation** (see the log-tab-worktree build and this plan's SDD ledger): on macOS/aarch64 with no `cmake` on `PATH`, `aws-lc-sys` v0.43.0 compiled to completion anyway via its no-cmake fallback path — verified by a real build, not assumed. `cmake` may still be required on other platforms/architectures (Linux CI, Windows) where the fallback doesn't apply; if a build fails inside `aws-lc-sys`, install `cmake` (and NASM on Windows) then. Do not install `cmake` speculatively — try the build first. It **cannot** be avoided by disabling features either way — `mailin-embedded --no-default-features` does not compile (its `rtls.rs` uses `rustls` and `rustls-pemfile` without `#[cfg]` gates; upstream bug). See Decision 1 for why this cost is accepted and what would reverse it.
- **Local Postgres required for the backend suite:** `docker compose up -d` at the repo root. If tests fail with a connection timeout, run `docker compose down && docker compose up -d --force-recreate`.
- MIT license on all code in `apps/devbench`. Both new crates are dual-licensed with MIT as an option — compatible.
- Local-first: the SMTP listener binds `127.0.0.1` only, never `0.0.0.0`. DevBench never sends mail and never relays it; it only catches. No DevBench-operated server exists or is contacted anywhere in this plan.
- Every Tauri command follows the established split: `#[tauri::command] async fn foo(...)` is a thin wrapper delegating to a plain `async fn foo_impl(...)` (or a sync `fn` where nothing awaits) that holds the real logic and is what the unit tests call. `_impl` functions take plain references, never `tauri::State`.
- Message capture is **bounded and incremental**: the byte budget is checked *inside* `Handler::data`, which is invoked once per received chunk. Never accumulate a whole message and then check its size afterwards.
- **Captured HTML is untrusted and is never injected into the app's DOM.** It renders only inside `<iframe sandbox srcDoc={...}>` with no `allow-*` tokens. DevBench's webview has `invoke` on `window`; `dangerouslySetInnerHTML` on attacker-controlled markup would hand a hostile email arbitrary command execution against the user's database and filesystem.
- Visual system follows `DESIGN.md`: monochrome, dark-primary with independent light support, ghosty persistent chrome, `--radius-sm` for controls / `--radius-lg` for surfaces, `tabular-nums` for aligned digits.
- Package manager is Bun exclusively.
- A failure to observe is never rendered as "nothing happened" (PRODUCT.md principle 4). `emails: null` means "the catcher was not running, so we did not observe mail"; `emails: []` means "the catcher was running and nothing was sent."

---

## Decisions Made In This Plan (read these before Task 1)

### Decision 1: `mailin-embedded` 0.8, accepting an `aws-lc-sys` build dependency

Candidates considered, all of them SMTP **servers** (an SMTP *client* like `lettre` is the wrong tool — DevBench catches mail, it never sends it):

| Crate | Verdict |
|---|---|
| `samotop` 0.13 | **Rejected.** Built on `async-std`. Pulling a second async runtime alongside the `tokio` that Tauri, `reqwest`, and `sqlx` all already run on is a much larger cost than a C build dependency. |
| `smtp-server` 0.1.0 / `rust-smtp-server` 0.1.1 | **Rejected.** 0.1.x, effectively unproven, no meaningful adoption. |
| **`mailin-embedded` 0.8.3 — CHOSEN** | MIT OR Apache-2.0. Blocking, threadpool-based, ~13 transitive crates of its own. Its `Handler` trait is exactly the shape this job needs. |

Three concrete properties decided it, each verified by compiling and running a prototype rather than read off a README:

1. **`fn data(&mut self, buf: &[u8]) -> io::Result<()>` is invoked once per received chunk during `DATA`.** That is precisely the "bounded incremental read, budget checked inside the loop" pattern `fire_request` established — the cap is a natural fit, not something bolted on, and returning `Err` from it aborts the message cleanly at the protocol level.
2. **`Server::with_tcp_listener(listener)` accepts a socket we bind ourselves.** `serve()` blocks forever and reports a bind failure only by returning, so without this the v1 spec's "fails fast at startup with a clear 'port 1025 in use' message" would be unimplementable. Binding first turns it into an ordinary `Result` at launch.
3. **The SMTP command grammar is not worth hand-rolling.** `MAIL FROM:<>` with `SIZE=`/`BODY=` parameters, quoted local-parts, `RSET`, pipelining, and dot-stuffing in `DATA` are all real cases a Mailpit-shaped tool hits. `mailin`'s `nom` parser handles them.

**Accepted costs, recorded plainly:**
- The `aws-lc-sys` / cmake build dependency in the Global Constraints above.
- The blocking threadpool model needs a bridge into `tokio` — solved by running `serve()` on a dedicated `std::thread` and sharing state through `Arc<Mutex<…>>` rather than a channel. Contention is nil at the "a few emails per debugging session" scale.
- Last release 0.8.3 on a self-hosted forge (`code.alienscience.org`); bus factor is real.

**Trigger to reverse this:** if the cmake requirement proves unacceptable (a CI image that cannot install it, or a contributor-onboarding complaint), replace the crate with ~150 lines of hand-rolled SMTP over `tokio::net::TcpListener` — greet `220`, `250` to `EHLO`/`HELO`/`MAIL`/`RCPT`, `354` to `DATA`, read to `\r\n.\r\n` with the same per-chunk cap, `221` on `QUIT`. `EmailStore`, the commands, the correlation wiring, and the whole frontend are unaffected, because Task 2 keeps the crate behind one module boundary. That is a deliberate seam, not an accident.

### Decision 2: envelope for from/to, `mail-parser` for subject and body, raw bytes kept verbatim

`data_start(domain, from, is8bit, to)` hands over the actual SMTP envelope. That is what the target backend really addressed the message to — including `Bcc` recipients, which by definition never appear in the headers. Using it for from/to is both more accurate than parsing `From:`/`To:` and removes any need to touch `mail-parser`'s `Address`/`Addr` union.

`mail-parser` is used for exactly two things: `subject()` and `body_html(0)` / `body_text(0)`. The Raw and Headers view modes render slices of the raw bytes DevBench captured, so they are always faithful even for a message `mail-parser` cannot parse.

### Decision 3: SMTP port is a hardcoded 1025 constant, in exactly one place

`DEFAULT_SMTP_PORT` lives in `src-tauri/src/email_state.rs` and nowhere else. Settings > General (Plan 4) replaces it with a stored value; the spec's "a shortcut into Settings to change the port" becomes live then. Until then the Email tab's status bar says which port is bound and, on a bind failure, what to do about it. Same scoping shape as Plan 1's `DEV_CONNECTION` and Plan 2's `DEFAULT_CORRELATION_WINDOW_MS` — flagged so it is not mistaken later for an oversight.

### Decision 4: the inbox is bounded and in-memory

200 messages, oldest evicted, lost on restart — mirroring the log ring buffer and the still-in-memory watched-table set. Persisting the inbox is part of Plan 4's storage work (which has to close the `watched_tables` gap anyway); doing it here would mean designing a second SQLite schema in a plan that is already adding a protocol server. As with logs, an eviction that crosses a correlation window is surfaced (`emails_truncated`), never silently under-reported.

### Decision 5: no new frontend dependencies

The inbox list is bounded at 200 items, so TanStack Virtual (introduced in Plan 2 for the genuinely unbounded log stream) is not needed here. Base UI is still not installed; it arrives in Plan 4 where three tab bars and a segmented control appear at once. The Email tab's mode bar (HTML / Plain / Raw / Headers) is four buttons and is hand-rolled with `role="tab"`, matching what the main tab bar does today.

---

## File Structure

```
apps/devbench/
  src/
    App.tsx                                       # MODIFIED: one entry added to TABS, one branch in <main>
    store/useAppStore.ts                          # MODIFIED: TabId gains "email"
    lib/tauri.ts                                  # MODIFIED: email types + wrappers, emails on the window result
    components/
      email/
        EmailTab.tsx                              # NEW: inbox + viewer + status bar, owns polling
        EmailInbox.tsx                            # NEW
        EmailInbox.test.tsx                       # NEW
        EmailViewer.tsx                           # NEW: sandboxed HTML / Plain / Raw / Headers
        EmailViewer.test.tsx                      # NEW
      rollup/
        Rollup.tsx                                # MODIFIED: third chip
        Rollup.test.tsx                           # MODIFIED
      api/
        ApiTab.tsx                                # MODIFIED: carry emails into RollupData
  src-tauri/
    Cargo.toml                                    # MODIFIED: + mailin-embedded, + mail-parser
    src/
      lib.rs                                      # MODIFIED: + pub mod email_state; + pub mod smtp_catcher;
      main.rs                                     # MODIFIED: bind + spawn the catcher, register commands
      email_state.rs                              # NEW: CapturedEmail, EmailStore, EmailState, DEFAULT_SMTP_PORT
      smtp_catcher.rs                             # NEW: the mailin-embedded Handler and serve loop
      correlation_state.rs                        # MODIFIED: OpenWindow gains from_email_id
      commands/
        mod.rs                                    # MODIFIED: + pub mod email;
        email.rs                                  # NEW: list/get/clear/status commands
        correlation.rs                            # MODIFIED: snapshot + collect the email cursor
```

**Responsibilities:**
- `email_state.rs` owns *what a captured message is* and the bounded store. It knows nothing about SMTP.
- `smtp_catcher.rs` is the only file that mentions `mailin_embedded`. That boundary is what makes Decision 1's reversal trigger a one-file change.
- `commands/email.rs` is thin: Tauri wrappers over store reads.
- `correlation.rs` keeps its existing job and gains a second cursor. It stays the highest-bug-cost file in the app.

---

### Task 1: Captured-email model and the bounded inbox store

**Files:**
- Create: `apps/devbench/src-tauri/src/email_state.rs`
- Modify: `apps/devbench/src-tauri/src/lib.rs`
- Modify: `apps/devbench/src-tauri/Cargo.toml`
- Test: inline `#[cfg(test)]` module in `email_state.rs`

**Interfaces:**
- Produces:
  - `pub struct CapturedEmail { id: u64, captured_at_ms: i64, from: String, to: Vec<String>, subject: String, html_body: Option<String>, text_body: Option<String>, raw: String, size_bytes: usize }`
  - `pub struct EmailSummary { id, captured_at_ms, from, to, subject, size_bytes }` — what the inbox list and the rollup carry, so a 10 MiB body is never shipped over IPC just to render a subject line.
  - `pub struct EmailStore` with `new(capacity)`, `next_id()`, `push(from, to, raw, captured_at_ms) -> u64`, `list(limit) -> Vec<EmailSummary>`, `get(id) -> Option<CapturedEmail>`, `clear()`, `between(after_id, captured_before_or_at_ms) -> Vec<EmailSummary>`, `evicted_through_id()`.
  - `pub const DEFAULT_SMTP_PORT: u16 = 1025;`
  - `pub fn parse_captured(raw: &str) -> ParsedEmail` where `ParsedEmail { subject: String, html_body: Option<String>, text_body: Option<String> }`.

  Task 2 (the SMTP handler) calls `push`; Task 4 (commands) calls `list`/`get`/`clear`; Task 5 (correlation) calls `next_id`/`between`/`evicted_through_id`; Task 6 mirrors `CapturedEmail`/`EmailSummary` in TypeScript with these exact field names.

`EmailStore` mirrors `LogBuffer` from Plan 2 on purpose — same `next_id` / `between` / `evicted_through_id` contract, so `collect_correlation_window` treats logs and emails identically instead of growing two shapes of special case.

- [ ] **Step 1: Add the crates**

Modify `apps/devbench/src-tauri/Cargo.toml`, under `[dependencies]`:
```toml
mailin-embedded = "0.8"
mail-parser = "0.11"
```

Run: `cd apps/devbench/src-tauri && cargo build`
Expected: succeeds. If it fails inside `aws-lc-sys` with a missing `cmake`, install cmake (macOS: `brew install cmake`; Debian/Ubuntu: `apt-get install -y cmake`) and re-run — this is the build dependency called out in the Global Constraints, not a mistake in the manifest.

- [ ] **Step 2: Write the failing tests**

`apps/devbench/src-tauri/src/email_state.rs`:
```rust
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
        Some(message) => ParsedEmail {
            subject: message.subject().unwrap_or("(no subject)").to_string(),
            html_body: message.body_html(0).map(|c| c.into_owned()),
            text_body: message.body_text(0).map(|c| c.into_owned()),
        },
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test parses_the_subject_and_a_plain_text_body`
Expected: FAIL to compile — `email_state` is not declared in `lib.rs` and `EmailStore` does not exist.

- [ ] **Step 4: Implement `EmailStore` and declare the module**

Append to `apps/devbench/src-tauri/src/email_state.rs`, above the `#[cfg(test)]` block:
```rust
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
```

Modify `apps/devbench/src-tauri/src/lib.rs`:
```rust
pub mod commands;
pub mod correlation_state;
pub mod email_state;
pub mod local_db;
pub mod log_state;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test email_state::`
Expected: PASS (eight tests)

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src-tauri/Cargo.toml apps/devbench/src-tauri/Cargo.lock apps/devbench/src-tauri/src/email_state.rs apps/devbench/src-tauri/src/lib.rs
git commit -m "feat(devbench): add captured-email model and bounded inbox store"
```

---

### Task 2: The SMTP catcher

**Files:**
- Create: `apps/devbench/src-tauri/src/smtp_catcher.rs`
- Modify: `apps/devbench/src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` module in `smtp_catcher.rs`

**Interfaces:**
- Consumes: `EmailStore` from Task 1.
- Produces:
  - `pub const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;`
  - `pub fn bind(port: u16) -> Result<TcpListener, String>` — binds `127.0.0.1:<port>` and returns a clear error if it is taken.
  - `pub fn serve(listener: TcpListener, store: Arc<Mutex<EmailStore>>) -> Result<(), String>` — blocks forever; call it on a dedicated thread.
  - `pub struct CatcherHandler` implementing `mailin_embedded::Handler`.
  Task 3 calls `bind` and `serve`. **This is the only module in the app that mentions `mailin_embedded`** — that boundary is what keeps Decision 1's reversal trigger a one-file change.

The test in this task is a genuine end-to-end SMTP round trip against a real socket, driven by a hand-written client. Writing ~20 lines of client SMTP in the test is deliberately preferred over adding an SMTP *client* crate (`lettre`) as a dev-dependency: it keeps the dependency set honest, and it means the test exercises the exact wire bytes a target backend sends rather than a library's idea of them.

- [ ] **Step 1: Write the catcher and its end-to-end test**

`apps/devbench/src-tauri/src/smtp_catcher.rs`:
```rust
use mailin_embedded::response::{self, Response};
use mailin_embedded::{Handler, Server, SslConfig};
use std::io;
use std::net::{IpAddr, TcpListener};
use std::sync::{Arc, Mutex};

use crate::email_state::EmailStore;

/// Ceiling on one captured message. Checked INSIDE `Handler::data`, which is
/// called once per received chunk — the same bounded-incremental shape as
/// `fire_request`'s streamed response reader, never buffer-then-check.
pub const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;

/// Binds the catcher's socket. Done separately from `serve` so a port
/// conflict (Mailhog or Mailpit already running) surfaces as an ordinary
/// `Result` at app startup, per the v1 spec's error-handling requirement.
/// `serve` blocks forever and could not report this.
pub fn bind(port: u16) -> Result<TcpListener, String> {
    // 127.0.0.1, never 0.0.0.0: a local-first tool must not expose an open
    // mail relay-shaped listener to the network.
    TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        format!("SMTP port {port} is unavailable ({e}) — another catcher (Mailhog/Mailpit) may be running")
    })
}

/// Runs the SMTP server. BLOCKS FOREVER — call on a dedicated thread.
pub fn serve(listener: TcpListener, store: Arc<Mutex<EmailStore>>) -> Result<(), String> {
    let handler = CatcherHandler::new(store);
    let mut server = Server::new(handler);
    server
        .with_name("devbench")
        // No STARTTLS: this is a loopback catcher for a developer's own
        // backend. TLS here would add a certificate to manage and secure
        // nothing that is not already inside the machine's trust boundary.
        .with_ssl(SslConfig::None)
        .map_err(|e| format!("failed to configure SMTP server: {e}"))?;
    server.with_tcp_listener(listener);
    server.serve().map_err(|e| format!("SMTP server stopped: {e}"))
}

/// `mailin-embedded` CLONES the handler once per connection, so the envelope
/// and body fields below are naturally per-connection state; only `store` is
/// shared. That is exactly the isolation a per-session accumulator needs.
#[derive(Clone)]
pub struct CatcherHandler {
    store: Arc<Mutex<EmailStore>>,
    from: String,
    to: Vec<String>,
    data: Vec<u8>,
    overflowed: bool,
}

impl CatcherHandler {
    pub fn new(store: Arc<Mutex<EmailStore>>) -> Self {
        Self { store, from: String::new(), to: Vec::new(), data: Vec::new(), overflowed: false }
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
        // Accept every recipient: a catcher's job is to catch, not to route.
        // The authoritative recipient list arrives in `data_start`.
        response::OK
    }

    fn data_start(&mut self, _domain: &str, from: &str, _is8bit: bool, to: &[String]) -> Response {
        // The SMTP ENVELOPE, which is what the backend actually addressed the
        // message to — including Bcc recipients, which never appear in headers.
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
        // Budget checked per chunk, before appending — a hostile or runaway
        // sender can never make us allocate past the cap.
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
        // Lossy: a message can legitimately carry 8-bit bytes in a charset we
        // do not decode. Dropping it would under-report what the backend sent,
        // which principle 4 forbids; replacement characters are honest.
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let captured_at_ms = chrono::Utc::now().timestamp_millis();

        match self.store.lock() {
            Ok(mut store) => {
                store.push(&self.from, &self.to, &raw, captured_at_ms);
                response::OK
            }
            // A poisoned mutex means a previous panic. Rejecting is better than
            // silently accepting a message we cannot store: the sending backend
            // sees a failure it can log, rather than DevBench claiming zero mail.
            Err(_) => response::INTERNAL_ERROR,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email_state::MAX_INBOX_MESSAGES;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;

    /// Reads SMTP reply lines until one has a space (not '-') after the code,
    /// which is how a multiline EHLO reply terminates.
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

    fn start_catcher() -> (u16, Arc<Mutex<EmailStore>>) {
        let store = Arc::new(Mutex::new(EmailStore::new(MAX_INBOX_MESSAGES)));
        // Port 0 lets the OS pick a free one, so tests never collide with a
        // real Mailhog on 1025 or with each other under `cargo test`.
        let listener = bind(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let store_for_server = Arc::clone(&store);
        std::thread::spawn(move || {
            let _ = serve(listener, store_for_server);
        });
        (port, store)
    }

    fn wait_for_messages(store: &Arc<Mutex<EmailStore>>, want: usize) {
        for _ in 0..100 {
            if store.lock().unwrap().list(10).len() >= want {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("timed out waiting for {want} captured message(s)");
    }

    #[test]
    fn catches_a_message_sent_by_a_plain_smtp_client() {
        let (port, store) = start_catcher();

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

        wait_for_messages(&store, 1);
        let guard = store.lock().unwrap();
        let listed = guard.list(10);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].from, "orders@shop.test");
        assert_eq!(listed[0].to, vec!["customer@example.com".to_string()]);
        assert_eq!(listed[0].subject, "Order confirmation #8841");

        let full = guard.get(listed[0].id).unwrap();
        assert!(full.text_body.unwrap().contains("Thanks for your order"));
        assert!(full.raw.contains("Subject: Order confirmation #8841"));
    }

    #[test]
    fn captures_the_envelope_recipient_even_when_it_is_absent_from_the_headers() {
        let (port, store) = start_catcher();

        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);

        let _ = read_reply(&mut reader);
        write!(writer, "EHLO tester\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "MAIL FROM:<orders@shop.test>\r\n").unwrap();
        let _ = read_reply(&mut reader);
        // A Bcc recipient: present in the envelope, deliberately absent from
        // the headers. Parsing `To:` would silently lose it.
        write!(writer, "RCPT TO:<audit@shop.test>\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "DATA\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "Subject: Receipt\r\nTo: customer@example.com\r\n\r\nbody\r\n.\r\n").unwrap();
        let _ = read_reply(&mut reader);
        write!(writer, "QUIT\r\n").unwrap();

        wait_for_messages(&store, 1);
        let guard = store.lock().unwrap();
        assert_eq!(guard.list(10)[0].to, vec!["audit@shop.test".to_string()]);
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

    #[test]
    fn data_rejects_a_message_past_the_size_cap_without_buffering_it() {
        let store = Arc::new(Mutex::new(EmailStore::new(MAX_INBOX_MESSAGES)));
        let mut handler = CatcherHandler::new(Arc::clone(&store));
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
        assert_eq!(store.lock().unwrap().list(10).len(), 0, "an overflowed message is not stored");
    }
}
```

Modify `apps/devbench/src-tauri/src/lib.rs`:
```rust
pub mod commands;
pub mod correlation_state;
pub mod email_state;
pub mod local_db;
pub mod log_state;
pub mod smtp_catcher;
```

- [ ] **Step 2: Run tests to verify they fail, then pass**

Run: `cd apps/devbench/src-tauri && cargo test smtp_catcher::`
Expected: first run may fail to compile if `lib.rs` was not updated; once it builds, all four tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/devbench/src-tauri/src/smtp_catcher.rs apps/devbench/src-tauri/src/lib.rs
git commit -m "feat(devbench): add local SMTP catcher with a bounded per-chunk message cap"
```

---

### Task 3: `EmailState`, startup binding, and fail-fast on a taken port

**Files:**
- Modify: `apps/devbench/src-tauri/src/email_state.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Test: inline `#[cfg(test)]` module in `email_state.rs`

**Interfaces:**
- Consumes: `EmailStore` (Task 1), `bind` / `serve` (Task 2).
- Produces: `pub struct EmailState { store: Arc<Mutex<EmailStore>>, status: Mutex<SmtpStatus> }` with `new()`, `store()`, `status()`, `set_status(SmtpStatus)`, and `pub struct SmtpStatus { listening: bool, port: u16, error: Option<String> }`. Task 4's commands and Task 5's correlation take `&EmailState`.

The catcher is started in `main.rs`'s `setup` and is **not** allowed to abort the app. The v1 spec requires failing "fast at startup with a clear 'port 1025 in use' message and a shortcut into Settings to change the port" — an app that refuses to launch cannot show either. So a bind failure is recorded in `SmtpStatus` and surfaced by the Email tab; the other three tools stay fully usable.

- [ ] **Step 1: Write the failing tests**

Append to the `#[cfg(test)] mod tests` block in `apps/devbench/src-tauri/src/email_state.rs`:
```rust
    #[test]
    fn a_new_email_state_reports_not_listening_until_the_catcher_binds() {
        let state = EmailState::new();
        let status = state.status();
        assert!(!status.listening);
        assert_eq!(status.error, None);
    }

    #[test]
    fn a_bind_failure_is_recorded_as_status_rather_than_being_thrown_away() {
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

    #[test]
    fn email_state_exposes_its_store_for_the_catcher_thread_and_the_commands() {
        let state = EmailState::new();
        {
            let mut store = state.store().lock().unwrap();
            store.push("a@x.test", &["b@y.test".into()], SIMPLE, 1_000);
        }
        assert_eq!(state.store().lock().unwrap().list(10).len(), 1);
    }
```

Run: `cd apps/devbench/src-tauri && cargo test a_new_email_state_reports_not_listening`
Expected: FAIL to compile — `EmailState` and `SmtpStatus` do not exist.

- [ ] **Step 2: Implement `EmailState`**

Append to `apps/devbench/src-tauri/src/email_state.rs`, above the `#[cfg(test)]` block:
```rust
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SmtpStatus {
    pub listening: bool,
    pub port: u16,
    /// Populated when the catcher could not start. Rendered verbatim in the
    /// Email tab so the user learns *why* no mail is being caught, rather than
    /// staring at an empty inbox that looks like "the backend sent nothing".
    pub error: Option<String>,
}

/// Tauri-managed email state: the inbox plus the catcher's health.
pub struct EmailState {
    store: Arc<Mutex<EmailStore>>,
    status: Mutex<SmtpStatus>,
}

impl EmailState {
    pub fn new() -> Self {
        Self {
            store: Arc::new(Mutex::new(EmailStore::new(MAX_INBOX_MESSAGES))),
            status: Mutex::new(SmtpStatus { listening: false, port: DEFAULT_SMTP_PORT, error: None }),
        }
    }

    /// Handed to the catcher thread; also read by the commands.
    pub fn store(&self) -> Arc<Mutex<EmailStore>> {
        Arc::clone(&self.store)
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
```

Run: `cd apps/devbench/src-tauri && cargo test email_state::`
Expected: PASS (eleven tests)

- [ ] **Step 3: Start the catcher in `main.rs`**

Modify `apps/devbench/src-tauri/src/main.rs` — add the imports and, inside `.setup(...)` after the `CorrelationRegistry` line:
```rust
use devbench::email_state::{EmailState, SmtpStatus, DEFAULT_SMTP_PORT};
use devbench::smtp_catcher;
```
```rust
            let emails = Arc::new(EmailState::new());
            // Bind BEFORE spawning: `serve()` blocks forever and can only
            // report a bind failure by returning, so a port conflict would
            // otherwise be invisible. Binding here turns it into a status the
            // Email tab can show — and deliberately does NOT abort startup,
            // because an app that refuses to launch cannot offer the "change
            // the port in Settings" shortcut the spec asks for.
            match smtp_catcher::bind(DEFAULT_SMTP_PORT) {
                Ok(listener) => {
                    let store = emails.store();
                    emails.set_status(SmtpStatus {
                        listening: true,
                        port: DEFAULT_SMTP_PORT,
                        error: None,
                    });
                    let emails_for_thread = Arc::clone(&emails);
                    // A dedicated OS thread, not a tokio task: mailin-embedded
                    // is blocking and runs its own scoped threadpool.
                    std::thread::spawn(move || {
                        if let Err(e) = smtp_catcher::serve(listener, store) {
                            emails_for_thread.set_status(SmtpStatus {
                                listening: false,
                                port: DEFAULT_SMTP_PORT,
                                error: Some(e),
                            });
                        }
                    });
                }
                Err(e) => {
                    eprintln!("SMTP catcher did not start: {e}");
                    emails.set_status(SmtpStatus {
                        listening: false,
                        port: DEFAULT_SMTP_PORT,
                        error: Some(e),
                    });
                }
            }
            app.manage(emails);
```

Add the new commands to `generate_handler!` (they are created in Task 4):
```rust
            commands::email::list_emails,
            commands::email::get_email,
            commands::email::clear_emails,
            commands::email::smtp_status,
```

`main.rs` will not compile until Task 4 exists. Backend unit tests (`cargo test --lib`) still run, because they do not build `main.rs`.

- [ ] **Step 4: Commit**

```bash
git add apps/devbench/src-tauri/src/email_state.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): bind the SMTP catcher at startup and expose its status"
```

---

### Task 4: Email Tauri commands

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/email.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Test: inline `#[cfg(test)]` module in `email.rs`

**Interfaces:**
- Consumes: `EmailState` (Task 3).
- Produces: Tauri commands `list_emails(limit: usize) -> Result<Vec<EmailSummary>, String>`, `get_email(id: u64) -> Result<CapturedEmail, String>`, `clear_emails() -> Result<(), String>`, `smtp_status() -> Result<SmtpStatus, String>`. Task 6's `lib/tauri.ts` mirrors these names exactly.

- [ ] **Step 1: Write the command module with its tests**

`apps/devbench/src-tauri/src/commands/email.rs`:
```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test list_emails_returns_newest_first`
Expected: FAIL to compile — `commands::email` is not declared.

- [ ] **Step 3: Register the module**

`apps/devbench/src-tauri/src/commands/mod.rs`:
```rust
pub mod correlation;
pub mod db;
pub mod email;
pub mod history;
pub mod logs;
pub mod request;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib email::`
Expected: PASS (four tests)

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/email.rs apps/devbench/src-tauri/src/commands/mod.rs
git commit -m "feat(devbench): add email inbox Tauri commands"
```

---

### Task 5: Extend the correlation window to email

**Files:**
- Modify: `apps/devbench/src-tauri/src/correlation_state.rs`
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`
- Test: inline `#[cfg(test)]` module in `correlation.rs`

**Interfaces:**
- Consumes: `EmailState` (Task 3), `CorrelationRegistry` / `OpenWindow` (Plan 2 Task 6).
- Changes:
  - `OpenWindow` gains `pub from_email_id: u64`; `CorrelationRegistry::open` gains a `from_email_id` parameter.
  - `CorrelationWindowResult` gains `pub emails: Option<Vec<EmailSummary>>` and `pub emails_truncated: bool`.
  - `run_correlated_request_impl_with_registry` and `collect_correlation_window_impl` each gain an `emails: &EmailState` parameter.
  Task 6 mirrors the new fields; Task 8's `Rollup` renders them.

The structural work here is small precisely because Plan 2 built the two-phase machinery generically: emails are a second cursor with the same `next_id` / `between` / `evicted_through_id` contract as logs. That symmetry was Decision 1 of Plan 2 paying off.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `apps/devbench/src-tauri/src/commands/correlation.rs`:
```rust
    use crate::email_state::EmailState;

    const TEST_EMAIL: &str = "Subject: Order confirmation #8841\r\n\r\nThanks for your order.\r\n";

    #[tokio::test]
    async fn a_correlation_window_captures_mail_sent_during_the_request() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = EmailState::new();
        let registry = CorrelationRegistry::new();

        let store_for_mock = emails.store();
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/orders")
            .with_status(201)
            // Pushing into the inbox from inside the mock's body callback puts
            // the capture strictly between the request being sent and the
            // response landing — the same shape as a real backend sending mail
            // mid-request, without needing a live SMTP round trip here (that
            // is covered end to end in Task 9).
            .with_body_from_request(move |_req| {
                store_for_mock
                    .lock()
                    .unwrap()
                    .push("orders@shop.test", &["customer@example.com".into()], TEST_EMAIL, 10_100);
                br#"{"id":8841}"#.to_vec()
            })
            .create_async()
            .await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput {
                method: "POST".to_string(),
                url: format!("{}/orders", server.url()),
                body: None,
            },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
        )
        .await
        .unwrap();

        mock.assert_async().await;

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
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
    async fn mail_sent_before_the_request_is_not_attributed_to_it() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = EmailState::new();
        let registry = CorrelationRegistry::new();

        emails
            .store()
            .lock()
            .unwrap()
            .push("old@shop.test", &["someone@example.com".into()], TEST_EMAIL, 5_000);

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
        )
        .await
        .unwrap();
        mock.assert_async().await;

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
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

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
        )
        .await
        .unwrap();
        mock.assert_async().await;

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
            &emails,
            result.correlation_id,
            10_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
        )
        .await
        .unwrap();

        assert_eq!(window.emails, None, "a catcher that is not listening means NOT OBSERVED, not zero mail");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test a_correlation_window_captures_mail`
Expected: FAIL to compile — the two `_impl` functions take one argument fewer and `CorrelationWindowResult` has no `emails`.

- [ ] **Step 3: Add the email cursor**

Modify `apps/devbench/src-tauri/src/correlation_state.rs` — extend `OpenWindow` and `open`:
```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpenWindow {
    /// Log-buffer id recorded immediately BEFORE the request was fired.
    pub from_log_id: u64,
    /// Inbox id recorded at the same instant, for the same reason.
    pub from_email_id: u64,
    pub window_ends_at_ms: i64,
}

impl CorrelationRegistry {
    pub fn open(&self, from_log_id: u64, from_email_id: u64, window_ends_at_ms: i64) -> String {
        let id = Uuid::new_v4().to_string();
        if let Ok(mut windows) = self.windows.lock() {
            windows.retain(|_, w| w.window_ends_at_ms + WINDOW_RETENTION_MS > window_ends_at_ms);
            windows.insert(id.clone(), OpenWindow { from_log_id, from_email_id, window_ends_at_ms });
        }
        id
    }
    // `take` and `len` are unchanged.
}
```

Update the Plan 2 test `a_window_can_only_be_collected_once`, whose `registry.open(0, 500)` call becomes `registry.open(0, 0, 500)`.

- [ ] **Step 4: Extend the correlation commands**

Modify `apps/devbench/src-tauri/src/commands/correlation.rs`:
```rust
use crate::email_state::{EmailState, EmailSummary};

#[derive(Debug, Serialize, PartialEq)]
pub struct CorrelationWindowResult {
    /// `None` = no log source configured, so logs were NOT observed.
    pub log_lines: Option<Vec<LogLine>>,
    pub log_lines_truncated: bool,
    /// `None` = the SMTP catcher is not listening, so mail was NOT observed.
    /// `Some(vec![])` = it was listening and nothing was sent.
    pub emails: Option<Vec<EmailSummary>>,
    pub emails_truncated: bool,
}

pub async fn run_correlated_request_impl_with_registry(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
    logs: &LogState,
    emails: &EmailState,
    registry: &CorrelationRegistry,
    now_ms: i64,
) -> Result<CorrelationResult, String> {
    // Both cursors are snapshotted before anything else: every line logged and
    // every message sent from this instant on is attributable to this request.
    let from_log_id = logs.next_line_id().saturating_sub(1);
    let from_email_id = emails
        .store()
        .lock()
        .map(|s| s.next_id().saturating_sub(1))
        .unwrap_or(0);

    let mut result =
        run_correlated_request_impl(request, connection, watched_tables, logs).await?;

    result.correlation_id =
        registry.open(from_log_id, from_email_id, now_ms + DEFAULT_CORRELATION_WINDOW_MS);
    Ok(result)
}

pub async fn collect_correlation_window_impl(
    registry: &CorrelationRegistry,
    logs: &LogState,
    emails: &EmailState,
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
    let log_lines_truncated =
        log_lines.is_some() && logs.read_since(window.from_log_id, None, 1).dropped > 0;

    // A catcher that is not listening did not observe anything — reporting
    // zero mail would be a false negative, which principle 4 forbids.
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

    Ok(CorrelationWindowResult {
        log_lines,
        log_lines_truncated,
        emails: captured,
        emails_truncated,
    })
}

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

Update the `run_correlated_request` Tauri command to take `emails: State<'_, Arc<EmailState>>` and pass `&emails` through, and update the three Plan 2 tests that call the two `_impl` functions so each gains its `&EmailState::new()` argument.

**One catch:** the three new tests above construct `EmailState::new()`, whose default status is `listening: false`. Two of them expect `Some(...)`. Add a helper next to them and use it in the first two tests:
```rust
    fn listening_email_state() -> EmailState {
        let state = EmailState::new();
        state.set_status(crate::email_state::SmtpStatus {
            listening: true,
            port: crate::email_state::DEFAULT_SMTP_PORT,
            error: None,
        });
        state
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test correlation::`
Expected: PASS

- [ ] **Step 6: Confirm the whole backend still builds**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS — everything from Plans 1 and 2 plus Tasks 1–5.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src-tauri
git commit -m "feat(devbench): correlate captured emails inside the request window"
```

---

### Task 6: Frontend types, wrappers, and the Email tab entry

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/App.test.tsx`

**Interfaces:**
- Consumes: the command names and shapes from Tasks 4–5.
- Produces: `TabId = "api" | "db" | "log" | "email"`, a fourth `TABS` entry, and `invokeListEmails`, `invokeGetEmail`, `invokeClearEmails`, `invokeSmtpStatus`. Tasks 7–8 import these names.

Because Plan 2 turned the tab bar into a mapped list, adding Email is one array entry and one branch — not a fourth hand-written `<button>` block.

- [ ] **Step 1: Add types and wrappers**

Modify `apps/devbench/src/lib/tauri.ts` — update `CorrelationWindowResult` and append:
```ts
export interface CorrelationWindowResult {
  /** `null` means no log source is configured — logs were not observed at all. */
  log_lines: LogLine[] | null;
  log_lines_truncated: boolean;
  /** `null` means the SMTP catcher is not listening — mail was not observed at all. */
  emails: EmailSummary[] | null;
  emails_truncated: boolean;
}

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

- [ ] **Step 2: Extend `TabId`**

Modify `apps/devbench/src/store/useAppStore.ts`:
```ts
export type TabId = "api" | "db" | "log" | "email";
```

- [ ] **Step 3: Write the failing App test**

Modify the first test in `apps/devbench/src/App.test.tsx`:
```tsx
  it("renders the DevBench brand and one tab per configured tool", () => {
    render(<App />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["API", "DB", "Log", "Email"]);
  });
```

Run: `bun run test -- App.test.tsx`
Expected: FAIL — three tabs.

- [ ] **Step 4: Add the tab**

Modify `apps/devbench/src/App.tsx` — add the import, the array entry, and the branch:
```tsx
import { EmailTab } from "./components/email/EmailTab";
```
```tsx
export const TABS: { id: TabId; label: string }[] = [
  { id: "api", label: "API" },
  { id: "db", label: "DB" },
  { id: "log", label: "Log" },
  { id: "email", label: "Email" },
];
```
```tsx
        {activeTab === "email" ? <EmailTab /> : null}
```

- [ ] **Step 5: Commit (tests go green once Task 7 creates `EmailTab`)**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/store apps/devbench/src/App.tsx apps/devbench/src/App.test.tsx
git commit -m "feat(devbench): extend TabId to email and add the Email tab entry"
```

---

### Task 7: `EmailInbox`, `EmailViewer`, and `EmailTab`

**Files:**
- Create: `apps/devbench/src/components/email/EmailInbox.tsx`
- Create: `apps/devbench/src/components/email/EmailInbox.test.tsx`
- Create: `apps/devbench/src/components/email/EmailViewer.tsx`
- Create: `apps/devbench/src/components/email/EmailViewer.test.tsx`
- Create: `apps/devbench/src/components/email/EmailTab.tsx`

**Interfaces:**
- Consumes: `invokeListEmails`, `invokeGetEmail`, `invokeClearEmails`, `invokeSmtpStatus` (Task 6).
- Produces: `<EmailTab focusEmailId?: number | null />`, mounted by `App.tsx`. The optional prop exists now so Task 8's rollup deep-link is pure wiring.

Same internal pattern as the other three tools: list sidebar on the left, detail on the right.

- [ ] **Step 1: Write the failing inbox test**

`apps/devbench/src/components/email/EmailInbox.test.tsx`:
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
    render(<EmailInbox emails={emails} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText("Order confirmation #8841")).toBeInTheDocument();
    expect(screen.getByText("orders@shop.test")).toBeInTheDocument();
  });

  it("marks the selected message", () => {
    render(<EmailInbox emails={emails} selectedId={2} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByRole("button", { name: /Order confirmation/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Welcome to the beta/ })).toHaveAttribute("aria-current", "false");
  });

  it("selects a message when clicked", () => {
    const onSelect = vi.fn();
    render(<EmailInbox emails={emails} selectedId={null} onSelect={onSelect} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Welcome to the beta/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("shows an empty state that explains the SMTP setup", () => {
    render(<EmailInbox emails={[]} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText(/point your backend's SMTP/i)).toBeInTheDocument();
  });

  it("clears the inbox", () => {
    const onClear = vi.fn();
    render(<EmailInbox emails={emails} selectedId={null} onSelect={() => {}} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear inbox" }));
    expect(onClear).toHaveBeenCalled();
  });
});
```

Run: `bun run test -- EmailInbox.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 2: Implement `EmailInbox`**

`apps/devbench/src/components/email/EmailInbox.tsx`:
```tsx
import type { EmailSummary } from "../../lib/tauri";

function shortTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function EmailInbox({
  emails,
  selectedId,
  onSelect,
  onClear,
}: {
  emails: EmailSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onClear: () => void;
}) {
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
      {emails.length === 0 ? (
        <div className="p-4 text-xs text-text-faint">
          No mail caught yet. Point your backend's SMTP host at{" "}
          <code className="font-mono">localhost</code> and the port shown below.
        </div>
      ) : (
        <div className="flex flex-col overflow-y-auto">
          {emails.map((email) => (
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
    </aside>
  );
}
```

Run: `bun run test -- EmailInbox.test.tsx`
Expected: PASS

- [ ] **Step 3: Write the failing viewer test**

`apps/devbench/src/components/email/EmailViewer.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmailViewer } from "./EmailViewer";
import type { CapturedEmail } from "../../lib/tauri";

const email: CapturedEmail = {
  id: 1,
  captured_at_ms: 1_800_000_000_000,
  from: "orders@shop.test",
  to: ["customer@example.com"],
  subject: "Order confirmation #8841",
  size_bytes: 300,
  html_body: "<h2>Thanks for your order.</h2>",
  text_body: "Thanks for your order.",
  raw: "Subject: Order confirmation #8841\r\nFrom: orders@shop.test\r\n\r\nThanks for your order.\r\n",
};

describe("EmailViewer", () => {
  it("prompts when nothing is selected", () => {
    render(<EmailViewer email={null} />);
    expect(screen.getByText(/select a message/i)).toBeInTheDocument();
  });

  it("shows the subject and the envelope from/to", () => {
    render(<EmailViewer email={email} />);
    expect(screen.getByText("Order confirmation #8841")).toBeInTheDocument();
    expect(screen.getByText(/orders@shop\.test/)).toBeInTheDocument();
    expect(screen.getByText(/customer@example\.com/)).toBeInTheDocument();
  });

  // Captured HTML is untrusted and the webview has `invoke` on `window`.
  // It must never reach the app's own DOM.
  it("renders HTML inside a fully sandboxed iframe, never inline", () => {
    render(<EmailViewer email={email} />);
    const frame = screen.getByTitle("Email HTML body");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain("<h2>Thanks for your order.</h2>");
    expect(document.querySelector("h2")).toBeNull();
  });

  it("switches to the plain-text view", () => {
    render(<EmailViewer email={email} />);
    fireEvent.click(screen.getByRole("tab", { name: "Plain" }));
    expect(screen.getByText("Thanks for your order.")).toBeInTheDocument();
  });

  it("switches to the raw view", () => {
    render(<EmailViewer email={email} />);
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByTestId("email-raw").textContent).toContain("Subject: Order confirmation #8841");
  });

  it("shows only the header block in the headers view", () => {
    render(<EmailViewer email={email} />);
    fireEvent.click(screen.getByRole("tab", { name: "Headers" }));
    const headers = screen.getByTestId("email-headers").textContent ?? "";
    expect(headers).toContain("From: orders@shop.test");
    expect(headers).not.toContain("Thanks for your order.");
  });

  it("says so when a message has no HTML part rather than showing a blank frame", () => {
    render(<EmailViewer email={{ ...email, html_body: null }} />);
    expect(screen.getByText(/no html part/i)).toBeInTheDocument();
  });
});
```

Run: `bun run test -- EmailViewer.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 4: Implement `EmailViewer`**

`apps/devbench/src/components/email/EmailViewer.tsx`:
```tsx
import { useState } from "react";
import type { CapturedEmail } from "../../lib/tauri";

type ViewMode = "html" | "plain" | "raw" | "headers";

const MODES: { id: ViewMode; label: string }[] = [
  { id: "html", label: "HTML" },
  { id: "plain", label: "Plain" },
  { id: "raw", label: "Raw" },
  { id: "headers", label: "Headers" },
];

/** RFC 5322: headers are everything before the first empty line. */
function headerBlock(raw: string): string {
  const separator = raw.search(/\r?\n\r?\n/);
  return separator === -1 ? raw : raw.slice(0, separator);
}

export function EmailViewer({ email }: { email: CapturedEmail | null }) {
  const [mode, setMode] = useState<ViewMode>("html");

  if (!email) {
    return <div className="p-6 text-sm text-text-faint">Select a message to read it.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-4">
        <div className="text-base font-semibold text-text">{email.subject}</div>
        <div className="mt-1 font-mono text-xs text-text-muted">
          from {email.from} · to {email.to.join(", ")}
        </div>
      </div>

      <div className="flex gap-1 border-b border-border px-3 py-2" role="tablist" aria-label="Message view">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => setMode(m.id)}
            className={`rounded-sm px-2.5 py-1 text-xs font-medium ${
              mode === m.id ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {mode === "html" ? (
          email.html_body ? (
            // A caught message is untrusted input, and this webview exposes
            // `invoke` on `window`. An empty `sandbox` attribute grants NO
            // capabilities — no scripts, no forms, no same-origin — which is
            // the only safe way to render it. Never dangerouslySetInnerHTML.
            <iframe
              title="Email HTML body"
              sandbox=""
              srcDoc={email.html_body}
              className="h-full w-full border-0 bg-surface"
            />
          ) : (
            <div className="p-4 text-sm text-text-faint">This message has no HTML part.</div>
          )
        ) : null}

        {mode === "plain" ? (
          email.text_body ? (
            <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-text">{email.text_body}</pre>
          ) : (
            <div className="p-4 text-sm text-text-faint">This message has no plain-text part.</div>
          )
        ) : null}

        {mode === "raw" ? (
          <pre data-testid="email-raw" className="whitespace-pre-wrap p-4 font-mono text-xs text-text">
            {email.raw}
          </pre>
        ) : null}

        {mode === "headers" ? (
          <pre data-testid="email-headers" className="whitespace-pre-wrap p-4 font-mono text-xs text-text">
            {headerBlock(email.raw)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
```

Run: `bun run test -- EmailViewer.test.tsx`
Expected: PASS (seven tests)

- [ ] **Step 5: Assemble `EmailTab`**

`apps/devbench/src/components/email/EmailTab.tsx`:
```tsx
import { useCallback, useEffect, useState } from "react";
import { EmailInbox } from "./EmailInbox";
import { EmailViewer } from "./EmailViewer";
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

export function EmailTab({ focusEmailId = null }: { focusEmailId?: number | null }) {
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<CapturedEmail | null>(null);
  const [status, setStatus] = useState<SmtpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEmails(await invokeListEmails(200));
    } catch {
      // A transient IPC failure is not worth tearing the pane down.
    }
  }, []);

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
      await invokeClearEmails();
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

- [ ] **Step 6: Run the full frontend suite**

Run: `bun run test`
Expected: PASS — including `App.test.tsx`, which can now resolve `EmailTab`.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/components/email
git commit -m "feat(devbench): add the Email tab with inbox and sandboxed message viewer"
```

---

### Task 8: The third rollup chip and end-to-end wiring

**Files:**
- Modify: `apps/devbench/src/components/rollup/Rollup.tsx`
- Modify: `apps/devbench/src/components/rollup/Rollup.test.tsx`
- Modify: `apps/devbench/src/components/api/ApiTab.tsx`

**Interfaces:**
- Changes: `RollupData` gains `emails: EmailSummary[] | null` and `emailsTruncated: boolean`; `<Rollup />` gains an `onOpenEmail: (emailId: number | null) => void` prop.
- Produces: the complete three-source rollup — `DB · N writes → | Log · N lines → | Email · N sent →` — which is the designed shape in `docs/mockups/devbench.html` and the summary the v1 spec describes ("3 DB writes, 12 log lines, 1 email").

Plan 2 built the chip row by mapping over an array specifically so this task is one branch plus one field. That prediction is now cashed in.

- [ ] **Step 1: Extend the Rollup tests**

Modify `apps/devbench/src/components/rollup/Rollup.test.tsx` — update the `data()` helper and append four tests:
```tsx
function data(over: Partial<RollupData> = {}): RollupData {
  return {
    tableDiffs: [],
    watchedTableCount: 0,
    logLines: null,
    logLinesTruncated: false,
    emails: null,
    emailsTruncated: false,
    dbError: null,
    windowOpen: false,
    ...over,
  };
}
```
```tsx
  it("shows an email chip with the sent count and deep-links to the Email tab", () => {
    const onOpenEmail = vi.fn();
    render(
      <Rollup
        data={data({
          watchedTableCount: 1,
          emails: [
            {
              id: 7,
              captured_at_ms: 1,
              from: "orders@shop.test",
              to: ["customer@example.com"],
              subject: "Order confirmation #8841",
              size_bytes: 100,
            },
          ],
        })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
        onOpenEmail={onOpenEmail}
      />,
    );
    const chip = screen.getByRole("button", { name: /Email.*1 sent/ });
    fireEvent.click(chip);
    // Deep-links to the specific message, not just the tab.
    expect(onOpenEmail).toHaveBeenCalledWith(7);
  });

  it("says mail was not observed when the catcher is not listening, not '0 sent'", () => {
    render(
      <Rollup
        data={data({ watchedTableCount: 1, emails: null })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
        onOpenEmail={() => {}}
      />,
    );
    expect(screen.getByText(/email: not observed/i)).toBeInTheDocument();
  });

  it("reports zero sent distinctly from not observed", () => {
    render(
      <Rollup
        data={data({ watchedTableCount: 1, emails: [] })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
        onOpenEmail={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Email.*0 sent/ })).toBeInTheDocument();
    expect(screen.queryByText(/email: not observed/i)).not.toBeInTheDocument();
  });

  it("renders the email count as N+ when the inbox evicted messages from the window", () => {
    render(
      <Rollup
        data={data({
          watchedTableCount: 1,
          emails: [
            { id: 1, captured_at_ms: 1, from: "a@x.test", to: ["b@y.test"], subject: "s", size_bytes: 1 },
          ],
          emailsTruncated: true,
        })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
        onOpenEmail={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Email.*1\+ sent/ })).toBeInTheDocument();
  });
```

Every existing test in this file needs `onOpenEmail={() => {}}` added to its `<Rollup />` props.

Run: `bun run test -- Rollup.test.tsx`
Expected: FAIL — `RollupData` has no `emails` and `<Rollup />` has no `onOpenEmail`.

- [ ] **Step 2: Add the chip**

Modify `apps/devbench/src/components/rollup/Rollup.tsx`:
```tsx
import type { EmailSummary, LogLine, TableDiff } from "../../lib/tauri";

export interface RollupData {
  /** `null` = the DB was not verified. `[]` = verified, nothing changed. */
  tableDiffs: TableDiff[] | null;
  watchedTableCount: number;
  /** `null` = no log source configured, so logs were not observed. */
  logLines: LogLine[] | null;
  logLinesTruncated: boolean;
  /** `null` = the SMTP catcher is not listening, so mail was not observed. */
  emails: EmailSummary[] | null;
  emailsTruncated: boolean;
  dbError: string | null;
  /** True while the correlation window has not closed yet. */
  windowOpen: boolean;
}
```

Add the `onOpenEmail` prop to the component signature:
```tsx
export function Rollup({
  data,
  loading,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
}: {
  data: RollupData | null;
  loading: boolean;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
}) {
```

And append the third chip block, immediately after the `// --- Log ---` block and before `const perTable = ...`:
```tsx
  // --- Email ---
  if (data.windowOpen) {
    chips.push(
      <span key="email" data-testid="rollup-email-pending" className="flex items-center gap-1.5 text-sm text-text-faint">
        <span className="h-3 w-16 animate-pulse rounded bg-surface-2" />
      </span>,
    );
  } else if (data.emails === null) {
    chips.push(<Note key="email">Email: not observed — the SMTP catcher is not running.</Note>);
  } else {
    const n = data.emails.length;
    chips.push(
      <Chip
        key="email"
        label="Email"
        count={`${n}${data.emailsTruncated ? "+" : ""} sent`}
        // Deep-link to the first message in the window when there is one, so
        // the Email tab opens on the mail this request actually caused rather
        // than on whatever happened to be selected.
        onClick={() => onOpenEmail(data.emails && data.emails.length > 0 ? data.emails[0].id : null)}
      />,
    );
  }
```

Run: `bun run test -- Rollup.test.tsx`
Expected: PASS (thirteen tests)

- [ ] **Step 3: Wire `ApiTab`**

Modify `apps/devbench/src/components/api/ApiTab.tsx`:
- Accept a second callback prop: `export function ApiTab({ onOpenTableInDb, onOpenEmail }: { onOpenTableInDb: (table: string) => void; onOpenEmail: (emailId: number | null) => void })`.
- Add `emails: null, emailsTruncated: false` to the two `rollup: {...}` object literals (`handleResult`'s initial state and `handleHistorySelect`'s).
- In `handleResult`'s success path, carry the new fields through:
```tsx
      const window = await invokeCollectCorrelationWindow(correlation.correlation_id);
      setResult((prev) =>
        prev
          ? {
              ...prev,
              rollup: {
                ...prev.rollup,
                logLines: window.log_lines,
                logLinesTruncated: window.log_lines_truncated,
                emails: window.emails,
                emailsTruncated: window.emails_truncated,
                windowOpen: false,
              },
            }
          : prev,
      );
```
- In its `catch` branch, close both sources as not-observed:
```tsx
      setResult((prev) =>
        prev
          ? { ...prev, rollup: { ...prev.rollup, logLines: null, emails: null, windowOpen: false } }
          : prev,
      );
```
- Add a handler and pass it down:
```tsx
  function handleOpenEmail(emailId: number | null) {
    setActiveTab("email");
    onOpenEmail(emailId);
  }
```
```tsx
              <Rollup
                data={result?.rollup ?? null}
                loading={sending}
                onOpenDb={handleOpenDb}
                onOpenLog={() => setActiveTab("log")}
                onOpenEmail={handleOpenEmail}
              />
```

Modify `apps/devbench/src/App.tsx` to own the focused-email state and thread it through:
```tsx
  const [emailFocusId, setEmailFocusId] = useState<number | null>(null);
```
```tsx
        {activeTab === "api" ? (
          <ApiTab onOpenTableInDb={setDbFocusTable} onOpenEmail={setEmailFocusId} />
        ) : null}
```
```tsx
        {activeTab === "email" ? <EmailTab focusEmailId={emailFocusId} /> : null}
```

- [ ] **Step 4: Run the full frontend suite**

Run: `bun run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src
git commit -m "feat(devbench): complete the three-source rollup with the Email chip"
```

---

### Task 9: End-to-end verification of the complete rollup

**Files:**
- Modify: `apps/devbench/src-tauri/tests/smoke_test.rs`

**Interfaces:**
- Consumes: everything above. Produces no new interfaces — this is the proof that firing one request surfaces all three observed sources, against a real Postgres, a real HTTP server, a real file on disk, and a real SMTP socket.

- [ ] **Step 1: Add the full three-source smoke test**

Append to `apps/devbench/src-tauri/tests/smoke_test.rs`:
```rust
use devbench::email_state::{EmailState, SmtpStatus};
use devbench::smtp_catcher;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;

/// Reads SMTP reply lines until one has a space after the code.
fn read_smtp_reply(reader: &mut BufReader<TcpStream>) -> String {
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 {
            return String::new();
        }
        if line.len() >= 4 && line.as_bytes()[3] == b' ' {
            return line;
        }
    }
}

/// Sends one message through a real SMTP conversation, exactly as a target
/// backend's mailer would.
fn send_test_mail(port: u16, subject: &str) {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);

    assert!(read_smtp_reply(&mut reader).starts_with("220"));
    write!(writer, "EHLO backend\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "MAIL FROM:<orders@shop.test>\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "RCPT TO:<customer@example.com>\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "DATA\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "Subject: {subject}\r\n\r\nThanks for your order.\r\n.\r\n").unwrap();
    read_smtp_reply(&mut reader);
    write!(writer, "QUIT\r\n").unwrap();
    read_smtp_reply(&mut reader);
}

#[tokio::test]
async fn firing_a_request_correlates_db_writes_log_lines_and_sent_mail() {
    let conn = test_connection();
    let pool = PgPoolOptions::new()
        .connect(&format!(
            "postgres://{}:{}@{}:{}/{}",
            conn.username, conn.password, conn.host, conn.port, conn.database
        ))
        .await
        .expect("requires a real local Postgres");

    sqlx::query("DROP TABLE IF EXISTS smoke_full_orders").execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE smoke_full_orders (id serial PRIMARY KEY, status text)")
        .execute(&pool)
        .await
        .unwrap();

    // --- log source ---
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("backend.log");
    std::fs::write(&log_path, "").unwrap();
    let logs = LogState::new();
    logs.add_source("backend.log".into(), log_path.clone()).unwrap();
    logs.poll_all(1_000);

    // --- SMTP catcher on an OS-assigned port, so the test never collides
    //     with a real Mailhog on 1025 ---
    let emails = EmailState::new();
    let listener = smtp_catcher::bind(0).unwrap();
    let smtp_port = listener.local_addr().unwrap().port();
    let store = emails.store();
    std::thread::spawn(move || {
        let _ = smtp_catcher::serve(listener, store);
    });
    emails.set_status(SmtpStatus { listening: true, port: smtp_port, error: None });

    let registry = CorrelationRegistry::new();

    // The mocked backend does all three things a real one would during the
    // request: writes a row, writes a log line, and sends mail.
    let mut server = mockito::Server::new_async().await;
    let insert_conn = format!(
        "postgres://{}:{}@{}:{}/{}",
        conn.username, conn.password, conn.host, conn.port, conn.database
    );
    let log_for_mock = log_path.clone();
    let mock = server
        .mock("POST", "/orders")
        .with_status(201)
        .with_body_from_request(move |_req| {
            let conn_str = insert_conn.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                rt.block_on(async {
                    let p = PgPoolOptions::new().max_connections(1).connect(&conn_str).await.unwrap();
                    sqlx::query("INSERT INTO smoke_full_orders (status) VALUES ('pending')")
                        .execute(&p)
                        .await
                        .unwrap();
                });
            })
            .join()
            .unwrap();

            let mut f = std::fs::OpenOptions::new().append(true).open(&log_for_mock).unwrap();
            writeln!(f, r#"{{"level":"info","msg":"order created id=1"}}"#).unwrap();
            f.flush().unwrap();

            send_test_mail(smtp_port, "Order confirmation #8841");

            br#"{"id":1}"#.to_vec()
        })
        .create_async()
        .await;

    let result = run_correlated_request_impl_with_registry(
        FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/orders", server.url()),
            body: None,
        },
        conn,
        vec!["smoke_full_orders".to_string()],
        &logs,
        &emails,
        &registry,
        50_000,
    )
    .await
    .expect("correlated request should succeed");

    mock.assert_async().await;

    // --- DB ---
    let diffs = result.table_diffs.expect("DB should have been verified");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].table, "smoke_full_orders");
    assert_eq!(diffs[0].inserted, 1);

    // The tailer and the SMTP handler both run outside this task; drive the
    // tailer explicitly and give the catcher thread a moment to finish DATA.
    for _ in 0..100 {
        logs.poll_all(50_100);
        if emails.store().lock().unwrap().list(10).len() == 1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        &emails,
        result.correlation_id,
        50_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    // --- Log ---
    let lines = window.log_lines.expect("a source is configured, so lines must be Some");
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].message, "order created id=1");

    // --- Email ---
    let captured = window.emails.expect("the catcher is listening, so emails must be Some");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].subject, "Order confirmation #8841");
    assert_eq!(captured[0].from, "orders@shop.test");
    assert_eq!(captured[0].to, vec!["customer@example.com".to_string()]);

    sqlx::query("DROP TABLE smoke_full_orders").execute(&pool).await.unwrap();
}
```

Note: the message is captured with `chrono::Utc::now()` (real wall-clock), while the window ends at the synthetic `50_000 + 5_000`. That comparison holds because the real epoch-millis clock is many orders of magnitude larger than 55,000 — so a real capture is never *before* a synthetic window bound... which would make `between`'s upper bound reject it. **Therefore this test asserts against a store seeded through the real catcher but with the window bound taken from the same clock:** replace the `now_ms` argument `50_000` with `chrono::Utc::now().timestamp_millis()` and the collect bound with `chrono::Utc::now().timestamp_millis() + DEFAULT_CORRELATION_WINDOW_MS + 1`, and drive `logs.poll_all(chrono::Utc::now().timestamp_millis())` in the wait loop. Use real timestamps consistently in this test; the synthetic-clock tests in Task 5 cover the boundary logic itself.

- [ ] **Step 2: Run the whole backend suite**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS — Plans 1 and 2 plus everything here.

- [ ] **Step 3: Run the whole frontend suite**

Run: `cd apps/devbench && bun run test`
Expected: PASS

- [ ] **Step 4: Verify the port-conflict path by hand**

```bash
# Occupy 1025 the way a stray Mailhog would.
python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',1025));s.listen();input('holding 1025, press enter to release')" &
cd apps/devbench && bun run tauri dev
```
Expected: the app **launches normally**; the Email tab's status bar reads `SMTP catcher is not running: SMTP port 1025 is unavailable … Mailhog/Mailpit may be running`; the API, DB, and Log tabs are fully usable; the rollup's Email slot reads "not observed", never "0 sent". Release the port and restart to confirm the status flips to `Listening on localhost:1025`.

- [ ] **Step 5: Verify the full loop by hand**

```bash
printf '' > /tmp/devbench.log
cd apps/devbench && bun run tauri dev
```
In the app: DB tab → watch a table. Log tab → Add → `/tmp/devbench.log`. Email tab → confirm `Listening on localhost:1025`. API tab → fire a request. Within 5 seconds, from a terminal, append a log line and send a message:
```bash
echo '{"level":"info","msg":"hello"}' >> /tmp/devbench.log
python3 - <<'PY'
import smtplib
from email.message import EmailMessage
m = EmailMessage()
m["Subject"] = "Order confirmation #8841"
m["From"] = "orders@shop.test"
m["To"] = "customer@example.com"
m.set_content("Thanks for your order.")
with smtplib.SMTP("localhost", 1025) as s:
    s.send_message(m)
PY
```
Expected: the response paints immediately; the Log and Email chips resolve when the window closes; clicking `Email · 1 sent →` switches to the Email tab with that message selected and its body rendered inside the sandboxed frame.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src-tauri/tests/smoke_test.rs
git commit -m "test(devbench): correlate DB writes, log lines, and sent mail end to end"
```

---

## Self-Review

**Spec coverage.** v1 spec, Email tab row: "local SMTP catcher (default port 1025, configurable), inbox view" — Tasks 2, 3, 7; configurability is Plan 4, flagged in Decision 3. Components: "Email tab: inbox list, message viewer (headers/body/raw)" — Task 7, all four modes. Operating context (PRODUCT.md): "Runs a local SMTP server (default port 1025) that the user's backend is pointed at to catch outgoing mail, the same integration pattern as Mailhog/Mailpit" — Tasks 2–3, with the status bar stating the port. Error handling: "SMTP port already bound (e.g. Mailhog also running locally) → DevBench fails fast at startup with a clear 'port 1025 in use' message and a shortcut into Settings to change the port" — Task 3 binds before serving and records the failure; the message names Mailhog/Mailpit; the Settings shortcut lands in Plan 4 when Settings exists, which is why the app is deliberately allowed to launch. Correlation engine: "collect any SMTP messages received in that window" — Task 5. IA: "a condensed summary (e.g. '3 DB writes, 12 log lines, 1 email') with jump-links that deep-link into the relevant tab, pre-filtered/scrolled to the relevant rows" — Task 8, with the Email chip deep-linking to the specific message. Deferred, per the phasing: Sessions/Archive, Split view, Settings (including SMTP port and correlation window), Chat dock (Plan 4); persisting the inbox across restarts (Plan 4's storage work, Decision 4); sending mail (explicitly out of v1 scope per the spec's Deferred column).

**Placeholder scan.** No TBD/TODO markers. Every code step contains the actual code, verified by compiling and running the handler, the `bind`/`serve` pair, and a full SMTP round trip before this plan was written. `DEFAULT_SMTP_PORT` and the in-memory inbox are the only two deliberate "later" items, both named as scoping decisions with the plan that closes them. Every `Result` is mapped to a real `format!` error string.

**Type consistency.** `CapturedEmail { id, captured_at_ms, from, to, subject, html_body, text_body, raw, size_bytes }` and `EmailSummary { id, captured_at_ms, from, to, subject, size_bytes }` are defined once in Task 1 and used with those exact names in Tasks 2, 4, 5, and mirrored once in `lib/tauri.ts` (Task 6), where `CapturedEmail extends EmailSummary` keeps the two from drifting. `SmtpStatus { listening, port, error }` is defined once in Task 3 and mirrored once in Task 6. `CorrelationWindowResult` gains `emails` / `emails_truncated` in Task 5 and is consumed with those names in Tasks 6 and 8. `OpenWindow` gains `from_email_id` in Task 5 and the single `registry.open` call site plus the one Plan 2 test that constructs it are both updated there. `RollupData` gains `emails` / `emailsTruncated` in Task 8 and every `<Rollup />` call site is updated in the same task. `EmailStore` deliberately mirrors `LogBuffer`'s `next_id` / `between` / `evicted_through_id` contract so `collect_correlation_window_impl` handles both sources with one shape.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-30-devbench-v1-email-tab.md`.
