# DevBench v1 — Log Tab & Log Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Log tab (sources sidebar, live tail, search/filter) and extend the "what happened" rollup from one observed source (DB) to two (DB + Log), so that firing a request shows both the rows it changed and the log lines it produced — without making the API tab's response wait 5 seconds for the correlation window to close.

**Architecture:** A background tailer per log source polls its file on a fixed interval, reading only the bytes appended since the last poll (bounded, incremental, capped per chunk — the same shape as `fire_request`'s response reader), parses each line (JSON-lines into fields, plain text kept raw), and appends it to one shared bounded ring buffer with a monotonically increasing id. Correlation becomes **two phase**: `run_correlated_request` returns as fast as it does today (response + DB diffs) plus a `correlation_id`; a second command `collect_correlation_window` waits out the remaining 5-second window and returns the log lines captured inside it. Both phases are ordinary `invoke()` calls — no Tauri events, no capabilities file.

**Tech Stack:** Unchanged from Plan 1 (Bun + Turborepo, Vite + React + TypeScript, Zustand, Tailwind CSS v4, Tauri 2 + Rust, sqlx, Vitest + RTL, Rust's built-in test framework), plus one new frontend dependency: `@tanstack/react-virtual` for the log stream. No new Rust crates.

## Global Constraints

- **Local Postgres required before running any backend test in this plan:** `docker compose up -d` at the repo root. If tests fail with a connection timeout, run `docker compose down && docker compose up -d --force-recreate` — a stale container without published ports has been hit before. Several tests in this plan touch `run_correlated_request_impl`, which connects to Postgres even when `watched_tables` is empty.
- MIT license on all code in `apps/devbench`. `@tanstack/react-virtual` is MIT — compatible.
- Local-first: the app reads only files the user explicitly points it at. No DevBench-operated server exists or is contacted anywhere in this plan.
- All filesystem and DB access happens in Rust, invoked from the frontend exclusively via `@tauri-apps/api`'s `invoke()`. The frontend never opens a file.
- Every Tauri command follows the established split: `#[tauri::command] async fn foo(...)` is a thin wrapper delegating to a plain `async fn foo_impl(...)` that holds the real logic and is what the unit tests call. `_impl` functions take plain references (`&LogState`, `&SqlitePool`), never `tauri::State`, so they are constructible in a test without a running Tauri app.
- Reads from log files are **bounded and incremental**: a per-poll byte budget is checked *inside* the read loop, and the loop stops when the budget is exhausted. Never `read_to_string` / `read_to_end` on a log file, and never "read everything then check the size afterwards."
- Visual system follows `DESIGN.md`: monochrome (no accent hue beyond inversion), dark-primary with independent light support, ghosty persistent chrome (no blur — nothing built here is a transient overlay), `--radius-sm` for controls and `--radius-lg` for surfaces, `tabular-nums` wherever digits line up.
- Package manager is Bun exclusively — no `npm install` / `yarn` anywhere in this plan.
- A failure to observe is never rendered as "nothing happened" (PRODUCT.md principle 4). Every "count" field in this plan is nullable, and `null` ("we could not observe this") renders differently from `0`/`[]` ("we observed, and nothing happened").

---

## Decisions Made In This Plan (read these before Task 1)

These four calls shape every task below. They are recorded here, in the plan, rather than buried in a code comment.

### Decision 1: Correlation becomes two request/response commands, not one blocking call and not Tauri events

The correlation window is 5 seconds *after the response*. Three options were considered:

| Option | Perceived performance | New machinery |
|---|---|---|
| **(a)** One command that blocks for the full window and returns everything | Bad — a 140 ms request appears to take 5.1 s. The API tab stops being usable as a standalone API client, violating PRODUCT.md principle 3 | None |
| **(b)** Return DB diffs immediately, stream log lines in via `app.emit` + frontend `listen` | Good | Event streaming — a pattern used nowhere in this codebase, **plus** a `src-tauri/capabilities/default.json` granting `core:event:default`, since `listen` is a core-plugin command and this repo has no capabilities file at all |
| **(c) — CHOSEN** Two ordinary commands: `run_correlated_request` returns immediately with a `correlation_id`; `collect_correlation_window(correlation_id)` waits out the remaining window and returns the log lines | Same as (b) — the response and DB diffs paint at ~150 ms, the Log chip fills in when the window closes | None. Two `invoke()` calls, two `_impl` functions, both unit-testable exactly like every other command in the codebase |

(c) is chosen. It gets (b)'s perceived performance without introducing an event-subscription lifecycle, a capabilities file, or a second way for the backend to talk to the frontend.

**Why no lines are lost between the two calls:** the tailers run continuously and append into the shared buffer regardless of whether any correlation is in flight. `run_correlated_request` records the buffer's `next_id` *before* firing the request; `collect_correlation_window` later selects everything with a greater id that was captured before the window closed. Nothing depends on the frontend calling the second command promptly.

**Why capture time, not log timestamp, bounds the window:** a log line's own timestamp comes from the target backend's clock and its own formatting, which may be skewed, missing, or in an unparsed format. DevBench stamps `captured_at_ms` from its own clock when it reads the bytes, and the window is `(request start, response + 5s]` in *that* clock. The log's parsed timestamp is kept for display only. This makes correlation independent of the target application's clock discipline — which is the whole point of "zero-instrumentation."

### Decision 2: The tailer polls; `notify` is deliberately not used

`notify` (8.2.0 stable / 9.0.0-rc) reports "this file changed" — it does not read the appended bytes, detect truncation, or handle rotation. Every hard part remains, and on macOS the default FSEvents backend has ~1 s latency anyway. A `tokio::time::interval` at 250 ms doing `metadata().len()` + `seek` + bounded read is fewer moving parts, adds zero dependencies, and is deterministic in tests (a test can write bytes and then call the poll function directly instead of waiting on an OS event). The correlation window is 5 s; a 250 ms poll is four times finer than it needs to be.

This is a recorded decision, not an oversight: if sub-100 ms tail latency ever becomes a product requirement, `notify` becomes worth its cost. It is not one today.

### Decision 3: TanStack Virtual is introduced here, for the log stream only

`PRODUCT.md` names TanStack Table + TanStack Virtual as the stack; Plan 1 used neither, because the DB grid is capped at 200 rows by `list_table_rows_impl` and a plain `<table>` renders that fine. The log stream is the case the choice was actually made for: it is append-driven, capped at 5,000 buffered lines, and re-renders on a 500 ms poll. Rendering 5,000 DOM rows on every tick janks; slicing to "last N" silently destroys scrollback.

So: **`@tanstack/react-virtual` is added in Task 8 and used only by `LogStream`.** `DataGrid` stays a plain `<table>` and TanStack **Table** stays uninstalled — neither the DB grid's 200-row cap nor its fixed column set justifies it yet. Base UI also stays uninstalled through this plan; it is introduced in Plan 4, where three tab bars and a segmented control appear at once.

### Decision 4: The correlation window is a hardcoded 5,000 ms constant, in exactly one place

`DEFAULT_CORRELATION_WINDOW_MS` lives in `src-tauri/src/correlation_state.rs` and nowhere else. Settings > General (Plan 4) will replace the constant with a stored value; until then this is a scoping decision, the same way `DEV_CONNECTION` was hardcoded in Plan 1 pending a connection-picker UI. It is flagged here so it is not mistaken later for a forgotten placeholder.

### Scope note: regular files only, not FIFOs

The v1 spec says "tail a file or stdout pipe." A named pipe reports `len() == 0` forever, so the length-delta poll in Task 2 cannot drive it, and supporting it means a second, blocking read path. **Plan 2 supports regular files only.** The Log tab's empty state tells the user the one-line workaround (`yourapp 2>&1 | tee /tmp/devbench.log`), which is the same shape of "add one line to your setup" integration that the SMTP catcher asks for. Named-pipe support is deferred, not forgotten.

### Scope note: this plan also closes a Plan 1 honesty gap

`run_correlated_request_impl` currently returns `Err(...)` if any watched-table snapshot fails, which discards the HTTP response the user actually cares about and shows a bare error string instead of the rollup. The v1 spec's Error handling section requires "DB: unable to verify," never a false "0 writes," and the mockup has a designed `partial` rollup state for exactly this. Because Task 9 restructures the rollup's props anyway, closing this gap here costs one extra task (Task 5) instead of a second full pass over the same files later.

---

## File Structure

```
apps/devbench/
  package.json                                    # + @tanstack/react-virtual
  src/
    App.tsx                                       # MODIFIED: TabId union grows, tab nav becomes a mapped list
    store/useAppStore.ts                          # MODIFIED: TabId gains "log"; log-source state added
    lib/tauri.ts                                  # MODIFIED: log + two-phase correlation wrappers and types
    components/
      log/
        LogTab.tsx                                # NEW: sources sidebar + toolbar + stream, owns polling
        LogSourcesSidebar.tsx                     # NEW
        LogSourcesSidebar.test.tsx                # NEW
        LogStream.tsx                             # NEW: virtualized line list
        LogStream.test.tsx                        # NEW
        AddLogSourceForm.tsx                      # NEW
        AddLogSourceForm.test.tsx                 # NEW
      rollup/
        Rollup.tsx                                # MODIFIED: chip row (DB / Log), partial-failure state
        Rollup.test.tsx                           # MODIFIED
      api/
        ApiTab.tsx                                # MODIFIED: two-phase correlation call
  src-tauri/
    src/
      lib.rs                                      # MODIFIED: + pub mod log_state; + pub mod correlation_state;
      main.rs                                     # MODIFIED: manage LogState + CorrelationRegistry, register commands
      log_state.rs                                # NEW: LogLine, parsing, LogBuffer, LogTailer, LogState
      correlation_state.rs                        # NEW: CorrelationRegistry + DEFAULT_CORRELATION_WINDOW_MS
      commands/
        mod.rs                                    # MODIFIED: + pub mod logs;
        logs.rs                                   # NEW: start/stop/list sources, read_log_lines
        correlation.rs                            # MODIFIED: two-phase, nullable table_diffs, log window collection
```

**Responsibilities:**
- `log_state.rs` owns everything about *observing* logs: what a parsed line is, the bounded ring buffer, and the polling tailer task. It has no knowledge of correlation.
- `correlation_state.rs` owns the in-flight-window registry and the window constant. It has no knowledge of files.
- `commands/logs.rs` is thin: Tauri wrappers over `log_state.rs` operations, plus the small amount of source-lifecycle bookkeeping that belongs at the command layer.
- `commands/correlation.rs` keeps its existing job (orchestrating request + DB diff) and gains the job of stamping/collecting the window. It is still the highest-bug-cost file in the app.

---

### Task 1: Log line model and line parsing

**Files:**
- Create: `apps/devbench/src-tauri/src/log_state.rs`
- Modify: `apps/devbench/src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` module in `log_state.rs`

**Interfaces:**
- Produces: `pub struct LogLine { id: u64, source_id: String, captured_at_ms: i64, timestamp: Option<String>, level: Option<String>, message: String, raw: String }` and `pub fn parse_log_line(raw: &str) -> ParsedLine` where `ParsedLine { timestamp: Option<String>, level: Option<String>, message: String }`. Task 2 (the buffer) and Task 3 (the commands) both use `LogLine` with these exact field names; Task 8's `LogStream` renders `level`, `timestamp`, and `message` and nothing else.

This task is pure functions only — no I/O, no async. Parsing is where "JSON-lines parsed into fields, plain text shown raw" from the v1 spec actually gets decided, and getting the numeric-level case wrong silently mislabels every line from a `pino`-based backend, which is a very common Node stack.

- [ ] **Step 1: Write the failing tests**

`apps/devbench/src-tauri/src/log_state.rs`:
```rust
use serde::{Deserialize, Serialize};

/// One observed log line. `captured_at_ms` is DevBench's own clock at the
/// moment the bytes were read — correlation windows are bounded by this, NOT
/// by `timestamp`, which comes from the target backend and may be skewed,
/// missing, or in a format we do not parse.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogLine {
    pub id: u64,
    pub source_id: String,
    pub captured_at_ms: i64,
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub message: String,
    pub raw: String,
}

/// The parsed-out fields of a single raw line, before it is given an id and a
/// capture timestamp.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub message: String,
}

/// Maps a numeric log level to a name. These are the `pino` / Bunyan numeric
/// levels, which are what a large share of Node backends emit; without this,
/// every line from such a backend would render with a level of "30".
fn numeric_level_name(n: i64) -> Option<&'static str> {
    match n {
        0..=14 => Some("TRACE"),
        15..=24 => Some("DEBUG"),
        25..=34 => Some("INFO"),
        35..=44 => Some("WARN"),
        45..=54 => Some("ERROR"),
        _ => Some("FATAL"),
    }
}

fn level_from_value(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.to_uppercase()),
        serde_json::Value::Number(n) => n.as_i64().and_then(numeric_level_name).map(str::to_string),
        _ => None,
    }
}

fn first_string<'a>(obj: &'a serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<&'a serde_json::Value> {
    keys.iter().find_map(|k| obj.get(*k))
}

/// Parses one raw line. A JSON object line has its well-known fields lifted
/// out; anything else (plain text, a JSON array, malformed JSON) is kept
/// verbatim as the message with no level and no timestamp.
pub fn parse_log_line(raw: &str) -> ParsedLine {
    let fallback = ParsedLine {
        timestamp: None,
        level: None,
        message: raw.to_string(),
    };

    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return fallback,
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return fallback,
    };

    let message = first_string(obj, &["msg", "message", "text"])
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.clone()),
            other => Some(other.to_string()),
        })
        .unwrap_or_else(|| raw.to_string());

    let level = first_string(obj, &["level", "severity", "lvl"]).and_then(level_from_value);

    let timestamp = first_string(obj, &["time", "timestamp", "ts", "@timestamp"]).map(|v| match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    });

    ParsedLine { timestamp, level, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_pino_style_json_line_with_a_numeric_level() {
        let parsed = parse_log_line(
            r#"{"level":30,"time":"2026-07-30T14:02:11.482Z","msg":"order created id=8841"}"#,
        );
        assert_eq!(parsed.level.as_deref(), Some("INFO"));
        assert_eq!(parsed.timestamp.as_deref(), Some("2026-07-30T14:02:11.482Z"));
        assert_eq!(parsed.message, "order created id=8841");
    }

    #[test]
    fn parses_a_string_level_and_uppercases_it() {
        let parsed = parse_log_line(r#"{"level":"warn","message":"inventory low"}"#);
        assert_eq!(parsed.level.as_deref(), Some("WARN"));
        assert_eq!(parsed.message, "inventory low");
        assert_eq!(parsed.timestamp, None);
    }

    #[test]
    fn keeps_plain_text_verbatim_with_no_level() {
        let parsed = parse_log_line("2026-07-30 14:02:11 starting server on :3000");
        assert_eq!(parsed.level, None);
        assert_eq!(parsed.timestamp, None);
        assert_eq!(parsed.message, "2026-07-30 14:02:11 starting server on :3000");
    }

    #[test]
    fn treats_malformed_json_as_plain_text_rather_than_dropping_it() {
        let raw = r#"{"level":"info","msg":"truncated mid-writ"#;
        let parsed = parse_log_line(raw);
        assert_eq!(parsed.level, None);
        assert_eq!(parsed.message, raw);
    }

    #[test]
    fn falls_back_to_the_whole_line_when_a_json_object_has_no_known_message_field() {
        let raw = r#"{"unexpected":"shape"}"#;
        let parsed = parse_log_line(raw);
        assert_eq!(parsed.message, raw);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test parses_a_pino_style`
Expected: FAIL to compile — `log_state` is not declared in `lib.rs`, so the module is never built.

- [ ] **Step 3: Declare the module**

Modify `apps/devbench/src-tauri/src/lib.rs`:
```rust
pub mod commands;
pub mod local_db;
pub mod log_state;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test log_state::`
Expected: PASS (all five)

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src/log_state.rs apps/devbench/src-tauri/src/lib.rs
git commit -m "feat(devbench): parse JSON-lines and plain-text log lines"
```

---

### Task 2: Bounded ring buffer and the incremental file tailer

**Files:**
- Modify: `apps/devbench/src-tauri/src/log_state.rs`
- Test: inline `#[cfg(test)]` module in `log_state.rs`

**Interfaces:**
- Consumes: `LogLine` / `parse_log_line` from Task 1.
- Produces:
  - `pub struct LogBuffer` with `pub fn new(capacity: usize) -> Self`, `pub fn next_id(&self) -> u64`, `pub fn push(&mut self, source_id: &str, raw: &str, captured_at_ms: i64) -> u64`, `pub fn since(&self, after_id: u64, source_id: Option<&str>, limit: usize) -> Vec<LogLine>`, `pub fn between(&self, after_id: u64, captured_before_or_at_ms: i64) -> Vec<LogLine>`, and `pub fn evicted_through_id(&self) -> u64`.
  - `pub struct SourceTailer` with `pub fn new(source_id: String, path: PathBuf) -> Self` and `pub fn poll_once(&mut self, buffer: &mut LogBuffer, now_ms: i64) -> Result<(), String>`.
  - `pub const MAX_BUFFERED_LINES: usize = 5_000;`, `pub const MAX_BYTES_PER_POLL: u64 = 1024 * 1024;`, `pub const MAX_LINE_BYTES: usize = 64 * 1024;`
  Task 3's commands and Task 6's correlation both call `since` / `between` / `next_id` / `evicted_through_id` under these exact names.

`poll_once` is deliberately a synchronous, non-async function taking `now_ms` as a parameter. That makes every rotation, truncation, oversized-line, and byte-budget case testable by calling it directly with a temp file — no sleeping, no async runtime, no timing races.

- [ ] **Step 1: Write the failing tests**

Append to the `#[cfg(test)] mod tests` block in `apps/devbench/src-tauri/src/log_state.rs`:
```rust
    use std::io::Write as _;

    fn write_and_flush(path: &std::path::Path, contents: &str) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f.flush().unwrap();
    }

    #[test]
    fn tailer_reads_only_bytes_appended_since_the_previous_poll() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "first line\n").unwrap();

        let mut buffer = LogBuffer::new(MAX_BUFFERED_LINES);
        let mut tailer = SourceTailer::new("src1".to_string(), path.clone());

        // A brand-new tailer starts at the END of the file: a developer who
        // points DevBench at a 2 GB log does not want 2 GB of history.
        tailer.poll_once(&mut buffer, 1_000).unwrap();
        assert_eq!(buffer.since(0, None, 100).len(), 0);

        write_and_flush(&path, "second line\n");
        tailer.poll_once(&mut buffer, 2_000).unwrap();
        let lines = buffer.since(0, None, 100);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].message, "second line");
        assert_eq!(lines[0].captured_at_ms, 2_000);

        // No new bytes -> no new lines, and no re-reading of what we already read.
        tailer.poll_once(&mut buffer, 3_000).unwrap();
        assert_eq!(buffer.since(0, None, 100).len(), 1);
    }

    #[test]
    fn tailer_detects_truncation_and_emits_a_visible_warning_rather_than_silently_resyncing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "aaaa\nbbbb\n").unwrap();

        let mut buffer = LogBuffer::new(MAX_BUFFERED_LINES);
        let mut tailer = SourceTailer::new("src1".to_string(), path.clone());
        tailer.poll_once(&mut buffer, 1_000).unwrap();

        // logrotate-style: file replaced with a shorter one.
        std::fs::write(&path, "cccc\n").unwrap();
        tailer.poll_once(&mut buffer, 2_000).unwrap();

        let lines = buffer.since(0, None, 100);
        assert_eq!(lines.len(), 2, "expected a warning line plus the new content");
        assert_eq!(lines[0].level.as_deref(), Some("WARN"));
        assert!(lines[0].message.contains("rotated or truncated"));
        assert_eq!(lines[1].message, "cccc");
    }

    #[test]
    fn tailer_caps_a_single_poll_and_resumes_where_it_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let mut buffer = LogBuffer::new(MAX_BUFFERED_LINES);
        let mut tailer = SourceTailer::new("src1".to_string(), path.clone());
        tailer.poll_once(&mut buffer, 1_000).unwrap();

        // Write comfortably more than one poll's byte budget.
        let line = "x".repeat(1023);
        let mut blob = String::new();
        for _ in 0..2_000 {
            blob.push_str(&line);
            blob.push('\n');
        }
        write_and_flush(&path, &blob);

        tailer.poll_once(&mut buffer, 2_000).unwrap();
        let after_first = buffer.since(0, None, 10_000).len();
        assert!(after_first > 0, "first poll should have read something");
        assert!(after_first < 2_000, "first poll must stop at the per-poll byte budget");

        tailer.poll_once(&mut buffer, 3_000).unwrap();
        assert!(buffer.since(0, None, 10_000).len() > after_first, "next poll resumes from the saved offset");
    }

    #[test]
    fn tailer_truncates_a_pathologically_long_line_instead_of_buffering_it_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let mut buffer = LogBuffer::new(MAX_BUFFERED_LINES);
        let mut tailer = SourceTailer::new("src1".to_string(), path.clone());
        tailer.poll_once(&mut buffer, 1_000).unwrap();

        write_and_flush(&path, &format!("{}\n", "y".repeat(MAX_LINE_BYTES * 2)));
        tailer.poll_once(&mut buffer, 2_000).unwrap();

        let lines = buffer.since(0, None, 100);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].raw.len() <= MAX_LINE_BYTES + 32);
        assert!(lines[0].message.ends_with("… (line truncated)"));
    }

    #[test]
    fn tailer_reports_an_unreadable_source_as_an_error_not_as_silence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.log");
        let mut buffer = LogBuffer::new(MAX_BUFFERED_LINES);
        let mut tailer = SourceTailer::new("src1".to_string(), path);
        let result = tailer.poll_once(&mut buffer, 1_000);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does-not-exist.log"));
    }

    #[test]
    fn buffer_evicts_oldest_lines_and_records_how_far_it_evicted() {
        let mut buffer = LogBuffer::new(3);
        for i in 0..5 {
            buffer.push("src1", &format!("line {i}"), 1_000 + i as i64);
        }
        let lines = buffer.since(0, None, 100);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].message, "line 2");
        // ids 1 and 2 are gone; a caller holding from_id = 0 must be able to tell.
        assert_eq!(buffer.evicted_through_id(), 2);
    }

    #[test]
    fn buffer_between_selects_by_id_lower_bound_and_capture_time_upper_bound() {
        let mut buffer = LogBuffer::new(MAX_BUFFERED_LINES);
        buffer.push("src1", "before", 1_000);
        let from_id = buffer.next_id() - 1;
        buffer.push("src1", "inside", 1_500);
        buffer.push("src1", "after the window", 9_999);

        let selected = buffer.between(from_id, 2_000);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].message, "inside");
    }

    #[test]
    fn buffer_since_can_filter_to_a_single_source() {
        let mut buffer = LogBuffer::new(MAX_BUFFERED_LINES);
        buffer.push("server", "a", 1_000);
        buffer.push("worker", "b", 1_001);
        buffer.push("server", "c", 1_002);

        let only_server = buffer.since(0, Some("server"), 100);
        assert_eq!(only_server.len(), 2);
        assert!(only_server.iter().all(|l| l.source_id == "server"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test log_state::tests::tailer_reads_only_bytes`
Expected: FAIL to compile — `LogBuffer`, `SourceTailer`, and the constants do not exist yet.

- [ ] **Step 3: Implement the buffer and tailer**

Insert into `apps/devbench/src-tauri/src/log_state.rs`, above the `#[cfg(test)]` block:
```rust
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// How many parsed lines are kept in memory across all sources. Old lines are
/// evicted; `evicted_through_id` lets a caller detect that it lost some.
pub const MAX_BUFFERED_LINES: usize = 5_000;

/// Ceiling on bytes read from one source in one poll. Checked INSIDE the read
/// loop so a source that grows by a gigabyte between polls neither stalls the
/// tailer nor allocates a gigabyte — it just takes several polls to catch up.
/// Same shape as `fire_request`'s streamed, per-chunk-checked body read.
pub const MAX_BYTES_PER_POLL: u64 = 1024 * 1024;

/// Ceiling on the length of a single retained line. A backend that dumps a
/// 40 MB stack trace on one line must not be able to blow up the buffer.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Size of one read from the file inside a poll. Read -> scan -> emit lines ->
/// read again, rather than reading the whole appended region at once.
const READ_CHUNK_BYTES: usize = 32 * 1024;

pub struct LogBuffer {
    lines: VecDeque<LogLine>,
    capacity: usize,
    next_id: u64,
    evicted_through_id: u64,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            lines: VecDeque::with_capacity(capacity.min(1024)),
            capacity,
            next_id: 1,
            evicted_through_id: 0,
        }
    }

    /// The id the NEXT pushed line will receive. Correlation snapshots this
    /// before firing a request, then selects ids strictly greater than it.
    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    /// The highest id that has been dropped from the buffer. A caller whose
    /// `from_id` is at or below this knows its view is incomplete.
    pub fn evicted_through_id(&self) -> u64 {
        self.evicted_through_id
    }

    pub fn push(&mut self, source_id: &str, raw: &str, captured_at_ms: i64) -> u64 {
        let (raw, truncated) = if raw.len() > MAX_LINE_BYTES {
            // Cut on a char boundary so the String stays valid UTF-8.
            let mut end = MAX_LINE_BYTES;
            while end > 0 && !raw.is_char_boundary(end) {
                end -= 1;
            }
            (&raw[..end], true)
        } else {
            (raw, false)
        };

        let mut parsed = parse_log_line(raw);
        if truncated {
            parsed.message.push_str("… (line truncated)");
        }

        let id = self.next_id;
        self.next_id += 1;
        self.lines.push_back(LogLine {
            id,
            source_id: source_id.to_string(),
            captured_at_ms,
            timestamp: parsed.timestamp,
            level: parsed.level,
            message: parsed.message,
            raw: raw.to_string(),
        });
        while self.lines.len() > self.capacity {
            if let Some(dropped) = self.lines.pop_front() {
                self.evicted_through_id = dropped.id;
            }
        }
        id
    }

    pub fn since(&self, after_id: u64, source_id: Option<&str>, limit: usize) -> Vec<LogLine> {
        self.lines
            .iter()
            .filter(|l| l.id > after_id)
            .filter(|l| source_id.is_none_or(|s| l.source_id == s))
            .take(limit)
            .cloned()
            .collect()
    }

    /// Lines captured strictly after `after_id` and no later than
    /// `captured_before_or_at_ms`. This is the correlation-window selector.
    pub fn between(&self, after_id: u64, captured_before_or_at_ms: i64) -> Vec<LogLine> {
        self.lines
            .iter()
            .filter(|l| l.id > after_id && l.captured_at_ms <= captured_before_or_at_ms)
            .cloned()
            .collect()
    }
}

/// Tails one regular file. Holds the byte offset it has consumed and the
/// partial trailing line it has not yet seen a newline for.
pub struct SourceTailer {
    source_id: String,
    path: PathBuf,
    offset: u64,
    pending: String,
    started: bool,
}

impl SourceTailer {
    pub fn new(source_id: String, path: PathBuf) -> Self {
        Self { source_id, path, offset: 0, pending: String::new(), started: false }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Reads whatever has been appended since the last call, bounded by
    /// `MAX_BYTES_PER_POLL`, and pushes complete lines into `buffer`.
    ///
    /// On the very first call the tailer seeks to EOF instead of reading the
    /// file's history — pointing DevBench at an existing multi-gigabyte log
    /// must not replay it.
    pub fn poll_once(&mut self, buffer: &mut LogBuffer, now_ms: i64) -> Result<(), String> {
        let metadata = std::fs::metadata(&self.path)
            .map_err(|e| format!("cannot read log source {}: {e}", self.path.display()))?;
        let len = metadata.len();

        if !self.started {
            self.started = true;
            self.offset = len;
            return Ok(());
        }

        if len < self.offset {
            // Rotated or truncated. Never silently resync: the v1 spec requires
            // a visible warning, because a silent reset looks identical to
            // "the backend went quiet".
            buffer.push(
                &self.source_id,
                "log source rotated or truncated — resuming from the start of the file",
                now_ms,
            );
            self.offset = 0;
            self.pending.clear();
        }

        if len == self.offset {
            return Ok(());
        }

        let mut file = File::open(&self.path)
            .map_err(|e| format!("cannot open log source {}: {e}", self.path.display()))?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|e| format!("cannot seek log source {}: {e}", self.path.display()))?;

        let mut budget = MAX_BYTES_PER_POLL;
        let mut chunk = vec![0u8; READ_CHUNK_BYTES];

        while budget > 0 {
            let want = READ_CHUNK_BYTES.min(budget as usize);
            let read = file
                .read(&mut chunk[..want])
                .map_err(|e| format!("cannot read log source {}: {e}", self.path.display()))?;
            if read == 0 {
                break;
            }
            budget -= read as u64;
            self.offset += read as u64;

            // Lossy conversion: a log file can contain a partial multi-byte
            // sequence at a chunk boundary or genuinely invalid bytes. Dropping
            // the whole chunk would be a silent data loss, which principle 4
            // forbids; a replacement character is the honest rendering.
            self.pending.push_str(&String::from_utf8_lossy(&chunk[..read]));

            while let Some(newline) = self.pending.find('\n') {
                let line: String = self.pending.drain(..=newline).collect();
                let line = line.trim_end_matches(['\n', '\r']);
                if !line.is_empty() {
                    buffer.push(&self.source_id, line, now_ms);
                }
            }

            // A single line longer than the cap will otherwise grow `pending`
            // without bound while we wait for a newline that may never come.
            if self.pending.len() > MAX_LINE_BYTES {
                let flushed = std::mem::take(&mut self.pending);
                buffer.push(&self.source_id, &flushed, now_ms);
            }
        }

        Ok(())
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test log_state::`
Expected: 2 of the 13 tests FAIL against the Step 3 code exactly as pasted above — this is a known defect in this plan's own reference code, not a transcription error, found and fixed during implementation (commit `02d0852`, log-tab SDD ledger). Both bugs and their fixes:

1. **`tailer_detects_truncation_and_emits_a_visible_warning_rather_than_silently_resyncing` fails** because the rotation-warning line at Step 3 line 623 goes through the ordinary `buffer.push()` path, which runs every line through Task 1's `parse_log_line` — a parser that only infers a `level` from JSON-object content, so a plain-text string always comes back `level: None`, but the test asserts `Some("WARN")`. **Fix:** add a private `push_note(&mut self, source_id: &str, level: &str, message: &str, captured_at_ms: i64)` method to `LogBuffer` (sharing insertion logic with `push` via a small private `insert` helper) that sets the level explicitly instead of inferring it from content. Change the rotation-warning call site to `buffer.push_note(&self.source_id, "WARN", "log source rotated or truncated — resuming from the start of the file", now_ms)`.
2. **`tailer_truncates_a_pathologically_long_line_instead_of_buffering_it_whole` fails** because Step 3's overlong-line branch (lines 671-674) pushes a truncated line once, clears `pending`, but keeps accumulating further chunk reads into `pending` as normal — so the same physical line's real tail, once its actual newline eventually arrives, gets pushed a *second* time as an ordinary line. The test asserts exactly one resulting `LogLine`. **Fix:** add a `skipping_overlong_line: bool` field to `SourceTailer`. Once a line is flushed-and-truncated, set it `true` and discard (don't re-buffer) further bytes belonging to that same physical line until its real newline is found, then resume normal parsing. Reset the flag alongside `offset`/`pending` on rotation/truncation too, so a rotation mid-overlong-line can't leave the tailer stuck.

Neither fix touches any test body, public signature, or constant — both are additive private helpers. See the merged `log_state.rs` for the exact code.

Expected after the fix: PASS — all Task 1 and Task 2 tests (13 total).

If `is_none_or` is rejected by the toolchain (it stabilized in Rust 1.82), replace `source_id.is_none_or(|s| l.source_id == s)` with `source_id.map_or(true, |s| l.source_id == s)`; behaviour is identical.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src/log_state.rs
git commit -m "feat(devbench): add bounded log ring buffer and incremental file tailer"
```

---

### Task 3: `LogState` — managed state and the background poll loop

**Files:**
- Modify: `apps/devbench/src-tauri/src/log_state.rs`
- Test: inline `#[cfg(test)]` module in `log_state.rs`

**Interfaces:**
- Consumes: `LogBuffer`, `SourceTailer` from Task 2.
- Produces: `pub struct LogState` with `pub fn new() -> Self`, `pub fn add_source(&self, label: String, path: PathBuf) -> Result<LogSourceStatus, String>`, `pub fn remove_source(&self, id: &str) -> Result<(), String>`, `pub fn list_sources(&self) -> Vec<LogSourceStatus>`, `pub fn read_since(&self, after_id: u64, source_id: Option<&str>, limit: usize) -> LogPage`, `pub fn next_line_id(&self) -> u64`, `pub fn collect_window(&self, after_id: u64, until_ms: i64) -> Option<Vec<LogLine>>`, and `pub fn poll_all(&self, now_ms: i64)`. Plus `pub struct LogSourceStatus { id, label, path, state, error }` and `pub struct LogPage { lines, next_id, dropped }`. Task 4 wraps these in Tauri commands; Task 6 calls `next_line_id` and `collect_window`.

`collect_window` returns `Option` deliberately: `None` means "no log source is running, so we did not observe logs at all", and `Some(vec![])` means "we were watching and nothing was logged". Collapsing those two into an empty vec is exactly the false-negative PRODUCT.md principle 4 forbids.

- [ ] **Step 1: Write the failing tests**

Append to the `#[cfg(test)] mod tests` block in `log_state.rs`:
```rust
    #[test]
    fn collect_window_returns_none_when_no_source_is_running() {
        let state = LogState::new();
        assert_eq!(state.collect_window(0, 10_000), None);
    }

    #[test]
    fn collect_window_returns_an_empty_vec_when_a_source_is_running_but_quiet() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let state = LogState::new();
        state.add_source("server.log".into(), path).unwrap();

        assert_eq!(state.collect_window(0, 10_000), Some(vec![]));
    }

    #[test]
    fn poll_all_marks_an_unreadable_source_as_errored_without_panicking() {
        let state = LogState::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gone.log");
        std::fs::write(&path, "").unwrap();
        let source = state.add_source("gone.log".into(), path.clone()).unwrap();

        std::fs::remove_file(&path).unwrap();
        state.poll_all(1_000);

        let sources = state.list_sources();
        let found = sources.iter().find(|s| s.id == source.id).unwrap();
        assert_eq!(found.state, "error");
        assert!(found.error.as_deref().unwrap().contains("gone.log"));
    }

    #[test]
    fn read_since_reports_dropped_lines_rather_than_under_reporting_silently() {
        let state = LogState::with_capacity(2);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();
        state.add_source("app.log".into(), path.clone()).unwrap();
        state.poll_all(1_000);

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write as _;
        writeln!(f, "one").unwrap();
        writeln!(f, "two").unwrap();
        writeln!(f, "three").unwrap();
        f.flush().unwrap();
        state.poll_all(2_000);

        let page = state.read_since(0, None, 100);
        assert_eq!(page.lines.len(), 2);
        assert!(page.dropped > 0, "caller must be able to see that lines were evicted");
    }

    #[test]
    fn add_source_rejects_a_path_that_is_not_a_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let state = LogState::new();
        let result = state.add_source("a directory".into(), dir.path().to_path_buf());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("regular file"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test collect_window_returns_none`
Expected: FAIL to compile — `LogState` does not exist.

- [ ] **Step 3: Implement `LogState`**

Append to `apps/devbench/src-tauri/src/log_state.rs`, above the `#[cfg(test)]` block:
```rust
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogSourceStatus {
    pub id: String,
    pub label: String,
    pub path: String,
    /// "live" while the last poll succeeded, "error" once one failed.
    pub state: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogPage {
    pub lines: Vec<LogLine>,
    /// The id to pass back as `after_id` on the next poll.
    pub next_id: u64,
    /// How many lines were evicted before the caller could read them. Non-zero
    /// means the view is incomplete and the UI must say so.
    pub dropped: u64,
}

struct Source {
    status: LogSourceStatus,
    tailer: SourceTailer,
}

/// Shared, Tauri-managed log observation state. Interior mutability behind one
/// `Mutex` because every operation is short (a metadata call plus a bounded
/// read) and the alternative — a lock per source plus one for the buffer —
/// buys nothing at the handful-of-sources scale this tool operates at.
pub struct LogState {
    inner: Mutex<Inner>,
}

struct Inner {
    buffer: LogBuffer,
    sources: Vec<Source>,
}

impl LogState {
    pub fn new() -> Self {
        Self::with_capacity(MAX_BUFFERED_LINES)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner { buffer: LogBuffer::new(capacity), sources: Vec::new() }),
        }
    }

    pub fn add_source(&self, label: String, path: PathBuf) -> Result<LogSourceStatus, String> {
        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!(
                "{} is not a regular file — DevBench v1 tails regular files only; \
                 pipe stdout with `yourapp 2>&1 | tee /tmp/devbench.log` and point at that file",
                path.display()
            ));
        }

        let status = LogSourceStatus {
            id: Uuid::new_v4().to_string(),
            label,
            path: path.display().to_string(),
            state: "live".to_string(),
            error: None,
        };
        let tailer = SourceTailer::new(status.id.clone(), path);

        let mut inner = self.inner.lock().map_err(|_| "log state poisoned".to_string())?;
        inner.sources.push(Source { status: status.clone(), tailer });
        Ok(status)
    }

    pub fn remove_source(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "log state poisoned".to_string())?;
        let before = inner.sources.len();
        inner.sources.retain(|s| s.status.id != id);
        if inner.sources.len() == before {
            return Err(format!("no log source with id {id}"));
        }
        Ok(())
    }

    pub fn list_sources(&self) -> Vec<LogSourceStatus> {
        match self.inner.lock() {
            Ok(inner) => inner.sources.iter().map(|s| s.status.clone()).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn read_since(&self, after_id: u64, source_id: Option<&str>, limit: usize) -> LogPage {
        match self.inner.lock() {
            Ok(inner) => {
                let lines = inner.buffer.since(after_id, source_id, limit);
                let next_id = lines.last().map(|l| l.id).unwrap_or(after_id);
                let dropped = inner.buffer.evicted_through_id().saturating_sub(after_id);
                LogPage { lines, next_id, dropped }
            }
            Err(_) => LogPage { lines: Vec::new(), next_id: after_id, dropped: 0 },
        }
    }

    pub fn next_line_id(&self) -> u64 {
        match self.inner.lock() {
            Ok(inner) => inner.buffer.next_id(),
            Err(_) => 0,
        }
    }

    /// `None` means no source was configured, so logs were NOT observed.
    /// `Some(vec![])` means we were watching and nothing was logged. These are
    /// different claims and the UI renders them differently.
    pub fn collect_window(&self, after_id: u64, until_ms: i64) -> Option<Vec<LogLine>> {
        let inner = self.inner.lock().ok()?;
        if inner.sources.is_empty() {
            return None;
        }
        Some(inner.buffer.between(after_id, until_ms))
    }

    /// Polls every configured source once. Errors are recorded on the source's
    /// status rather than propagated — one broken source must not stop the
    /// others, and the Log tab surfaces the error next to that source.
    pub fn poll_all(&self, now_ms: i64) {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return,
        };
        let Inner { buffer, sources } = &mut *inner;
        for source in sources.iter_mut() {
            match source.tailer.poll_once(buffer, now_ms) {
                Ok(()) => {
                    source.status.state = "live".to_string();
                    source.status.error = None;
                }
                Err(e) => {
                    // Push a synthetic warning only on the transition into the
                    // error state, not on every 250 ms poll.
                    if source.status.state != "error" {
                        buffer.push(&source.status.id, &format!("log source unreadable: {e}"), now_ms);
                    }
                    source.status.state = "error".to_string();
                    source.status.error = Some(e);
                }
            }
        }
    }
}

impl Default for LogState {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test log_state::`
Expected: PASS (18 total)

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src/log_state.rs
git commit -m "feat(devbench): add LogState with source lifecycle and poll loop"
```

---

### Task 4: Log Tauri commands and the 250 ms poll task

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/logs.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Test: inline `#[cfg(test)]` module in `logs.rs`

**Interfaces:**
- Consumes: `LogState` from Task 3.
- Produces: Tauri commands `add_log_source(input: AddLogSourceInput) -> Result<LogSourceStatus, String>`, `remove_log_source(id: String) -> Result<(), String>`, `list_log_sources() -> Result<Vec<LogSourceStatus>, String>`, `read_log_lines(input: ReadLogLinesInput) -> Result<LogPage, String>`, where `AddLogSourceInput { label: String, path: String }` and `ReadLogLinesInput { after_id: u64, source_id: Option<String>, limit: usize }`. Task 7's `lib/tauri.ts` mirrors these names and shapes exactly.

- [ ] **Step 1: Write the command module with its tests**

`apps/devbench/src-tauri/src/commands/logs.rs`:
```rust
use serde::Deserialize;
use std::path::PathBuf;
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
    logs: State<'_, LogState>,
    input: AddLogSourceInput,
) -> Result<LogSourceStatus, String> {
    add_log_source_impl(&logs, input)
}

#[tauri::command]
pub async fn remove_log_source(logs: State<'_, LogState>, id: String) -> Result<(), String> {
    logs.remove_source(&id)
}

#[tauri::command]
pub async fn list_log_sources(logs: State<'_, LogState>) -> Result<Vec<LogSourceStatus>, String> {
    Ok(logs.list_sources())
}

#[tauri::command]
pub async fn read_log_lines(
    logs: State<'_, LogState>,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test add_log_source_falls_back`
Expected: FAIL to compile — `commands::logs` is not declared in `commands/mod.rs`.

- [ ] **Step 3: Register the module and wire the poll task into `main.rs`**

`apps/devbench/src-tauri/src/commands/mod.rs`:
```rust
pub mod correlation;
pub mod db;
pub mod history;
pub mod logs;
pub mod request;
```

Modify `apps/devbench/src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devbench::commands;
use devbench::local_db::LocalDb;
use devbench::log_state::LogState;
use std::sync::Arc;
use tauri::Manager;

/// How often each log source is checked for appended bytes. 250 ms is 20x
/// finer than the 5 s correlation window and costs one `metadata()` call per
/// source per tick when nothing has changed.
const LOG_POLL_INTERVAL_MS: u64 = 250;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            tauri::async_runtime::block_on(async move {
                let db = LocalDb::connect(data_dir)
                    .await
                    .expect("failed to initialize local database");
                handle.manage(db);
            });

            let logs = Arc::new(LogState::new());
            app.manage(Arc::clone(&logs));

            // One background task polls every source. It outlives every
            // request; correlation windows read from the buffer it fills,
            // which is why no lines are lost between the two correlation calls.
            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_millis(LOG_POLL_INTERVAL_MS));
                loop {
                    ticker.tick().await;
                    let now_ms = chrono::Utc::now().timestamp_millis();
                    logs.poll_all(now_ms);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db::db_connect_and_list_tables,
            commands::db::list_table_rows,
            commands::request::fire_request,
            commands::history::save_history_entry,
            commands::history::list_history,
            commands::correlation::run_correlated_request,
            commands::correlation::collect_correlation_window,
            commands::logs::add_log_source,
            commands::logs::remove_log_source,
            commands::logs::list_log_sources,
            commands::logs::read_log_lines,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devbench");
}
```

Note: `LogState` is managed as `Arc<LogState>` so the background task and the command handlers share one instance. Command signatures therefore take `State<'_, Arc<LogState>>`. Update the four command signatures in `logs.rs` accordingly — replace `logs: State<'_, LogState>` with `logs: State<'_, Arc<LogState>>` and add `use std::sync::Arc;` at the top. The `_impl` functions keep taking `&LogState` and stay unchanged, which is exactly why they remain testable.

`commands::correlation::collect_correlation_window` does not exist yet — it is added in Task 6. Until then this `generate_handler!` list will not compile, so **do Task 5 and Task 6 before running the app.** Backend unit tests (`cargo test --lib`) still run, because they do not build `main.rs`.

- [ ] **Step 4: Run the log command tests**

Run: `cd apps/devbench/src-tauri && cargo test --lib logs::`
Expected: PASS (three tests)

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/logs.rs apps/devbench/src-tauri/src/commands/mod.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): add log source commands and background tail poll task"
```

---

### Task 5: Make DB verification failure honest instead of fatal

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`
- Test: inline `#[cfg(test)]` module in `correlation.rs`

**Interfaces:**
- Changes: `CorrelationResult` goes from `{ response: FireRequestOutput, table_diffs: Vec<TableDiff> }` to `{ correlation_id: String, response: FireRequestOutput, table_diffs: Option<Vec<TableDiff>>, db_error: Option<String> }`. `correlation_id` is populated in Task 6; this task adds the field with a placeholder value so the shape settles in one commit. Task 9's `Rollup` and Task 10's `ApiTab` consume these exact field names.

Today, a dropped Postgres connection mid-diff makes the whole command return `Err`, which throws away the HTTP response the developer just fired and replaces the rollup with a red error box. The v1 spec's Error handling section says the rollup must show "DB: unable to verify" — and the mockup has a `partial` rollup state built for it. `table_diffs: None` + `db_error: Some(msg)` is that state; `Some(vec![])` still means "checked, nothing changed".

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `apps/devbench/src-tauri/src/commands/correlation.rs`:
```rust
    // A watched table that does not exist stands in for any mid-diff DB
    // failure (dropped connection, revoked permission, dropped table). The
    // request itself succeeded, so the user must still get their response and
    // an explicit "unable to verify" — never a silent, false "0 writes".
    #[tokio::test]
    async fn a_db_failure_still_returns_the_response_and_reports_unable_to_verify() {
        let conn = test_connection();

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl(
            FireRequestInput {
                method: "GET".to_string(),
                url: format!("{}/ping", server.url()),
                body: None,
            },
            conn,
            vec!["table_that_does_not_exist_anywhere".to_string()],
            &crate::log_state::LogState::new(),
        )
        .await
        .expect("a DB verification failure must not fail the whole command");

        mock.assert_async().await;
        assert_eq!(result.response.status_code, 200);
        assert_eq!(result.response.body, "pong");
        assert!(result.table_diffs.is_none(), "diffs must be absent, not empty");
        assert!(result.db_error.is_some());
    }

    #[tokio::test]
    async fn a_successful_diff_reports_an_empty_vec_not_a_null() {
        let conn = test_connection();
        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl(
            FireRequestInput { method: "GET".to_string(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &crate::log_state::LogState::new(),
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(result.table_diffs, Some(vec![]), "watching nothing is still a successful verification");
        assert_eq!(result.db_error, None);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test a_db_failure_still_returns`
Expected: FAIL to compile — `run_correlated_request_impl` takes three arguments, `CorrelationResult` has no `db_error`, and `table_diffs` is not an `Option`.

- [ ] **Step 3: Restructure `CorrelationResult` and split the DB work into a fallible sub-step**

Modify `apps/devbench/src-tauri/src/commands/correlation.rs` — replace the `CorrelationResult` struct and `run_correlated_request_impl` with:
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

/// Snapshots every watched table. Returned as a `Result` so the caller can
/// degrade to "unable to verify" instead of failing the whole request.
async fn snapshot_all(
    pool: &Pool<Postgres>,
    watched_tables: &[String],
) -> Result<Vec<(String, String, Vec<RowSnapshot>)>, String> {
    let mut snapshots = Vec::with_capacity(watched_tables.len());
    for table in watched_tables {
        let pk_col = get_primary_key_column(pool, table).await?;
        let snapshot = snapshot_table(pool, table, &pk_col).await?;
        snapshots.push((table.clone(), pk_col, snapshot));
    }
    Ok(snapshots)
}

async fn diff_all(
    pool: &Pool<Postgres>,
    before: Vec<(String, String, Vec<RowSnapshot>)>,
) -> Result<Vec<TableDiff>, String> {
    let mut table_diffs = Vec::with_capacity(before.len());
    for (table, pk_col, before_rows) in before {
        let after = snapshot_table(pool, &table, &pk_col).await?;
        let diff = diff_table_snapshots(&table, &before_rows, &after);
        if diff.inserted > 0 || diff.updated > 0 || diff.deleted > 0 {
            table_diffs.push(diff);
        }
    }
    Ok(table_diffs)
}

pub async fn run_correlated_request_impl(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
    logs: &crate::log_state::LogState,
) -> Result<CorrelationResult, String> {
    // Everything DB-related is fallible-but-not-fatal. Only a failure to fire
    // the request itself fails the command, because without a response there
    // is nothing to correlate against.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(&connection))
        .await
        .map_err(|e| format!("connection failed: {e}"))
        .ok();

    let before = match &pool {
        Some(p) => snapshot_all(p, &watched_tables).await.map_err(Some),
        None => Err(Some("connection failed".to_string())),
    };

    let _ = logs; // used from Task 6 onward

    let response = fire_request_impl(request).await?;

    let (table_diffs, db_error) = match (pool, before) {
        (Some(p), Ok(snapshots)) => match diff_all(&p, snapshots).await {
            Ok(diffs) => (Some(diffs), None),
            Err(e) => (None, Some(e)),
        },
        (_, Err(e)) => (None, e),
        (None, Ok(_)) => (None, Some("connection failed".to_string())),
    };

    Ok(CorrelationResult {
        correlation_id: String::new(),
        response,
        table_diffs,
        db_error,
    })
}
```

Also update the existing `run_correlated_request` Tauri command body and the two tests that read `result.table_diffs` directly (`run_correlated_request_reports_only_tables_that_actually_changed` and `full_correlated_request_flow_persists_a_history_entry`) — the former's assertions become:
```rust
        let diffs = result.table_diffs.expect("diffs should be present");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].table, "orders_e2e");
        assert_eq!(diffs[0].inserted, 1);
```
and both call sites gain a fourth argument `&crate::log_state::LogState::new()`.

Update `apps/devbench/src-tauri/tests/smoke_test.rs` the same way — add the fourth argument and unwrap `table_diffs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test correlation::`
Expected: PASS. Then `cargo test` — the smoke test must still pass with its updated assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri
git commit -m "fix(devbench): report an unverifiable DB as 'unable to verify' instead of failing the request"
```

---

### Task 6: Two-phase correlation — window registry and `collect_correlation_window`

**Files:**
- Create: `apps/devbench/src-tauri/src/correlation_state.rs`
- Modify: `apps/devbench/src-tauri/src/lib.rs`
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Test: inline `#[cfg(test)]` module in `correlation.rs`

**Interfaces:**
- Consumes: `LogState::next_line_id` / `collect_window` (Task 3), `CorrelationResult` (Task 5).
- Produces:
  - `pub const DEFAULT_CORRELATION_WINDOW_MS: i64 = 5_000;`
  - `pub struct CorrelationRegistry` with `pub fn new() -> Self`, `pub fn open(&self, from_log_id: u64, window_ends_at_ms: i64) -> String`, `pub fn take(&self, id: &str) -> Option<OpenWindow>`, and `pub struct OpenWindow { from_log_id: u64, window_ends_at_ms: i64 }`.
  - `pub async fn collect_correlation_window_impl(registry: &CorrelationRegistry, logs: &LogState, correlation_id: String, now_ms: i64) -> Result<CorrelationWindowResult, String>` and Tauri command `collect_correlation_window(correlation_id: String) -> Result<CorrelationWindowResult, String>`, where `CorrelationWindowResult { log_lines: Option<Vec<LogLine>>, log_lines_truncated: bool }`.
  Task 9's `Rollup` and Task 10's `ApiTab` consume `log_lines` and `log_lines_truncated` under exactly these names. Plan 3 adds an `emails` field to `CorrelationWindowResult`.

`collect_correlation_window_impl` takes `now_ms` so a test can call it with the window already in the past and get an immediate answer instead of sleeping 5 real seconds.

- [ ] **Step 1: Create the registry**

`apps/devbench/src-tauri/src/correlation_state.rs`:
```rust
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
```

Modify `apps/devbench/src-tauri/src/lib.rs`:
```rust
pub mod commands;
pub mod correlation_state;
pub mod local_db;
pub mod log_state;
```

- [ ] **Step 2: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `apps/devbench/src-tauri/src/commands/correlation.rs`:
```rust
    use crate::correlation_state::{CorrelationRegistry, DEFAULT_CORRELATION_WINDOW_MS};
    use crate::log_state::LogState;

    #[tokio::test]
    async fn a_correlated_request_opens_a_window_that_can_be_collected() {
        let conn = test_connection();
        let logs = LogState::new();
        let registry = CorrelationRegistry::new();

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
            // Writing the log line from inside the mock's body callback puts it
            // strictly between the request being sent and the response landing,
            // which is what a real backend logging during a request looks like.
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
            FireRequestInput {
                method: "POST".to_string(),
                url: format!("{}/orders", server.url()),
                body: None,
            },
            conn,
            vec![],
            &logs,
            &registry,
            10_000,
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert!(!result.correlation_id.is_empty());

        // The tailer has not run since the write; drive it explicitly with a
        // capture time inside the window.
        logs.poll_all(10_100);

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
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
        let registry = CorrelationRegistry::new();

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &logs,
            &registry,
            10_000,
        )
        .await
        .unwrap();
        mock.assert_async().await;

        let window = collect_correlation_window_impl(
            &registry,
            &logs,
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
        let registry = CorrelationRegistry::new();
        let result =
            collect_correlation_window_impl(&registry, &logs, "not-a-real-id".into(), 1_000).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn a_window_can_only_be_collected_once() {
        let logs = LogState::new();
        let registry = CorrelationRegistry::new();
        let id = registry.open(0, 500);

        assert!(collect_correlation_window_impl(&registry, &logs, id.clone(), 1_000).await.is_ok());
        assert!(collect_correlation_window_impl(&registry, &logs, id, 1_000).await.is_err());
        assert_eq!(registry.len(), 0);
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test a_correlated_request_opens_a_window`
Expected: FAIL to compile — `run_correlated_request_impl_with_registry`, `collect_correlation_window_impl`, and `CorrelationWindowResult` do not exist.

- [ ] **Step 4: Implement the two phases**

Append to `apps/devbench/src-tauri/src/commands/correlation.rs`, above the `#[cfg(test)]` block:
```rust
use crate::correlation_state::{CorrelationRegistry, DEFAULT_CORRELATION_WINDOW_MS};
use crate::log_state::{LogLine, LogState};

#[derive(Debug, Serialize, PartialEq)]
pub struct CorrelationWindowResult {
    /// `None` means no log source was configured — logs were NOT observed.
    /// `Some(vec![])` means we were tailing and nothing was logged.
    pub log_lines: Option<Vec<LogLine>>,
    /// True when the ring buffer evicted lines belonging to this window before
    /// they were collected. The UI must render the count as "N+", never as N.
    pub log_lines_truncated: bool,
}

/// The real orchestration. `now_ms` is injected so tests can place the window
/// in the past and skip the wait entirely.
pub async fn run_correlated_request_impl_with_registry(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
    logs: &LogState,
    registry: &CorrelationRegistry,
    now_ms: i64,
) -> Result<CorrelationResult, String> {
    // Snapshot the log cursor BEFORE anything else: every line the backend
    // writes from this instant on is attributable to this request.
    let from_log_id = logs.next_line_id().saturating_sub(1);

    let mut result =
        run_correlated_request_impl(request, connection, watched_tables, logs).await?;

    result.correlation_id = registry.open(from_log_id, now_ms + DEFAULT_CORRELATION_WINDOW_MS);
    Ok(result)
}

pub async fn collect_correlation_window_impl(
    registry: &CorrelationRegistry,
    logs: &LogState,
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

    Ok(CorrelationWindowResult { log_lines, log_lines_truncated })
}

#[tauri::command]
pub async fn collect_correlation_window(
    registry: State<'_, Arc<CorrelationRegistry>>,
    logs: State<'_, Arc<LogState>>,
    correlation_id: String,
) -> Result<CorrelationWindowResult, String> {
    collect_correlation_window_impl(
        &registry,
        &logs,
        correlation_id,
        chrono::Utc::now().timestamp_millis(),
    )
    .await
}
```

Add `use std::sync::Arc;` to the top of `correlation.rs`, and change the existing `run_correlated_request` command to take the new state and call the registry variant:
```rust
#[tauri::command]
pub async fn run_correlated_request(
    db: State<'_, LocalDb>,
    logs: State<'_, Arc<LogState>>,
    registry: State<'_, Arc<CorrelationRegistry>>,
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
) -> Result<CorrelationResult, String> {
    let method = request.method.clone();
    let url = request.url.clone();
    let result = run_correlated_request_impl_with_registry(
        request,
        connection,
        watched_tables,
        &logs,
        &registry,
        chrono::Utc::now().timestamp_millis(),
    )
    .await?;
    save_correlation_history(&db.pool, &method, &url, &result.response).await;
    Ok(result)
}
```

Modify `apps/devbench/src-tauri/src/main.rs` — inside `.setup(...)`, after the `LogState` block:
```rust
            app.manage(Arc::new(devbench::correlation_state::CorrelationRegistry::new()));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test correlation::`
Expected: PASS

- [ ] **Step 6: Confirm the whole backend still builds and passes**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS — every test from Plan 1 plus everything added in Tasks 1–6.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src-tauri
git commit -m "feat(devbench): add two-phase correlation with a log collection window"
```

---

### Task 7: Frontend types, Tauri wrappers, and a mapped tab bar

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/store/useAppStore.test.ts`
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/App.test.tsx`

**Interfaces:**
- Consumes: the Rust command names and payload shapes from Tasks 4–6.
- Produces: `TabId = "api" | "db" | "log"`, the exported `TABS` array in `App.tsx`, and typed wrappers `invokeAddLogSource`, `invokeRemoveLogSource`, `invokeListLogSources`, `invokeReadLogLines`, `invokeCollectCorrelationWindow`. Tasks 8–10 import these exact names.

Plan 1 hand-wrote two `<button role="tab">` blocks. This task turns them into a mapped list *before* adding the third, so that Plan 3's Email tab is a one-line array entry rather than a fourth copy-paste. It also adds the `tablist` role that was missing, which is what makes `getAllByRole("tab")` reliable.

- [ ] **Step 1: Add types and wrappers**

Modify `apps/devbench/src/lib/tauri.ts` — replace the `CorrelationResult` interface and append the new block:
```ts
export interface CorrelationResult {
  correlation_id: string;
  response: FireRequestOutput;
  /** `null` means the database could not be verified — never render this as "0 writes". */
  table_diffs: TableDiff[] | null;
  db_error: string | null;
}

export interface LogLine {
  id: number;
  source_id: string;
  captured_at_ms: number;
  timestamp: string | null;
  level: string | null;
  message: string;
  raw: string;
}

export interface LogSourceStatus {
  id: string;
  label: string;
  path: string;
  state: string;
  error: string | null;
}

export interface LogPage {
  lines: LogLine[];
  next_id: number;
  dropped: number;
}

export interface CorrelationWindowResult {
  /** `null` means no log source is configured — logs were not observed at all. */
  log_lines: LogLine[] | null;
  log_lines_truncated: boolean;
}

export function invokeAddLogSource(label: string, path: string): Promise<LogSourceStatus> {
  return invoke("add_log_source", { input: { label, path } });
}

export function invokeRemoveLogSource(id: string): Promise<void> {
  return invoke("remove_log_source", { id });
}

export function invokeListLogSources(): Promise<LogSourceStatus[]> {
  return invoke("list_log_sources");
}

export function invokeReadLogLines(args: {
  afterId: number;
  sourceId?: string;
  limit: number;
}): Promise<LogPage> {
  return invoke("read_log_lines", {
    input: { after_id: args.afterId, source_id: args.sourceId ?? null, limit: args.limit },
  });
}

export function invokeCollectCorrelationWindow(correlationId: string): Promise<CorrelationWindowResult> {
  return invoke("collect_correlation_window", { correlationId });
}
```

- [ ] **Step 2: Write the failing store test**

Append to `apps/devbench/src/store/useAppStore.test.ts`:
```ts
  it("can switch to the log tab", () => {
    useAppStore.getState().setActiveTab("log");
    expect(useAppStore.getState().activeTab).toBe("log");
  });

  it("tracks the selected log source", () => {
    expect(useAppStore.getState().activeLogSourceId).toBeNull();
    useAppStore.getState().setActiveLogSourceId("src-1");
    expect(useAppStore.getState().activeLogSourceId).toBe("src-1");
  });
```

Run: `bun run test -- useAppStore.test.ts`
Expected: FAIL — `"log"` is not assignable to `TabId`, and `activeLogSourceId` does not exist.

- [ ] **Step 3: Extend the store**

Modify `apps/devbench/src/store/useAppStore.ts`:
```ts
import { create } from "zustand";

export type TabId = "api" | "db" | "log";
export type ThemePref = "dark" | "light" | "system";

interface AppState {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  theme: ThemePref;
  setTheme: (theme: ThemePref) => void;
  watchedTables: Set<string>;
  toggleWatchedTable: (table: string) => void;
  /** Which log source the Log tab is showing; null means "all sources". */
  activeLogSourceId: string | null;
  setActiveLogSourceId: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: "api",
  setActiveTab: (tab) => set({ activeTab: tab }),
  theme: "dark",
  setTheme: (theme) => set({ theme }),
  watchedTables: new Set(),
  toggleWatchedTable: (table) =>
    set((state) => {
      const next = new Set(state.watchedTables);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return { watchedTables: next };
    }),
  activeLogSourceId: null,
  setActiveLogSourceId: (id) => set({ activeLogSourceId: id }),
}));
```

Run: `bun run test -- useAppStore.test.ts`
Expected: PASS

- [ ] **Step 4: Write the failing App test**

Replace `apps/devbench/src/App.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App shell", () => {
  it("renders the DevBench brand and one tab per configured tool", () => {
    render(<App />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["API", "DB", "Log"]);
  });

  it("marks exactly one tab selected", () => {
    render(<App />);
    const selected = screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
  });
});
```

Run: `bun run test -- App.test.tsx`
Expected: FAIL — only two tabs exist.

- [ ] **Step 5: Map the tab bar and mount the Log tab**

Modify `apps/devbench/src/App.tsx`:
```tsx
import { useState } from "react";
import { useAppStore, type TabId } from "./store/useAppStore";
import { ApiTab } from "./components/api/ApiTab";
import { DbTab } from "./components/db/DbTab";
import { LogTab } from "./components/log/LogTab";

/**
 * Single source of truth for the tool tabs. Plan 3 adds `{ id: "email", label: "Email" }`
 * here and nowhere else in this file.
 */
export const TABS: { id: TabId; label: string }[] = [
  { id: "api", label: "API" },
  { id: "db", label: "DB" },
  { id: "log", label: "Log" },
];

export default function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);
  const [dbFocusTable, setDbFocusTable] = useState<string | null>(null);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-13 items-center gap-4 border-b border-border px-4">
        <span className="font-bold text-text">DevBench</span>
        <nav className="flex gap-1" role="tablist" aria-label="DevBench sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`rounded-sm px-3 py-2 text-sm font-medium ${
                activeTab === tab.id ? "bg-surface-2 text-text" : "text-text-muted"
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        {activeTab === "api" ? <ApiTab onOpenTableInDb={setDbFocusTable} /> : null}
        {activeTab === "db" ? (
          <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
        ) : null}
        {activeTab === "log" ? <LogTab /> : null}
      </main>
    </div>
  );
}
```

- [ ] **Step 6: Commit (tests will not pass until Task 8 creates `LogTab`)**

`App.test.tsx` fails to resolve `./components/log/LogTab` until Task 8. Do Task 8 immediately after this one; commit them together if you prefer a green tree at every commit:

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/store apps/devbench/src/App.tsx apps/devbench/src/App.test.tsx
git commit -m "feat(devbench): extend TabId to log and map the tab bar over an array"
```

---

### Task 8: `LogStream` — the virtualized line list

**Files:**
- Modify: `apps/devbench/package.json`
- Create: `apps/devbench/src/components/log/LogStream.tsx`
- Create: `apps/devbench/src/components/log/LogStream.test.tsx`

**Interfaces:**
- Consumes: `LogLine` from Task 7's `lib/tauri.ts`.
- Produces: `<LogStream lines={LogLine[]} filter={string} />`. Task 9's `LogTab` owns the lines and the filter string and passes them down; `LogStream` is presentational and does no fetching.

Virtualization means jsdom reports every element's height as 0, so a naive test renders zero rows. The shim below (defining `offsetHeight`/`offsetWidth`/`getBoundingClientRect` on the prototype) is applied once in the test file and is what makes the virtualizer produce rows under test.

- [ ] **Step 1: Add the dependency**

Modify `apps/devbench/package.json`, under `dependencies`:
```json
    "@tanstack/react-virtual": "^3.14.0"
```

Run: `bun install`

- [ ] **Step 2: Write the failing test**

`apps/devbench/src/components/log/LogStream.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { LogStream } from "./LogStream";
import type { LogLine } from "../../lib/tauri";

// jsdom gives every element a height of 0, which makes TanStack Virtual
// compute a zero-row viewport and render nothing. Give the layout primitives
// real numbers so the virtualizer has a window to fill.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => {} };
  };
});

function line(id: number, over: Partial<LogLine> = {}): LogLine {
  const merged = {
    id,
    source_id: "src1",
    captured_at_ms: 1_000 + id,
    timestamp: "2026-07-30T14:02:11.482Z",
    level: "INFO",
    message: `line ${id}`,
    raw: `line ${id}`,
    ...over,
  };
  // LogStream filters on `raw`, not `message` — if a caller overrides only
  // `message` (as the filter test below does), `raw` must follow it or the
  // filter test fails against this helper's own stale placeholder data.
  if (over.message !== undefined && over.raw === undefined) {
    merged.raw = over.message;
  }
  return merged;
}

describe("LogStream", () => {
  it("renders an empty state when there are no lines", () => {
    render(<LogStream lines={[]} filter="" />);
    expect(screen.getByText(/no log lines yet/i)).toBeInTheDocument();
  });

  it("renders lines with their level and message", () => {
    render(<LogStream lines={[line(1), line(2)]} filter="" />);
    expect(screen.getByText("line 1")).toBeInTheDocument();
    expect(screen.getAllByText("INFO").length).toBeGreaterThan(0);
  });

  it("virtualizes rather than rendering every line", () => {
    const many = Array.from({ length: 3000 }, (_, i) => line(i + 1));
    render(<LogStream lines={many} filter="" />);
    const rows = screen.getAllByTestId("log-line");
    expect(rows.length).toBeLessThan(200);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("applies a case-insensitive substring filter", () => {
    render(
      <LogStream
        lines={[line(1, { message: "order created" }), line(2, { message: "inventory low" })]}
        filter="ORDER"
      />,
    );
    expect(screen.getByText("order created")).toBeInTheDocument();
    expect(screen.queryByText("inventory low")).not.toBeInTheDocument();
  });

  it("says so when the filter matches nothing, instead of looking empty", () => {
    render(<LogStream lines={[line(1)]} filter="zzzz" />);
    expect(screen.getByText(/no lines match/i)).toBeInTheDocument();
  });
});
```

Run: `bun run test -- LogStream.test.tsx`
Expected: FAIL — `./LogStream` does not exist.

- [ ] **Step 3: Implement `LogStream`**

`apps/devbench/src/components/log/LogStream.tsx`:
```tsx
import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogLine } from "../../lib/tauri";

const ROW_HEIGHT = 22;

function levelClass(level: string | null): string {
  switch (level) {
    case "ERROR":
    case "FATAL":
      return "text-danger";
    case "WARN":
      return "text-warning";
    default:
      return "text-text-faint";
  }
}

/** `2026-07-30T14:02:11.482Z` -> `14:02:11.482`; anything unparsed is shown as-is. */
function shortTime(timestamp: string | null): string {
  if (!timestamp) return "";
  const match = /(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(timestamp);
  return match ? match[1] : timestamp;
}

export function LogStream({ lines, filter }: { lines: LogLine[]; filter: string }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((l) => l.raw.toLowerCase().includes(needle));
  }, [lines, filter]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // A live tail is only useful pinned to the newest line.
  useEffect(() => {
    if (visible.length > 0) virtualizer.scrollToIndex(visible.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length]);

  if (lines.length === 0) {
    return (
      <div className="p-4 text-sm text-text-faint">
        No log lines yet. Add a source, or pipe your backend's output with{" "}
        <code className="font-mono">yourapp 2&gt;&amp;1 | tee /tmp/devbench.log</code>.
      </div>
    );
  }

  if (visible.length === 0) {
    return <div className="p-4 text-sm text-text-faint">No lines match “{filter}”.</div>;
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto font-mono text-xs" data-testid="log-stream">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const l = visible[item.index];
          return (
            <div
              key={l.id}
              data-testid="log-line"
              className="absolute left-0 flex w-full items-baseline gap-2.5 px-3"
              style={{ top: 0, transform: `translateY(${item.start}px)`, height: item.size }}
            >
              <span className="w-24 shrink-0 tabular-nums text-text-faint">{shortTime(l.timestamp)}</span>
              <span className={`w-12 shrink-0 font-bold ${levelClass(l.level)}`}>{l.level ?? ""}</span>
              <span className="truncate text-text">{l.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- LogStream.test.tsx`
Expected: PASS (five tests)

- [ ] **Step 5: Commit**

`bun install` in Step 1 also regenerates the root `bun.lock` — this repo commits lockfile changes alongside dependency changes (established precedent: commit `308e762`), so stage it too or a fresh clone at this commit has a `package.json`/`bun.lock` mismatch.

```bash
git add apps/devbench/package.json bun.lock apps/devbench/src/components/log
git commit -m "feat(devbench): add virtualized LogStream with filtering"
```

---

### Task 9: `LogSourcesSidebar`, `AddLogSourceForm`, and `LogTab`

**Files:**
- Create: `apps/devbench/src/components/log/LogSourcesSidebar.tsx`
- Create: `apps/devbench/src/components/log/LogSourcesSidebar.test.tsx`
- Create: `apps/devbench/src/components/log/AddLogSourceForm.tsx`
- Create: `apps/devbench/src/components/log/AddLogSourceForm.test.tsx`
- Create: `apps/devbench/src/components/log/LogTab.tsx`

**Interfaces:**
- Consumes: `invokeListLogSources`, `invokeAddLogSource`, `invokeRemoveLogSource`, `invokeReadLogLines` (Task 7); `<LogStream />` (Task 8); `activeLogSourceId` from the store (Task 7).
- Produces: `<LogTab />`, mounted by `App.tsx` from Task 7. `LogTab` accepts an optional `focusSourceId` prop in Task 10 for the rollup deep-link — the prop is declared here so Task 10 is pure wiring.

The internal pattern matches DB and API: list sidebar on the left, detail on the right (the v1 spec's "All four tools follow the same internal pattern").

- [ ] **Step 1: Write the failing sidebar test**

`apps/devbench/src/components/log/LogSourcesSidebar.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogSourcesSidebar } from "./LogSourcesSidebar";

const sources = [
  { id: "a", label: "server.log", path: "/tmp/server.log", state: "live", error: null },
  { id: "b", label: "worker.log", path: "/tmp/worker.log", state: "error", error: "cannot read /tmp/worker.log" },
];

describe("LogSourcesSidebar", () => {
  it("lists sources and highlights the selected one", () => {
    render(
      <LogSourcesSidebar
        sources={sources}
        activeSourceId="a"
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "server.log" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "worker.log" })).toHaveAttribute("aria-current", "false");
  });

  it("shows the error text for a source that cannot be read", () => {
    render(
      <LogSourcesSidebar sources={sources} activeSourceId={null} onSelect={() => {}} onRemove={() => {}} onAdd={() => {}} />,
    );
    expect(screen.getByText(/cannot read \/tmp\/worker\.log/)).toBeInTheDocument();
  });

  it("selects a source when clicked", () => {
    const onSelect = vi.fn();
    render(
      <LogSourcesSidebar sources={sources} activeSourceId={null} onSelect={onSelect} onRemove={() => {}} onAdd={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "worker.log" }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("removes a source", () => {
    const onRemove = vi.fn();
    render(
      <LogSourcesSidebar sources={sources} activeSourceId={null} onSelect={() => {}} onRemove={onRemove} onAdd={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove server.log" }));
    expect(onRemove).toHaveBeenCalledWith("a");
  });
});
```

Each source row below renders two buttons: a select button (accessible name is the
label alone, e.g. `"server.log"`) and a remove button (`aria-label={\`Remove ${label}\`}`,
e.g. `"Remove server.log"`). `getByRole`'s regex name matcher is an unanchored
substring test, so a regex like `/server\.log/` matches BOTH buttons and throws
"Found multiple elements" — use exact strings (`"server.log"`, `"worker.log"`) for
the select-button matchers above, as written.

Run: `bun run test -- LogSourcesSidebar.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 2: Implement `LogSourcesSidebar`**

`apps/devbench/src/components/log/LogSourcesSidebar.tsx`:
```tsx
import type { LogSourceStatus } from "../../lib/tauri";

export function LogSourcesSidebar({
  sources,
  activeSourceId,
  onSelect,
  onRemove,
  onAdd,
}: {
  sources: LogSourceStatus[];
  /** `null` means "all sources". */
  activeSourceId: string | null;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <aside className="flex w-55 min-w-55 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border p-2.5 text-xs font-bold text-text-muted">
        Sources
        <button onClick={onAdd} className="rounded-sm px-1.5 py-0.5 text-text-muted hover:bg-surface-2">
          + Add
        </button>
      </div>
      <div className="flex flex-col gap-0.5 overflow-y-auto p-1.5">
        <button
          onClick={() => onSelect(null)}
          aria-current={activeSourceId === null}
          className={`rounded-sm p-2 text-left text-xs ${
            activeSourceId === null ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
          }`}
        >
          All sources
        </button>
        {sources.map((source) => (
          <div key={source.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <button
                onClick={() => onSelect(source.id)}
                aria-current={activeSourceId === source.id}
                className={`flex flex-1 items-center gap-1.5 rounded-sm p-2 text-left text-xs ${
                  activeSourceId === source.id ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    source.state === "live" ? "bg-success" : "bg-danger"
                  }`}
                />
                <span className="truncate">{source.label}</span>
              </button>
              <button
                aria-label={`Remove ${source.label}`}
                onClick={() => onRemove(source.id)}
                className="rounded-sm px-1.5 text-text-faint hover:bg-surface-2 hover:text-text"
              >
                ✕
              </button>
            </div>
            {source.error ? (
              <div className="mx-2 rounded-sm bg-danger-bg px-2 py-1 text-[11px] text-danger">{source.error}</div>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
```

Run: `bun run test -- LogSourcesSidebar.test.tsx`
Expected: PASS

- [ ] **Step 3: Write the failing add-form test**

`apps/devbench/src/components/log/AddLogSourceForm.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddLogSourceForm } from "./AddLogSourceForm";

describe("AddLogSourceForm", () => {
  it("submits the entered path and label", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourceForm onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    fireEvent.change(screen.getByPlaceholderText("/tmp/devbench.log"), {
      target: { value: "/tmp/app.log" },
    });
    fireEvent.change(screen.getByPlaceholderText("server.log"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({ label: "api", path: "/tmp/app.log" });
  });

  it("does not submit an empty path", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourceForm onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a backend error", () => {
    render(<AddLogSourceForm onSubmit={() => {}} onCancel={() => {}} error="is not a regular file" />);
    expect(screen.getByText(/is not a regular file/)).toBeInTheDocument();
  });
});
```

Run: `bun run test -- AddLogSourceForm.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 4: Implement `AddLogSourceForm`**

`apps/devbench/src/components/log/AddLogSourceForm.tsx`:
```tsx
import { useState } from "react";

export function AddLogSourceForm({
  onSubmit,
  onCancel,
  error,
}: {
  onSubmit: (input: { label: string; path: string }) => void;
  onCancel: () => void;
  error: string | null;
}) {
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");

  function submit() {
    if (!path.trim()) return;
    onSubmit({ label: label.trim(), path: path.trim() });
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border bg-surface p-3">
      <div className="flex gap-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/tmp/devbench.log"
          className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-sm text-text"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="server.log"
          className="w-40 rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text"
        />
        <button onClick={submit} className="rounded-sm bg-accent px-4 text-sm font-bold text-accent-on">
          Add source
        </button>
        <button onClick={onCancel} className="rounded-sm px-3 text-sm text-text-muted hover:bg-surface-2">
          Cancel
        </button>
      </div>
      <div className="text-[11px] text-text-faint">
        DevBench v1 tails regular files. For a process that writes to stdout, run it as{" "}
        <code className="font-mono">yourapp 2&gt;&amp;1 | tee /tmp/devbench.log</code> and point here.
      </div>
      {error ? (
        <div className="rounded-sm bg-danger-bg px-2 py-1 text-xs text-danger">{error}</div>
      ) : null}
    </div>
  );
}
```

Run: `bun run test -- AddLogSourceForm.test.tsx`
Expected: PASS

- [ ] **Step 5: Assemble `LogTab`**

`apps/devbench/src/components/log/LogTab.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { LogSourcesSidebar } from "./LogSourcesSidebar";
import { AddLogSourceForm } from "./AddLogSourceForm";
import { LogStream } from "./LogStream";
import { useAppStore } from "../../store/useAppStore";
import {
  invokeAddLogSource,
  invokeListLogSources,
  invokeReadLogLines,
  invokeRemoveLogSource,
  type LogLine,
  type LogSourceStatus,
} from "../../lib/tauri";

/** How often the frontend drains newly-tailed lines from the Rust buffer. */
const POLL_INTERVAL_MS = 500;
/** How many lines the UI keeps rendered. Matches the Rust buffer's own cap. */
const MAX_RENDERED_LINES = 5_000;

export function LogTab({ focusSourceId = null }: { focusSourceId?: string | null }) {
  const activeSourceId = useAppStore((s) => s.activeLogSourceId);
  const setActiveSourceId = useAppStore((s) => s.setActiveLogSourceId);

  const [sources, setSources] = useState<LogSourceStatus[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const afterIdRef = useRef(0);

  const refreshSources = useCallback(async () => {
    try {
      setSources(await invokeListLogSources());
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    if (focusSourceId) setActiveSourceId(focusSourceId);
  }, [focusSourceId, setActiveSourceId]);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  // Changing the source filter restarts the read cursor so the pane shows that
  // source's buffered history rather than only what arrives from now on.
  useEffect(() => {
    afterIdRef.current = 0;
    setLines([]);
    setDropped(0);
  }, [activeSourceId]);

  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const page = await invokeReadLogLines({
          afterId: afterIdRef.current,
          sourceId: activeSourceId ?? undefined,
          limit: 500,
        });
        if (cancelled) return;
        if (page.dropped > 0) setDropped((d) => d + page.dropped);
        if (page.lines.length > 0) {
          afterIdRef.current = page.next_id;
          setLines((prev) => [...prev, ...page.lines].slice(-MAX_RENDERED_LINES));
        }
      } catch {
        // A transient IPC failure is not worth tearing the pane down; the next
        // tick retries. Source-level failures surface via `source.error`.
      }
    }, POLL_INTERVAL_MS);
    void refreshSources();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeSourceId, refreshSources]);

  async function handleAdd(input: { label: string; path: string }) {
    setAddError(null);
    try {
      await invokeAddLogSource(input.label, input.path);
      setShowAdd(false);
      await refreshSources();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemove(id: string) {
    try {
      await invokeRemoveLogSource(id);
      if (activeSourceId === id) setActiveSourceId(null);
      await refreshSources();
    } catch {
      await refreshSources();
    }
  }

  return (
    <div className="-m-6 flex h-full">
      <LogSourcesSidebar
        sources={sources}
        activeSourceId={activeSourceId}
        onSelect={setActiveSourceId}
        onRemove={handleRemove}
        onAdd={() => setShowAdd(true)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {showAdd ? (
          <AddLogSourceForm onSubmit={handleAdd} onCancel={() => setShowAdd(false)} error={addError} />
        ) : null}
        <div className="flex items-center gap-2 border-b border-border p-2.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-sm text-text"
          />
          <span className="text-xs font-semibold text-text-muted">
            {sources.some((s) => s.state === "live") ? "Live" : "Idle"}
          </span>
        </div>
        {dropped > 0 ? (
          <div className="border-b border-border bg-warning-bg px-3 py-1.5 text-xs text-warning">
            {dropped} earlier line{dropped === 1 ? "" : "s"} scrolled out of the buffer and are not shown.
          </div>
        ) : null}
        <div className="flex-1 overflow-hidden">
          <LogStream lines={lines} filter={filter} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the full frontend suite**

Run: `bun run test`
Expected: PASS — including `App.test.tsx`, which can now resolve `LogTab`.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/components/log
git commit -m "feat(devbench): add the Log tab with sources sidebar, filter, and live tail"
```

---

### Task 10: Rollup chip row and end-to-end wiring of the two-phase call

**Files:**
- Modify: `apps/devbench/src/components/rollup/Rollup.tsx`
- Modify: `apps/devbench/src/components/rollup/Rollup.test.tsx`
- Modify: `apps/devbench/src/components/api/ApiTab.tsx`
- Modify: `apps/devbench/src/App.tsx`

**Interfaces:**
- Consumes: `CorrelationResult` and `CorrelationWindowResult` (Task 7), `invokeCollectCorrelationWindow` (Task 7).
- Produces: `<Rollup data={RollupData | null} loading={boolean} onOpenDb={(table: string) => void} onOpenLog={() => void} />` where
  ```ts
  export interface RollupData {
    tableDiffs: TableDiff[] | null;
    watchedTableCount: number;
    logLines: LogLine[] | null;
    logLinesTruncated: boolean;
    dbError: string | null;
    /** True while the correlation window is still open — the Log chip is pending. */
    windowOpen: boolean;
  }
  ```
  **Plan 3 adds exactly two fields to `RollupData` (`emails: CapturedEmail[] | null` and `emailError: string | null`) and one entry to the chip array.** The chip row is built by mapping over an array precisely so that is a small change.

The chip row (`DB · N writes →`, `Log · N lines →`) is the shape the mockup designs (`docs/mockups/devbench.html`, the `rollup-row` block). The per-table breakdown from Plan 1 is kept as a second line beneath the chips, because per-table deep-linking is a real capability the chip row alone would throw away.

- [ ] **Step 1: Rewrite the Rollup tests**

Replace `apps/devbench/src/components/rollup/Rollup.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Rollup, type RollupData } from "./Rollup";

function data(over: Partial<RollupData> = {}): RollupData {
  return {
    tableDiffs: [],
    watchedTableCount: 0,
    logLines: null,
    logLinesTruncated: false,
    dbError: null,
    windowOpen: false,
    ...over,
  };
}

describe("Rollup", () => {
  it("shows a loading skeleton", () => {
    render(<Rollup data={null} loading onOpenDb={() => {}} onOpenLog={() => {}} />);
    expect(screen.getByTestId("rollup-loading")).toBeInTheDocument();
  });

  it("shows a distinct message when diff data isn't available at all (history entries)", () => {
    render(
      <Rollup
        data={data({ tableDiffs: null, dbError: null, watchedTableCount: 0 })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByText(/not available for past requests/i)).toBeInTheDocument();
  });

  it("warns that the DB could not be verified rather than showing zero writes", () => {
    render(
      <Rollup
        data={data({ tableDiffs: null, dbError: "connection failed", watchedTableCount: 2 })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByText(/unable to verify/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 writes/)).not.toBeInTheDocument();
  });

  it("says no tables are watched, distinctly from nothing having changed", () => {
    render(<Rollup data={data({ watchedTableCount: 0 })} loading={false} onOpenDb={() => {}} onOpenLog={() => {}} />);
    expect(screen.getByText(/no tables are being watched/i)).toBeInTheDocument();
  });

  it("shows aggregate DB writes and per-table detail, and deep-links per table", () => {
    const onOpenDb = vi.fn();
    render(
      <Rollup
        data={data({
          watchedTableCount: 2,
          tableDiffs: [
            { table: "orders", inserted: 1, updated: 0, deleted: 0 },
            { table: "inventory", inserted: 0, updated: 2, deleted: 0 },
          ],
        })}
        loading={false}
        onOpenDb={onOpenDb}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /DB.*3 writes/ })).toBeInTheDocument();
    const perTable = screen.getByRole("button", { name: /orders/ });
    expect(perTable).toHaveTextContent("1 inserted");
    fireEvent.click(perTable);
    expect(onOpenDb).toHaveBeenCalledWith("orders");
  });

  it("shows a log chip with the captured line count and deep-links to the Log tab", () => {
    const onOpenLog = vi.fn();
    render(
      <Rollup
        data={data({
          watchedTableCount: 1,
          logLines: [
            { id: 1, source_id: "s", captured_at_ms: 1, timestamp: null, level: "INFO", message: "a", raw: "a" },
            { id: 2, source_id: "s", captured_at_ms: 2, timestamp: null, level: "INFO", message: "b", raw: "b" },
          ],
        })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={onOpenLog}
      />,
    );
    const chip = screen.getByRole("button", { name: /Log.*2 lines/ });
    fireEvent.click(chip);
    expect(onOpenLog).toHaveBeenCalled();
  });

  it("renders the log count as N+ when the buffer dropped lines from the window", () => {
    render(
      <Rollup
        data={data({
          watchedTableCount: 1,
          logLines: [{ id: 1, source_id: "s", captured_at_ms: 1, timestamp: null, level: null, message: "a", raw: "a" }],
          logLinesTruncated: true,
        })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Log.*1\+ lines/ })).toBeInTheDocument();
  });

  it("says logs were not observed when no source is configured, not '0 lines'", () => {
    render(
      <Rollup data={data({ watchedTableCount: 1, logLines: null })} loading={false} onOpenDb={() => {}} onOpenLog={() => {}} />,
    );
    expect(screen.getByText(/log: not observed/i)).toBeInTheDocument();
  });

  it("shows the log chip as pending while the correlation window is still open", () => {
    render(
      <Rollup
        data={data({ watchedTableCount: 1, logLines: null, windowOpen: true })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByTestId("rollup-log-pending")).toBeInTheDocument();
  });
});
```

Run: `bun run test -- Rollup.test.tsx`
Expected: FAIL — `RollupData` is not exported and the props do not match.

- [ ] **Step 2: Rewrite `Rollup`**

`apps/devbench/src/components/rollup/Rollup.tsx`:
```tsx
import type { LogLine, TableDiff } from "../../lib/tauri";

export interface RollupData {
  /** `null` = the DB was not verified. `[]` = verified, nothing changed. */
  tableDiffs: TableDiff[] | null;
  watchedTableCount: number;
  /** `null` = no log source configured, so logs were not observed. */
  logLines: LogLine[] | null;
  /** True when the buffer evicted lines belonging to this window. */
  logLinesTruncated: boolean;
  dbError: string | null;
  /** True while the correlation window has not closed yet. */
  windowOpen: boolean;
}

function summarize(diff: TableDiff): string {
  const parts: string[] = [];
  if (diff.inserted > 0) parts.push(`${diff.inserted} inserted`);
  if (diff.updated > 0) parts.push(`${diff.updated} updated`);
  if (diff.deleted > 0) parts.push(`${diff.deleted} deleted`);
  return parts.join(", ");
}

function totalWrites(diffs: TableDiff[]): number {
  return diffs.reduce((n, d) => n + d.inserted + d.updated + d.deleted, 0);
}

/** The table with the most changes — where the DB chip's deep-link lands. */
function busiestTable(diffs: TableDiff[]): string | null {
  let best: TableDiff | null = null;
  for (const d of diffs) {
    const n = d.inserted + d.updated + d.deleted;
    if (!best || n > best.inserted + best.updated + best.deleted) best = d;
  }
  return best?.table ?? null;
}

function Chip({ label, count, onClick }: { label: string; count: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-sm font-semibold text-text hover:bg-surface-2"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-text-faint" aria-hidden="true" />
      {label}
      <span className="font-normal tabular-nums text-text-muted">{count}</span>
      <span className="font-bold text-accent" aria-hidden="true">→</span>
    </button>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-text-faint">{children}</span>;
}

export function Rollup({
  data,
  loading,
  onOpenDb,
  onOpenLog,
}: {
  data: RollupData | null;
  loading: boolean;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
}) {
  if (loading) {
    return (
      <div data-testid="rollup-loading" className="flex gap-4.5 p-3">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  if (!data) return null;

  const chips: React.ReactNode[] = [];

  // --- DB ---
  if (data.tableDiffs === null && data.dbError) {
    chips.push(
      <span key="db" className="rounded-sm bg-warning-bg px-2 py-1 text-sm font-semibold text-warning">
        ⚠ DB unable to verify — {data.dbError}
      </span>,
    );
  } else if (data.tableDiffs === null) {
    chips.push(<Note key="db">DB: not available for past requests.</Note>);
  } else if (data.watchedTableCount === 0) {
    chips.push(<Note key="db">No tables are being watched — select tables in the DB tab.</Note>);
  } else if (data.tableDiffs.length === 0) {
    chips.push(<Note key="db">DB: no observed effects.</Note>);
  } else {
    const target = busiestTable(data.tableDiffs);
    const writes = totalWrites(data.tableDiffs);
    chips.push(
      <Chip
        key="db"
        label="DB"
        count={`${writes} write${writes === 1 ? "" : "s"}`}
        onClick={() => target && onOpenDb(target)}
      />,
    );
  }

  // --- Log ---
  if (data.windowOpen) {
    chips.push(
      <span key="log" data-testid="rollup-log-pending" className="flex items-center gap-1.5 text-sm text-text-faint">
        <span className="h-3 w-16 animate-pulse rounded bg-surface-2" />
      </span>,
    );
  } else if (data.logLines === null) {
    chips.push(<Note key="log">Log: not observed — no source configured.</Note>);
  } else {
    const n = data.logLines.length;
    chips.push(
      <Chip
        key="log"
        label="Log"
        count={`${n}${data.logLinesTruncated ? "+" : ""} line${n === 1 && !data.logLinesTruncated ? "" : "s"}`}
        onClick={onOpenLog}
      />,
    );
  }

  const perTable = data.tableDiffs ?? [];

  return (
    <div className="flex flex-col gap-1.5 p-3">
      <div className="flex flex-wrap items-center gap-4">{chips}</div>
      {perTable.length > 0 ? (
        <div className="flex flex-wrap gap-3 pl-0.5">
          {perTable.map((diff) => (
            <button
              key={diff.table}
              onClick={() => onOpenDb(diff.table)}
              className="text-xs text-text-muted hover:text-text"
            >
              <span className="font-semibold">{diff.table}</span> {summarize(diff)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

Run: `bun run test -- Rollup.test.tsx`
Expected: PASS (nine tests)

- [ ] **Step 3: Wire the two-phase call in `ApiTab`**

Modify `apps/devbench/src/components/api/ApiTab.tsx` — replace the `DisplayResult` interface and the handlers:
```tsx
import { useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { HistorySidebar } from "./HistorySidebar";
import { Rollup, type RollupData } from "../rollup/Rollup";
import { useAppStore } from "../../store/useAppStore";
import {
  invokeCollectCorrelationWindow,
  type CorrelationResult,
  type DbConnectInput,
  type FireRequestOutput,
  type HistoryEntry,
} from "../../lib/tauri";

const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

interface DisplayResult {
  response: FireRequestOutput;
  rollup: RollupData;
}

export function ApiTab({ onOpenTableInDb }: { onOpenTableInDb: (table: string) => void }) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  function handleSendStart() {
    setSending(true);
    setResult(null);
    setError(null);
  }

  // Phase 1 landed: paint the response and the DB diffs immediately, then let
  // the correlation window finish in the background and fill in the Log chip.
  async function handleResult(correlation: CorrelationResult) {
    setSending(false);
    setResult({
      response: correlation.response,
      rollup: {
        tableDiffs: correlation.table_diffs,
        watchedTableCount: watchedTables.size,
        logLines: null,
        logLinesTruncated: false,
        dbError: correlation.db_error,
        windowOpen: true,
      },
    });
    setHistoryRefreshKey((k) => k + 1);

    try {
      const window = await invokeCollectCorrelationWindow(correlation.correlation_id);
      setResult((prev) =>
        prev
          ? {
              ...prev,
              rollup: {
                ...prev.rollup,
                logLines: window.log_lines,
                logLinesTruncated: window.log_lines_truncated,
                windowOpen: false,
              },
            }
          : prev,
      );
    } catch {
      // The window could not be collected (app restarted, id expired). Closing
      // it as "not observed" is honest; claiming zero lines would not be.
      setResult((prev) =>
        prev ? { ...prev, rollup: { ...prev.rollup, logLines: null, windowOpen: false } } : prev,
      );
    }
  }

  function handleError(message: string) {
    setSending(false);
    setError(message);
  }

  function handleHistorySelect(entry: HistoryEntry) {
    setSending(false);
    setError(null);
    setResult({
      response: { status_code: entry.status_code, body: entry.response_body, duration_ms: entry.duration_ms },
      rollup: {
        tableDiffs: null,
        watchedTableCount: watchedTables.size,
        logLines: null,
        logLinesTruncated: false,
        dbError: null,
        windowOpen: false,
      },
    });
  }

  function handleOpenDb(table: string) {
    setActiveTab("db");
    onOpenTableInDb(table);
  }

  return (
    <div className="-m-6 flex h-full">
      <HistorySidebar onSelect={handleHistorySelect} refreshKey={historyRefreshKey} />
      <div className="mx-auto flex max-w-180 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <RequestBuilder
          connection={DEV_CONNECTION}
          watchedTables={watchedTables}
          onSendStart={handleSendStart}
          onResult={handleResult}
          onError={handleError}
        />
        {error ? (
          <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
        ) : null}
        <ResponseViewer result={result?.response ?? null} />
        {result || sending ? (
          <div>
            <div className="m-0.5 text-[11.5px] font-bold uppercase tracking-wide text-text-faint">
              What happened
            </div>
            <div className="rounded-lg border border-border bg-surface">
              <Rollup
                data={result?.rollup ?? null}
                loading={sending}
                onOpenDb={handleOpenDb}
                onOpenLog={() => setActiveTab("log")}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

Note: the history-selected case sets `tableDiffs: null` with `dbError: null`, which is the "not available for past requests" branch — a stored history entry never captured diff data.

- [ ] **Step 4: Fix the RequestBuilder test's mocked shape**

`RequestBuilder.test.tsx` mocks `invokeRunCorrelatedRequest`'s resolved value, which now needs the new fields. Modify the `mockResolvedValue` in `apps/devbench/src/components/api/RequestBuilder.test.tsx`:
```tsx
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-1",
      response: { status_code: 201, body: '{"id":8841}', duration_ms: 142 },
      table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
      db_error: null,
    });
```
and update the matching `expect(onResult).toHaveBeenCalledWith({...})` assertion with the same four fields.

- [ ] **Step 5: Run the full frontend suite**

Run: `bun run test`
Expected: PASS — every file.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src
git commit -m "feat(devbench): show DB and Log chips in the rollup via two-phase correlation"
```

---

### Task 11: End-to-end verification

**Files:**
- Modify: `apps/devbench/src-tauri/tests/smoke_test.rs`

**Interfaces:**
- Consumes: everything above. Produces no new interfaces — this is the plan's proof that the full loop works against a real Postgres, a real HTTP server, and a real file on disk.

- [ ] **Step 1: Add the log leg to the smoke test**

Append to `apps/devbench/src-tauri/tests/smoke_test.rs`:
```rust
use devbench::commands::correlation::{
    collect_correlation_window_impl, run_correlated_request_impl_with_registry,
};
use devbench::correlation_state::{CorrelationRegistry, DEFAULT_CORRELATION_WINDOW_MS};
use devbench::log_state::LogState;

#[tokio::test]
async fn firing_a_request_correlates_both_db_writes_and_log_lines() {
    let conn = test_connection();
    let pool = PgPoolOptions::new()
        .connect(&format!(
            "postgres://{}:{}@{}:{}/{}",
            conn.username, conn.password, conn.host, conn.port, conn.database
        ))
        .await
        .expect("requires a real local Postgres");

    sqlx::query("DROP TABLE IF EXISTS smoke_log_orders").execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE smoke_log_orders (id serial PRIMARY KEY, status text)")
        .execute(&pool)
        .await
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("backend.log");
    std::fs::write(&log_path, "").unwrap();

    let logs = LogState::new();
    logs.add_source("backend.log".into(), log_path.clone()).unwrap();
    logs.poll_all(1_000);

    let registry = CorrelationRegistry::new();

    // The mocked backend does both things a real one would during the request:
    // writes a row and writes a log line.
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
                    sqlx::query("INSERT INTO smoke_log_orders (status) VALUES ('pending')")
                        .execute(&p)
                        .await
                        .unwrap();
                });
            })
            .join()
            .unwrap();

            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new().append(true).open(&log_for_mock).unwrap();
            writeln!(f, r#"{{"level":"info","msg":"order created id=1"}}"#).unwrap();
            writeln!(f, r#"{{"level":"warn","msg":"inventory low"}}"#).unwrap();
            f.flush().unwrap();

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
        vec!["smoke_log_orders".to_string()],
        &logs,
        &registry,
        50_000,
    )
    .await
    .expect("correlated request should succeed");

    mock.assert_async().await;

    let diffs = result.table_diffs.expect("DB should have been verified");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].table, "smoke_log_orders");
    assert_eq!(diffs[0].inserted, 1);
    assert_eq!(result.db_error, None);

    logs.poll_all(50_100);

    let window = collect_correlation_window_impl(
        &registry,
        &logs,
        result.correlation_id,
        50_000 + DEFAULT_CORRELATION_WINDOW_MS + 1,
    )
    .await
    .unwrap();

    let lines = window.log_lines.expect("a source is configured, so lines must be Some");
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].level.as_deref(), Some("INFO"));
    assert_eq!(lines[1].level.as_deref(), Some("WARN"));

    sqlx::query("DROP TABLE smoke_log_orders").execute(&pool).await.unwrap();
}
```

- [ ] **Step 2: Run the whole backend suite**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS — Plan 1's 30 tests (with the updated `table_diffs` assertions) plus everything added here.

- [ ] **Step 3: Run the whole frontend suite**

Run: `cd apps/devbench && bun run test`
Expected: PASS

- [ ] **Step 4: Launch the app and confirm the loop by hand**

```bash
# terminal 1
printf 'seed\n' > /tmp/devbench.log
# terminal 2
cd apps/devbench && bun run tauri dev
```

In the app: DB tab → watch a table. Log tab → Add → `/tmp/devbench.log`. API tab → fire a request at any URL. Then from terminal 1, within 5 seconds of the response: `echo '{"level":"info","msg":"hello"}' >> /tmp/devbench.log`.
Expected: the response and DB chip paint immediately; the Log chip shows a pending skeleton and then resolves to `Log 1 line →`; clicking it switches to the Log tab.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/tests/smoke_test.rs
git commit -m "test(devbench): correlate DB writes and log lines end to end"
```

---

## Self-Review

**Spec coverage.** v1 spec, Log tab row: "tail a file or stdout; JSON-lines parsed into fields, plain text shown raw" — Tasks 1–4 (stdout via `tee`, scope decision recorded above). Components section, "Log tab: a sources sidebar listing configured log sources, each independently browsable — not a single active source with an inline picker. Live tail, search/filter apply to whichever source is selected" — Tasks 8–9. Correlation engine, "collect log lines timestamped within the correlation window (default 5s post-response, configurable in Settings)" — Tasks 3, 6; configurability is Plan 4, flagged in Decision 4. Error handling, "Log source becomes unreadable or rotates mid-tail → a visible warning appears in the Log tab; lines are never silently dropped without indication" — Task 2 (rotation warning line), Task 3 (error state + synthetic warning), Task 9 (`dropped` banner). Error handling, "DB snapshot fails mid-diff → the rollup shows 'DB: unable to verify,' never a false '0 writes'" — Task 5, Task 10. IA, "condensed summary with jump-links that deep-link into the relevant tab" — Task 10. PRODUCT.md principle 4 — every count in this plan is nullable and rendered distinctly when null. Deliberately **not** covered, per the phasing: Email tab and SMTP catching (Plan 3), Sessions/Archive, Split view, Settings, Chat dock (Plan 4), named-pipe log sources (deferred, recorded above), persisting configured log sources across restarts (Plan 4's persistence work — sources are in-memory in this plan, same as watched tables today).

**Placeholder scan.** No TBD/TODO markers. Every code step contains the actual code. `DEFAULT_CORRELATION_WINDOW_MS` and the in-memory source list are the only two deliberate "later" items, both named as scoping decisions with the plan that closes them. Every `Result` is mapped to a real `format!` error string. No step says "add error handling" without showing it.

**Type consistency.** `LogLine { id, source_id, captured_at_ms, timestamp, level, message, raw }` is defined once in Task 1 and used with those exact names in Tasks 2, 3, 6, 7, 8, 10. `LogSourceStatus { id, label, path, state, error }` is defined once in Task 3 and mirrored once in `lib/tauri.ts` (Task 7). `CorrelationResult { correlation_id, response, table_diffs, db_error }` is settled in Task 5 and consumed unchanged in Tasks 6, 7, 10. `CorrelationWindowResult { log_lines, log_lines_truncated }` is defined in Task 6 and mirrored in Task 7. `RollupData` is defined once in Task 10 and is the only type Plan 3 needs to extend. `run_correlated_request_impl` gains its fourth parameter in Task 5 and every call site (two unit tests plus the smoke test) is updated in that same task.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-30-devbench-v1-log-tab.md`.
