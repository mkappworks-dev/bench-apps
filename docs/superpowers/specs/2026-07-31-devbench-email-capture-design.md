# DevBench — Email Capture v2 Design Spec

Date: 2026-07-31
Status: Approved for planning

Reference mockup: `docs/mockups/devbench-email-capture.html` (interactive — switch
sessions, select messages, filter, switch HTML/Plain/Raw/Headers, and click
"Sent by ..." to see the jump to History). Built on the same tokens/chrome as
`docs/mockups/devbench-v2-shell.html` from the in-flight v2 shell work.

## Context

Email capture already works: `smtp_catcher.rs` runs a real, loopback-only SMTP
server (`mailin-embedded`, no TLS/auth — a local catcher has nothing to
authenticate), and `email_state.rs` parses each message and stores it. What it
stores it in is the gap this spec closes: an in-memory `VecDeque` capped at 200
messages, wiped on every restart, with no notion of "session," no durable link
to the request that sent a message, and eviction tracked internally
(`evicted_through_id`) but never shown to the user.

`request_history` went through exactly this fork already, in
`2026-07-31-session-scoped-history-design.md`: it moved from unscoped rows to a
nullable `session_id` column, `ON DELETE SET NULL`, filtered with two distinct
queries rather than one `(?1 IS NULL OR session_id = ?1)` predicate. This spec
follows that precedent for captured mail, plus the one problem history didn't
have: a blocking, non-Tauri-command capture path that needs to reach the same
database.

## Scope

| In scope | Out of scope |
|---|---|
| Captured mail persists in SQLite, survives restart | Attachment extraction/download |
| Session-scoped inbox (nullable `session_id`, same semantics as history) | SMTP port live-rebind (already labeled in Settings; a separate, larger change) |
| Global rolling cap (5,000) with eviction visible in the UI | Per-session retention caps |
| Durable `request_id` link from a captured email to the request that sent it | Backend full-text search (LIKE query, pagination past 5,000) |
| Client-side subject/address filter over the polled list | A global "clear every session's mail" action |
| "Sent by `METHOD URL` → view in History" in EmailViewer, wired the same way as the existing DB/Email rollup deep-links | Multi-connection support (still absent generally; unrelated to this spec) |

## Architecture

`EmailState` stops owning the in-memory `VecDeque<CapturedEmail>` ring buffer.
It keeps only the ephemeral `SmtpStatus` mutex — catcher health is legitimately
transient, re-derived every launch. Persistence lives in a new
`captured_emails` table, written directly by `CatcherHandler` via a cloned
`SqlitePool` handed to it at startup alongside the existing `TcpListener`.

**Why not a cache in front of SQLite:** a second in-memory copy would need its
own session-scoping and eviction bookkeeping kept in sync with the database, to
solve a latency problem that doesn't exist — email is already "far rarer than
log lines" (existing comment, `EmailTab.tsx:14`), and `request_history` already
writes full response bodies straight from an async command with no cache in
front of it.

**Why not a write-behind channel:** `collect_correlation_window`'s `None` (not
observed) vs `Some(vec![])` (observed nothing) distinction must never be wrong.
A message captured-but-not-yet-flushed at the instant the window is queried
would silently vanish from a request's rollup — a real correctness bug, not a
theoretical one, given this app's stated principle that a failure to observe
must never be rendered as "nothing happened." A direct, synchronous write
removes the race entirely, at the cost of one blocking SQLite insert per
captured email.

**The bridge from the catcher's blocking thread to the async pool already has a
precedent in this codebase**: `main.rs`'s `.setup()` closure is synchronous and
calls `tauri::async_runtime::block_on(LocalDb::connect(...))` to run async
setup from a sync context. `CatcherHandler::data_end` does the same thing on
its own dedicated OS thread — one `block_on` call that reads the active
session, inserts the row, evicts overflow if needed, and returns
`response::OK` (or `INTERNAL_ERROR` on failure, same as today) to the SMTP
client.

## Data model

```sql
-- 0004_captured_emails.sql
CREATE TABLE captured_emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  request_id   TEXT REFERENCES request_history(id) ON DELETE SET NULL,
  captured_at  INTEGER NOT NULL,   -- ms epoch, DevBench's own clock (unchanged semantics)
  from_addr    TEXT NOT NULL,
  to_addrs     TEXT NOT NULL,      -- JSON array of strings
  subject      TEXT NOT NULL,
  html_body    TEXT,
  text_body    TEXT,
  raw          TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL
);

CREATE INDEX idx_captured_emails_session ON captured_emails (session_id, captured_at DESC);
CREATE INDEX idx_captured_emails_request ON captured_emails (request_id);

-- Singleton row tracking the global eviction high-water mark — same concept
-- as today's in-memory EmailStore.evicted_through_id, made durable.
CREATE TABLE captured_emails_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  evicted_through_id  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO captured_emails_state (id, evicted_through_id) VALUES (1, 0);
```

**Deliberate deviation from `request_history`'s `TEXT`/UUID id:** `id` stays an
`INTEGER AUTOINCREMENT`, not a UUID. Correlation's window selection
(`between(after_id, ...)` today) depends on numeric ordering — "ids strictly
greater than the snapshot taken before firing" — and a UUID has no ordering.
`AUTOINCREMENT`, not bare `INTEGER PRIMARY KEY`, is required specifically
because SQLite may otherwise reuse a deleted row's rowid, which would violate
the existing, deliberately-tested invariant that ids are never reused after
eviction or `clear` (`email_state.rs` test:
`clear_empties_the_inbox_without_rewinding_ids`).

**Retention is one global cap, not per-session.** The simplest, least-surprising
reading of "bounded rolling cap" plus "session-scoped" treats them as
orthogonal: one global cap of **5,000** messages (25× today's 200) bounds total
storage, while `session_id` only filters what a given session's inbox
*displays*. A per-session cap would need per-session eviction bookkeeping (and
a per-session `evicted_through_id`) for no real benefit at this traffic
profile. Eviction deletes the oldest rows table-wide, in the same transaction
as the insert, and bumps `captured_emails_state.evicted_through_id` to the
highest id evicted — identical logic to today's `EmailStore::push`, expressed
as SQL instead of a `VecDeque`.

**Session tagging at capture time.** Unlike `fire_request`, the SMTP catcher has
no frontend call to receive a `session_id` argument from — mail can arrive with
no `invoke()` in flight at all. Instead, the same `block_on` in `data_end` reads
`SELECT value FROM settings WHERE key = 'active_session_id'` — the identical
single source of truth `get_settings_impl` already reads (`settings.rs:55`) —
immediately before inserting. No in-memory mirror to keep in sync; one cheap
extra read per captured email, correct by construction since it reads the same
row every other consumer of `active_session_id` reads.

## Capture path

`smtp_catcher::serve()` and `CatcherHandler` take a `SqlitePool` clone instead
of `Arc<Mutex<EmailStore>>`. `data_end` becomes, in outline:

```rust
fn data_end(&mut self) -> Response {
    // ... existing overflow / size-cap handling is unchanged ...
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let captured_at_ms = chrono::Utc::now().timestamp_millis();
    let pool = self.pool.clone();
    let (from, to) = (self.from.clone(), self.to.clone());

    match tauri::async_runtime::block_on(insert_captured_email(&pool, &from, &to, &raw, captured_at_ms)) {
        Ok(()) => response::OK,
        Err(_) => response::INTERNAL_ERROR, // same fallback as today's poisoned-mutex case
    }
}
```

`insert_captured_email` runs `parse_captured` (unchanged — pure function,
untouched by this spec), reads `active_session_id`, inserts the row, and — in
the same transaction — evicts rows beyond the 5,000 cap, updating
`captured_emails_state.evicted_through_id` to the highest id it deleted.
`MAX_MESSAGE_BYTES` (10 MiB) and the per-chunk overflow check in `data()` are
unchanged.

`main.rs` passes `db.pool.clone()` to `smtp_catcher::bind`/`serve` alongside the
listener, instead of `emails.store()`.

## Correlation linkage

Today, `run_correlated_request` snapshots `from_email_id` before firing and
calls `save_correlation_history` right after the response returns —
*before* the later, separate `collect_correlation_window` call even runs. The
request's own history id isn't available yet at the point we'd want to stamp it
onto whichever emails show up during the window. The fix threads that id
forward; it changes no timing or observation logic.

1. `save_history_entry_impl` returns `Result<String, String>` (the UUID it
   already generates, currently discarded) instead of `Result<(), String>`.
2. `CorrelationResult` gains `history_id: Option<String>` — `None` only when
   the history save itself failed, which is already non-fatal today
   (`save_correlation_history`'s doc comment: "not swallowed silently either").
3. The frontend holds `history_id` from `invokeRunCorrelatedRequest`'s result
   and passes it into the later `invokeCollectCorrelationWindow(correlationId,
   historyId)` call.
4. `collect_correlation_window_impl` gains a `history_id: Option<&str>`
   parameter. After computing `captured` (the existing
   `Some(vec![...])`/`None` logic, completely unchanged), if both `history_id`
   and `captured` are `Some`, it runs one
   `UPDATE captured_emails SET request_id = ? WHERE id IN (...)` over the
   captured ids.

No change to window timing, to the `None`-vs-`Some(vec![])` semantics, or to
the `evicted_through_id` truncation check — this persists a value that's
already being computed.

**Scope note:** this only covers `run_correlated_request`, the one path with a
correlation window. Plain `fire_request` has no window and gets no link — there
is nothing to attach it to.

## Query path & commands

- **`list_emails(session_id: Option<String>, limit)`** mirrors
  `list_history_impl`'s two-query pattern (`history.rs:60-71`) — a distinct
  equality query and a distinct `session_id IS NULL` query, not one
  `(?1 IS NULL OR session_id = ?1)` predicate, for the same index-usage reason
  history already settled. Returns
  `ListEmailsResult { emails: Vec<EmailSummary>, evicted_through_id: i64 }`
  instead of a bare list, so `EmailInbox` can render **"Showing latest 5,000 —
  N earlier evicted"** — the mockup's inbox footer — closing the real gap of
  eviction being tracked but invisible.
- **`get_email(id)`** — `CapturedEmail` gains `request_id: Option<String>`,
  `request_method: Option<String>`, `request_url: Option<String>`, populated
  via one `LEFT JOIN request_history` in `get_email_impl`. A join, not a second
  frontend round-trip, because `EmailViewer` needs the method+url to render
  "Sent by ..." and nothing else in this codebase does N+1 lookups to render a
  single detail view.
- **`clear_emails(session_id: Option<String>)`** becomes scoped:
  `DELETE FROM captured_emails WHERE session_id = ?` (or `IS NULL` when
  unscoped) — "Clear inbox" clears what the user is currently looking at, not
  every session's mail. A global "clear everything ever captured" is out of
  scope (see Scope table).

## Frontend

- **`EmailInbox`** gains the filter input from the mockup: one `<input>` above
  the list, client-side filtering the already-polled `EmailSummary[]` by
  subject/from/to substring — no new command, since `list_emails` already
  returns up to 5,000 summaries per second-interval poll. The inbox footer
  changes from nothing to the eviction line above.
- **`EmailViewer`** gains the "Sent by `METHOD URL` → view in History" chip
  from the mockup, shown only when `get_email`'s `request_id` is set. Clicking
  it mirrors the *existing* rollup deep-link pattern at `ApiTab.tsx:165-166`
  (`setActiveTab("email"); onOpenEmail(emailId);`) in the opposite direction:
  it calls `setActiveTab("api")` plus a new `onOpenHistory(requestId)`,
  threaded through `App.tsx` the same way `emailFocusId`/`onOpenEmail` are
  today (`App.tsx:35,98`) as a new `historyFocusId`/`onOpenHistory` pair.
  `HistorySidebar` gains a `focusId` prop (it has none today) so the matching
  row is highlighted and its response shown, the same outcome a manual click
  produces.
- **Revisits the v2 shell spec's email-tab-state decision**, as the task
  setting this spec up flagged explicitly: `email` tab `state` was left `{}`
  there because ids were memory-only and reset every restart
  ("Email selection is deliberately NOT persisted... because ids come from a
  200-message in-memory ring buffer that resets on restart," v2 shell design,
  Tab persistence). With ids now durable, `email` tab state becomes
  `{ emailId }`, matching `db`'s `{ table }` and `log`'s `{ sourceId }`.
  Eviction is now rare (5,000 messages, not 200, and never wiped by a restart)
  but not impossible, so `EmailTab` must treat a `get_email` "not found" — an
  existing error path, `commands/email.rs`'s
  `"...it may have been evicted or cleared"` — by clearing the persisted
  selection back to the empty state, not surfacing it as a hard error. This is
  the one place this spec's storage-model change reaches into the v2 shell
  work; nothing else there is affected.

## Testing

- **Migration**: `0004_captured_emails.sql` applies cleanly via
  `sqlx::migrate!`; ids are never reused after a row is evicted or the inbox is
  cleared (mirrors the existing in-memory test of the same property).
- **Capture path**: a message sent over SMTP lands in `captured_emails` tagged
  with whatever `active_session_id` was set in `settings` at the moment of
  capture; a message sent with no active session lands with `session_id IS
  NULL`; the 10 MiB overflow rejection is unchanged and still uncommitted to
  the table.
- **Retention**: inserting past the 5,000 cap evicts the oldest rows and
  advances `captured_emails_state.evicted_through_id` to the newest evicted id,
  never a lower one.
- **Session scoping**: `list_emails` with a `session_id` returns only that
  session's rows, `IS NULL` returns only unattributed rows, matching
  `history.rs`'s existing scoped-query tests structurally.
- **Correlation linkage**: firing a correlated request and letting the window
  close attaches `request_id` to exactly the emails `collect_correlation_window`
  reports as captured — never to emails outside the window — and a request
  whose history save failed leaves captured emails' `request_id` untouched
  (`history_id: None`, no `UPDATE` issued). The existing `None`-vs-`Some(vec![])`
  tests in `correlation.rs` (a catcher that isn't listening, pre-existing mail
  not attributed, evicted mail flagged truncated) are unchanged and must still
  pass.
- **Frontend**: `EmailInbox`'s filter narrows the visible rows without
  refetching or losing the current viewer selection; `EmailViewer` shows the
  "Sent by" chip only when `request_id` is present; a stale/evicted
  `emailId` in persisted tab state clears the selection instead of erroring.

## Out of scope

Attachment extraction and download, SMTP port live-rebind, backend full-text
search and pagination past the 5,000 cap, a global "clear every session"
action, and per-session retention caps. Each is a self-contained follow-on; see
the Scope table for the reasoning behind leaving them out now.
