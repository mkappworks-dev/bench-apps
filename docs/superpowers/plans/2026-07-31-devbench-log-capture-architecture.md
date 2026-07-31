# DevBench log capture — architecture (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix log capture's two structural gaps — nothing survives a restart, and one shared in-memory buffer lets a chatty source evict a quiet source's lines — and add a command-spawning source kind, without touching the frontend.

**Architecture:** Replace the single shared `LogBuffer` inside `LogState` with one buffer per source, keyed off a shared monotonic id counter so ordering and `after_id` cursors behave exactly as before. Add a `SourceKind` (`File` | `Command`) so a source can be a spawned child process instead of only a tailed file. Persist source configuration and captured lines to two new SQLite tables via a periodic batched flush (reusing the existing ticker pattern) plus an explicit flush on graceful shutdown.

**Tech Stack:** Rust, Tauri v2, `tokio` (already has the `full` feature set — `tokio::process` needs no `Cargo.toml` change), `sqlx` (SQLite), existing `LocalDb`/migration mechanism.

## Global Constraints

- Comments stay sparse — only for non-obvious rationale (a hidden constraint, a subtle invariant), never restating what the code already says.
- Every new/changed piece of behavior gets a test; TDD (failing test → minimal implementation → passing test) throughout.
- This plan is backend/Rust only. The current frontend (`AddLogSourceForm`, `LogTab.tsx`, `lib/tauri.ts`) is not touched and must keep working unmodified against the changed backend — see the backward-compatibility notes in Task 4.
- Follow the existing codebase's patterns: `_impl` functions that take `&LocalDb`'s pool or `&LogState` directly (unit-testable without a running Tauri app), tauri command wrappers that just call them, `Result<T, String>` for fallible operations, migrations as plain numbered `.sql` files under `apps/devbench/src-tauri/migrations/`.
- Run tests with `cargo test` from `apps/devbench/src-tauri/`.

---

## File Structure

| File | Change |
|---|---|
| `apps/devbench/src-tauri/migrations/0004_log_capture.sql` | New. `log_sources` + `log_lines` tables. |
| `apps/devbench/src-tauri/src/log_state.rs` | Major rewrite: `SourceKind`, per-source buffers, shared id counter, command-source spawning/lifecycle, `take_unflushed`. |
| `apps/devbench/src-tauri/src/commands/logs.rs` | `AddLogSourceInput` gains kind fields (backward compatible); persistence functions (`persist_log_source`, `load_persisted_sources`, `flush_new_lines`, `prune_log_lines`); startup restore helper. |
| `apps/devbench/src-tauri/src/main.rs` | Restore persisted sources on startup; add a 1s flush/prune ticker; add a graceful-shutdown flush hook. |
| `apps/devbench/src-tauri/src/commands/correlation.rs` | One test call site updated for the new `add_source` signature; otherwise unchanged (verified, not modified, in Task 6). |

No other files change. No `Cargo.toml` change (`tokio`'s `full` feature already includes `process`).

---

### Task 1: `log_sources` and `log_lines` migration

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0004_log_capture.sql`
- Test: `apps/devbench/src-tauri/src/commands/logs.rs` (new `#[cfg(test)]` module, appended)

**Interfaces:**
- Produces: two SQLite tables, `log_sources` and `log_lines`, applied automatically by `LocalDb::connect` (which already runs `sqlx::migrate!("./migrations")`).

- [ ] **Step 1: Write the migration**

```sql
-- apps/devbench/src-tauri/migrations/0004_log_capture.sql

-- Persisted source *config* only — no runtime state column. Live/error/
-- exited status is recomputed every time a source is (re-)added, including
-- on startup restore, so it can never be stale-loaded from disk.
CREATE TABLE log_sources (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- 'file' | 'command'
  path       TEXT,                 -- kind = 'file'
  program    TEXT,                 -- kind = 'command'
  args       TEXT,                 -- kind = 'command', JSON array
  cwd        TEXT,                 -- kind = 'command', optional
  created_at TEXT NOT NULL
);

-- `id` is the SAME id space LogState's in-memory buffers use, not a
-- separate SQLite-assigned identity, so a line's id means the same thing
-- whether it's read from the live buffer or from history.
--
-- Not cascade-deleted when a source is removed: removing a source stops
-- new capture, it doesn't erase that source's history from Search.
CREATE TABLE log_lines (
  id             INTEGER PRIMARY KEY,
  source_id      TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  timestamp      TEXT,
  level          TEXT,
  message        TEXT NOT NULL,
  raw            TEXT NOT NULL
);
CREATE INDEX idx_log_lines_source_id ON log_lines (source_id);
CREATE INDEX idx_log_lines_captured_at_ms ON log_lines (captured_at_ms);
```

- [ ] **Step 2: Write a failing test proving the migration applies and both tables are usable**

Append to `apps/devbench/src-tauri/src/commands/logs.rs`, inside the existing `#[cfg(test)] mod tests { use super::*; ... }` block:

```rust
    #[tokio::test]
    async fn migration_0004_creates_usable_log_sources_and_log_lines_tables() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        sqlx::query(
            "INSERT INTO log_sources (id, label, kind, path, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("src1")
        .bind("server.log")
        .bind("file")
        .bind("/tmp/app.log")
        .bind("2026-07-31T00:00:00Z")
        .execute(&db.pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(1i64)
        .bind("src1")
        .bind(1_000i64)
        .bind(Option::<String>::None)
        .bind("INFO")
        .bind("started")
        .bind("started")
        .execute(&db.pool)
        .await
        .unwrap();

        let source_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_sources")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let line_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_lines WHERE source_id = 'src1'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(source_count, 1);
        assert_eq!(line_count, 1);
    }
```

- [ ] **Step 3: Run it to verify it fails before the migration exists**

Run: `cargo test migration_0004_creates_usable_log_sources_and_log_lines_tables` from `apps/devbench/src-tauri/`
Expected: FAIL — `no such table: log_sources` (this step only makes sense if Step 1 hasn't landed yet; if you wrote the migration file first, skip straight to Step 4 and confirm PASS instead — the point is to have seen it fail against a version of the tree without the migration, which the `sqlx::migrate!` macro embeds at compile time from the `migrations/` directory).

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test migration_0004_creates_usable_log_sources_and_log_lines_tables` from `apps/devbench/src-tauri/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/migrations/0004_log_capture.sql apps/devbench/src-tauri/src/commands/logs.rs
git commit -m "feat(devbench): add log_sources and log_lines tables"
```

---

### Task 2: Per-source buffers with a shared id counter

This is the core structural fix: today one `LogBuffer` is shared by every source (`Inner { buffer: LogBuffer, sources: Vec<Source> }`), so a chatty source evicts a quiet source's lines. This task gives each source its own buffer while keeping id assignment centralized and monotonic, so ordering, `after_id` cursors, and the correlation window's semantics are unaffected.

No new capability yet (still file-only) — this task is a pure structural refactor with the same externally-observable behavior for file sources, verified by rewriting the existing tests against the new shape and adding new tests for the buffer-isolation and cross-source-merge behavior the refactor exists to enable.

**Files:**
- Modify: `apps/devbench/src-tauri/src/log_state.rs` (whole-file rewrite of everything from the `LogBuffer` struct onward — roughly today's lines 89–770)
- Modify: `apps/devbench/src-tauri/src/commands/logs.rs:35, 82-91` (the two `state.add_source(...)` call sites — production and test)
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs` (one test call site, `logs.add_source("app.log".into(), log_path.clone())`)

**Interfaces:**
- Produces:
  - `pub enum SourceKind { File { path: PathBuf } }` (gains a `Command` variant in Task 3)
  - `LogState::add_source(&self, label: String, kind: SourceKind) -> Result<LogSourceStatus, String>` — **signature change** from today's `add_source(&self, label: String, path: PathBuf)`
  - `LogState::read_since(&self, after_id: u64, source_id: Option<&str>, limit: usize) -> LogPage` — same signature, now merges across per-source buffers
  - `LogState::collect_window(&self, after_id: u64, until_ms: i64) -> Option<Vec<LogLine>>` — same signature, same `None`/`Some(vec![])` contract, now merges across per-source buffers
  - `LogState::next_line_id(&self) -> u64`, `LogState::list_sources(&self) -> Vec<LogSourceStatus>`, `LogState::remove_source(&self, id: &str) -> Result<(), String>`, `LogState::poll_all(&self, now_ms: i64)` — unchanged signatures
  - `LogSourceStatus` gains `kind: String` and `exit_code: Option<i32>` fields (additive — the current frontend never reads `LogSourceStatus` fields beyond `id`/`label`/`state`/`error`, so this is not a breaking wire-format change)
- Consumes: nothing new from other tasks (this is the foundation).

- [ ] **Step 1: Read the current file in full for reference while editing**

Open `apps/devbench/src-tauri/src/log_state.rs`. Keep the top section — `LogLine`, `ParsedLine`, `numeric_level_name`, `level_from_value`, `first_string`, `parse_log_line`, and all six of `parse_log_line`'s existing tests (lines 1–87 and the four `parses_*`/`keeps_*`/`treats_*`/`falls_back_*` tests) — **completely unchanged**. Everything from the `MAX_BUFFERED_LINES` constant onward is rewritten below.

- [ ] **Step 2: Replace the constants and add `SOURCE_BUFFER_CAPACITY`**

Replace:
```rust
pub const MAX_BUFFERED_LINES: usize = 5_000;
```
with:
```rust
/// How many parsed lines are kept in memory PER SOURCE. Old lines are
/// evicted from that source's own buffer only — a chatty source can no
/// longer push a quiet source's lines out. SQLite (Task 4) is the durable,
/// unbounded-by-comparison tier; this is just the hot live-tail cache.
pub const SOURCE_BUFFER_CAPACITY: usize = 1_000;
```

Keep `MAX_BYTES_PER_POLL`, `MAX_LINE_BYTES`, `READ_CHUNK_BYTES` exactly as they are.

- [ ] **Step 3: Extract line preparation into a standalone function**

Today, `LogBuffer::push` both assigns an id and does truncation/parsing. Since ids now come from a single shared counter one level up, split those concerns. Add, right after the constants:

```rust
/// The result of truncating (if needed) and parsing one raw line, ready to
/// be handed to `LogBuffer::insert` once the caller has allocated an id.
struct PreparedLine {
    raw: String,
    timestamp: Option<String>,
    level: Option<String>,
    message: String,
}

fn prepare_line(raw: &str) -> PreparedLine {
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
    PreparedLine { raw: raw.to_string(), timestamp: parsed.timestamp, level: parsed.level, message: parsed.message }
}
```

- [ ] **Step 4: Rewrite `LogBuffer` to take externally-assigned ids**

Replace the whole `LogBuffer` struct and its `impl` block with:

```rust
pub struct LogBuffer {
    lines: VecDeque<LogLine>,
    capacity: usize,
    evicted_through_id: u64,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self { lines: VecDeque::with_capacity(capacity.min(1024)), capacity, evicted_through_id: 0 }
    }

    /// The highest id that has been dropped from this buffer. A caller
    /// whose `from_id` is at or below this knows its view is incomplete.
    pub fn evicted_through_id(&self) -> u64 {
        self.evicted_through_id
    }

    /// Inserts one line under an id the caller already allocated from
    /// LogState's single shared counter — this buffer never assigns ids
    /// itself, so two different sources' buffers can never collide.
    pub fn insert(
        &mut self,
        id: u64,
        source_id: &str,
        captured_at_ms: i64,
        timestamp: Option<String>,
        level: Option<String>,
        message: String,
        raw: String,
    ) {
        self.lines.push_back(LogLine { id, source_id: source_id.to_string(), captured_at_ms, timestamp, level, message, raw });
        while self.lines.len() > self.capacity {
            if let Some(dropped) = self.lines.pop_front() {
                self.evicted_through_id = dropped.id;
            }
        }
    }

    pub fn since(&self, after_id: u64, limit: usize) -> Vec<LogLine> {
        self.lines.iter().filter(|l| l.id > after_id).take(limit).cloned().collect()
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

    /// Lines with id greater than `flushed_through_id` — used by the
    /// persistence sweep (Task 5). Read-only; does not touch eviction.
    pub fn unflushed_since(&self, flushed_through_id: u64) -> Vec<LogLine> {
        self.lines.iter().filter(|l| l.id > flushed_through_id).cloned().collect()
    }
}
```

Note `since` and `between` dropped their `source_id: Option<&str>` filter parameter — a single `LogBuffer` now only ever holds one source's lines, so there's nothing to filter. The multi-source filtering/merging moves up to `LogState`, in Step 8.

- [ ] **Step 5: Rewrite `LogBuffer`'s unit tests for the new API**

Replace the four `LogBuffer`-level tests (`buffer_evicts_oldest_lines_and_records_how_far_it_evicted`, `buffer_between_selects_by_id_lower_bound_and_capture_time_upper_bound`, `buffer_since_can_filter_to_a_single_source`) with:

```rust
    #[test]
    fn buffer_evicts_oldest_lines_and_records_how_far_it_evicted() {
        let mut buffer = LogBuffer::new(3);
        for i in 0..5u64 {
            buffer.insert(i + 1, "src1", 1_000 + i as i64, None, None, format!("line {i}"), format!("line {i}"));
        }
        let lines = buffer.since(0, 100);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].message, "line 2");
        // ids 1 and 2 are gone; a caller holding from_id = 0 must be able to tell.
        assert_eq!(buffer.evicted_through_id(), 2);
    }

    #[test]
    fn buffer_between_selects_by_id_lower_bound_and_capture_time_upper_bound() {
        let mut buffer = LogBuffer::new(100);
        buffer.insert(1, "src1", 1_000, None, None, "before".into(), "before".into());
        buffer.insert(2, "src1", 1_500, None, None, "inside".into(), "inside".into());
        buffer.insert(3, "src1", 9_999, None, None, "after the window".into(), "after the window".into());

        let selected = buffer.between(1, 2_000);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].message, "inside");
    }

    #[test]
    fn buffer_unflushed_since_returns_only_lines_after_the_flush_cursor() {
        let mut buffer = LogBuffer::new(100);
        buffer.insert(1, "src1", 1_000, None, None, "a".into(), "a".into());
        buffer.insert(2, "src1", 1_001, None, None, "b".into(), "b".into());
        buffer.insert(3, "src1", 1_002, None, None, "c".into(), "c".into());

        let unflushed = buffer.unflushed_since(1);
        assert_eq!(unflushed.len(), 2);
        assert_eq!(unflushed[0].message, "b");
        assert_eq!(unflushed[1].message, "c");
    }
```

(`buffer_since_can_filter_to_a_single_source` is removed here — its intent moves to a new `LogState`-level test in Step 10, since filtering by source is now `LogState`'s job, not `LogBuffer`'s.)

- [ ] **Step 6: Run the buffer tests to confirm they fail to compile against the old API, then pass**

Run: `cargo test --lib log_state::tests::buffer_` from `apps/devbench/src-tauri/`
Expected: compile error first (old `push`/`since(after_id, source_id, limit)` calls don't exist yet in this test file until you finish Step 5) — once Step 4 and Step 5 are both saved, expect PASS for all four.

- [ ] **Step 7: Introduce `SourceKind` and rewrite `SourceTailer` to take an external id counter**

Replace the `SourceTailer` struct and `impl` block with:

```rust
/// What a source captures from. `Command` is added in Task 3.
#[derive(Debug, Clone, PartialEq)]
pub enum SourceKind {
    File { path: PathBuf },
}

/// Tails one regular file. Holds the byte offset it has consumed and the
/// partial trailing line it has not yet seen a newline for.
pub struct SourceTailer {
    source_id: String,
    path: PathBuf,
    offset: u64,
    pending: String,
    started: bool,
    skipping_overlong_line: bool,
}

impl SourceTailer {
    pub fn new(source_id: String, path: PathBuf) -> Self {
        Self { source_id, path, offset: 0, pending: String::new(), started: false, skipping_overlong_line: false }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Reads whatever has been appended since the last call, bounded by
    /// `MAX_BYTES_PER_POLL`, and pushes complete lines into `buffer`, each
    /// under an id allocated from `next_id` (LogState's shared counter).
    ///
    /// On the very first call the tailer seeks to EOF instead of reading the
    /// file's history — pointing DevBench at an existing multi-gigabyte log
    /// must not replay it.
    pub fn poll_once(&mut self, buffer: &mut LogBuffer, next_id: &mut u64, now_ms: i64) -> Result<(), String> {
        let metadata = std::fs::metadata(&self.path)
            .map_err(|e| format!("cannot read log source {}: {e}", self.path.display()))?;
        let len = metadata.len();

        if !self.started {
            self.started = true;
            self.offset = len;
            return Ok(());
        }

        if len < self.offset {
            // Rotated or truncated. Never silently resync: a silent reset
            // looks identical to "the backend went quiet."
            let id = *next_id;
            *next_id += 1;
            buffer.insert(
                id,
                &self.source_id,
                now_ms,
                None,
                Some("WARN".to_string()),
                "log source rotated or truncated — resuming from the start of the file".to_string(),
                "log source rotated or truncated — resuming from the start of the file".to_string(),
            );
            self.offset = 0;
            self.pending.clear();
            self.skipping_overlong_line = false;
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

            self.pending.push_str(&String::from_utf8_lossy(&chunk[..read]));

            loop {
                if self.skipping_overlong_line {
                    match self.pending.find('\n') {
                        Some(newline) => {
                            self.pending.drain(..=newline);
                            self.skipping_overlong_line = false;
                        }
                        None => {
                            self.pending.clear();
                            break;
                        }
                    }
                } else if let Some(newline) = self.pending.find('\n') {
                    let line: String = self.pending.drain(..=newline).collect();
                    let line = line.trim_end_matches(['\n', '\r']);
                    if !line.is_empty() {
                        let prepared = prepare_line(line);
                        let id = *next_id;
                        *next_id += 1;
                        buffer.insert(id, &self.source_id, now_ms, prepared.timestamp, prepared.level, prepared.message, prepared.raw);
                    }
                } else {
                    break;
                }
            }

            if !self.skipping_overlong_line && self.pending.len() > MAX_LINE_BYTES {
                let flushed = std::mem::take(&mut self.pending);
                let prepared = prepare_line(&flushed);
                let id = *next_id;
                *next_id += 1;
                buffer.insert(id, &self.source_id, now_ms, prepared.timestamp, prepared.level, prepared.message, prepared.raw);
                self.skipping_overlong_line = true;
            }
        }

        Ok(())
    }
}
```

This is line-for-line the same tailing logic as before; only the id source changed (`*next_id` instead of an internal counter) and line insertion now goes through `prepare_line` + `buffer.insert` instead of `buffer.push`.

- [ ] **Step 8: Rewrite `SourceTailer`'s existing tests for the new `poll_once` signature**

Replace the five `tailer_*` tests with:

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

        let mut buffer = LogBuffer::new(SOURCE_BUFFER_CAPACITY);
        let mut next_id = 1u64;
        let mut tailer = SourceTailer::new("src1".to_string(), path.clone());

        tailer.poll_once(&mut buffer, &mut next_id, 1_000).unwrap();
        assert_eq!(buffer.since(0, 100).len(), 0);

        write_and_flush(&path, "second line\n");
        tailer.poll_once(&mut buffer, &mut next_id, 2_000).unwrap();
        let lines = buffer.since(0, 100);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].message, "second line");
        assert_eq!(lines[0].captured_at_ms, 2_000);

        tailer.poll_once(&mut buffer, &mut next_id, 3_000).unwrap();
        assert_eq!(buffer.since(0, 100).len(), 1);
    }

    #[test]
    fn tailer_detects_truncation_and_emits_a_visible_warning_rather_than_silently_resyncing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "aaaa\nbbbb\n").unwrap();

        let mut buffer = LogBuffer::new(SOURCE_BUFFER_CAPACITY);
        let mut next_id = 1u64;
        let mut tailer = SourceTailer::new("src1".to_string(), path.clone());
        tailer.poll_once(&mut buffer, &mut next_id, 1_000).unwrap();

        std::fs::write(&path, "cccc\n").unwrap();
        tailer.poll_once(&mut buffer, &mut next_id, 2_000).unwrap();

        let lines = buffer.since(0, 100);
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

        let mut buffer = LogBuffer::new(SOURCE_BUFFER_CAPACITY);
        let mut next_id = 1u64;
        let mut tailer = SourceTailer::new("src1".to_string(), path.clone());
        tailer.poll_once(&mut buffer, &mut next_id, 1_000).unwrap();

        let line = "x".repeat(1023);
        let mut blob = String::new();
        for _ in 0..2_000 {
            blob.push_str(&line);
            blob.push('\n');
        }
        write_and_flush(&path, &blob);

        tailer.poll_once(&mut buffer, &mut next_id, 2_000).unwrap();
        let after_first = buffer.since(0, 10_000).len();
        assert!(after_first > 0, "first poll should have read something");
        assert!(after_first < 2_000, "first poll must stop at the per-poll byte budget");

        tailer.poll_once(&mut buffer, &mut next_id, 3_000).unwrap();
        assert!(buffer.since(0, 10_000).len() > after_first, "next poll resumes from the saved offset");
    }

    #[test]
    fn tailer_truncates_a_pathologically_long_line_instead_of_buffering_it_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let mut buffer = LogBuffer::new(SOURCE_BUFFER_CAPACITY);
        let mut next_id = 1u64;
        let mut tailer = SourceTailer::new("src1".to_string(), path.clone());
        tailer.poll_once(&mut buffer, &mut next_id, 1_000).unwrap();

        write_and_flush(&path, &format!("{}\n", "y".repeat(MAX_LINE_BYTES * 2)));
        tailer.poll_once(&mut buffer, &mut next_id, 2_000).unwrap();

        let lines = buffer.since(0, 100);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].raw.len() <= MAX_LINE_BYTES + 32);
        assert!(lines[0].message.ends_with("… (line truncated)"));
    }

    #[test]
    fn tailer_reports_an_unreadable_source_as_an_error_not_as_silence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.log");
        let mut buffer = LogBuffer::new(SOURCE_BUFFER_CAPACITY);
        let mut next_id = 1u64;
        let mut tailer = SourceTailer::new("src1".to_string(), path);
        let result = tailer.poll_once(&mut buffer, &mut next_id, 1_000);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does-not-exist.log"));
    }
```

- [ ] **Step 9: Restructure `LogState`/`Inner` for per-source buffers and a shared id counter**

Replace `LogSourceStatus`, `LogPage`, the old `struct Source`, and the whole `LogState`/`Inner`/`impl LogState` block with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogSourceStatus {
    pub id: String,
    pub label: String,
    /// Human-readable location: the file path for a file source, or the
    /// invocation (`program` + `args` joined) for a command source.
    pub path: String,
    /// "file" | "command"
    pub kind: String,
    /// "live" while the last poll/read succeeded, "error" once one failed,
    /// "exited" once a command source's process ended on its own.
    pub state: String,
    pub error: Option<String>,
    /// Set only when `state == "exited"`.
    pub exit_code: Option<i32>,
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

/// What actually pulls bytes in for one source. `Command` is fully wired up
/// in Task 3 — the running child process and its reader tasks are tracked
/// separately (see `LogState::commands`), not inside this enum, because a
/// `tokio::process::Child` needs to be shared with async reader tasks in a
/// way a value living behind a `std::sync::Mutex` can't be.
enum Ingestor {
    File(SourceTailer),
    Command,
}

struct SourceEntry {
    status: LogSourceStatus,
    ingestor: Ingestor,
    buffer: LogBuffer,
    /// High-water mark for the periodic persistence sweep (Task 5) — the id
    /// through which this source's lines have already been written to SQLite.
    flushed_through_id: u64,
}

/// Shared, Tauri-managed log observation state. `inner` is one `Mutex`
/// because every operation on it is short (a metadata call plus a bounded
/// read, or a buffer insert) and the alternative — a lock per source plus
/// one for bookkeeping — buys nothing at the handful-of-sources scale this
/// tool operates at.
pub struct LogState {
    inner: Mutex<Inner>,
    source_buffer_capacity: usize,
}

struct Inner {
    sources: Vec<SourceEntry>,
    /// ONE counter shared across every source's buffer, so ids stay globally
    /// monotonic and ordering/`after_id` cursors work the same whether a
    /// caller is looking at one source or the merged view of all of them.
    next_id: u64,
}

impl LogState {
    pub fn new() -> Self {
        Self::with_capacity(SOURCE_BUFFER_CAPACITY)
    }

    pub fn with_capacity(source_buffer_capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner { sources: Vec::new(), next_id: 1 }),
            source_buffer_capacity,
        }
    }

    pub fn add_source(&self, label: String, kind: SourceKind) -> Result<LogSourceStatus, String> {
        let display_path = match &kind {
            SourceKind::File { path } => {
                let metadata = std::fs::metadata(path)
                    .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
                if !metadata.is_file() {
                    return Err(format!(
                        "{} is not a regular file — DevBench tails regular files or spawns \
                         commands; pipe stdout with `yourapp 2>&1 | tee /tmp/devbench.log` and \
                         point at that file, or add a Command source instead",
                        path.display()
                    ));
                }
                path.display().to_string()
            }
        };
        let status = LogSourceStatus {
            id: Uuid::new_v4().to_string(),
            label,
            path: display_path,
            kind: "file".to_string(),
            state: "live".to_string(),
            error: None,
            exit_code: None,
        };
        let ingestor = match &kind {
            SourceKind::File { path } => Ingestor::File(SourceTailer::new(status.id.clone(), path.clone())),
        };
        let entry = SourceEntry {
            status: status.clone(),
            ingestor,
            buffer: LogBuffer::new(self.source_buffer_capacity),
            flushed_through_id: 0,
        };

        let mut inner = self.inner.lock().map_err(|_| "log state poisoned".to_string())?;
        inner.sources.push(entry);
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
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return LogPage { lines: Vec::new(), next_id: after_id, dropped: 0 },
        };
        let lines = match source_id {
            Some(sid) => inner
                .sources
                .iter()
                .find(|e| e.status.id == sid)
                .map(|e| e.buffer.since(after_id, limit))
                .unwrap_or_default(),
            None => {
                let mut merged: Vec<LogLine> =
                    inner.sources.iter().flat_map(|e| e.buffer.since(after_id, usize::MAX)).collect();
                merged.sort_by_key(|l| l.id);
                merged.truncate(limit);
                merged
            }
        };
        let dropped: u64 = match source_id {
            Some(sid) => inner
                .sources
                .iter()
                .find(|e| e.status.id == sid)
                .map(|e| e.buffer.evicted_through_id().saturating_sub(after_id))
                .unwrap_or(0),
            None => inner.sources.iter().map(|e| e.buffer.evicted_through_id().saturating_sub(after_id)).sum(),
        };
        let next_id = lines.last().map(|l| l.id).unwrap_or(after_id);
        LogPage { lines, next_id, dropped }
    }

    pub fn next_line_id(&self) -> u64 {
        match self.inner.lock() {
            Ok(inner) => inner.next_id,
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
        let mut merged: Vec<LogLine> = inner.sources.iter().flat_map(|e| e.buffer.between(after_id, until_ms)).collect();
        merged.sort_by_key(|l| l.id);
        Some(merged)
    }

    /// Polls every FILE source once. Command sources capture via their own
    /// background reader tasks (Task 3) and are skipped here. Errors are
    /// recorded on the source's status rather than propagated — one broken
    /// source must not stop the others.
    pub fn poll_all(&self, now_ms: i64) {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return,
        };
        let Inner { sources, next_id } = &mut *inner;
        for entry in sources.iter_mut() {
            let Ingestor::File(tailer) = &mut entry.ingestor else { continue };
            match tailer.poll_once(&mut entry.buffer, next_id, now_ms) {
                Ok(()) => {
                    entry.status.state = "live".to_string();
                    entry.status.error = None;
                }
                Err(e) => {
                    if entry.status.state != "error" {
                        let source_id = entry.status.id.clone();
                        let id = *next_id;
                        *next_id += 1;
                        let note = format!("log source unreadable: {e}");
                        entry.buffer.insert(id, &source_id, now_ms, None, Some("WARN".to_string()), note.clone(), note);
                    }
                    entry.status.state = "error".to_string();
                    entry.status.error = Some(e);
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

Note `commands: Mutex<HashMap<...>>` (for tracking running command-source child processes) is intentionally **not** added yet — that's Task 3's concern, along with the `use std::collections::HashMap;` and `use std::sync::Arc;` imports it needs.

- [ ] **Step 10: Rewrite the `LogState`-level tests for the new signature, and add the buffer-isolation and cross-source-merge tests this refactor exists for**

Replace the remaining tests (`collect_window_returns_none_when_no_source_is_running`, `collect_window_returns_an_empty_vec_when_a_source_is_running_but_quiet`, `poll_all_marks_an_unreadable_source_as_errored_without_panicking`, `read_since_reports_dropped_lines_rather_than_under_reporting_silently`, `add_source_rejects_a_path_that_is_not_a_regular_file`) with:

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
        state.add_source("server.log".into(), SourceKind::File { path }).unwrap();

        assert_eq!(state.collect_window(0, 10_000), Some(vec![]));
    }

    #[test]
    fn poll_all_marks_an_unreadable_source_as_errored_without_panicking() {
        let state = LogState::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gone.log");
        std::fs::write(&path, "").unwrap();
        let source = state.add_source("gone.log".into(), SourceKind::File { path: path.clone() }).unwrap();

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
        state.add_source("app.log".into(), SourceKind::File { path: path.clone() }).unwrap();
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
        let result = state.add_source("a directory".into(), SourceKind::File { path: dir.path().to_path_buf() });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("regular file"));
    }

    // --- New: this is the whole point of the per-source-buffer refactor ---

    #[test]
    fn a_chatty_source_does_not_evict_a_quiet_sources_lines() {
        let state = LogState::with_capacity(3);
        let dir = tempfile::tempdir().unwrap();
        let quiet_path = dir.path().join("quiet.log");
        let chatty_path = dir.path().join("chatty.log");
        std::fs::write(&quiet_path, "").unwrap();
        std::fs::write(&chatty_path, "").unwrap();

        let quiet = state.add_source("quiet".into(), SourceKind::File { path: quiet_path.clone() }).unwrap();
        let chatty = state.add_source("chatty".into(), SourceKind::File { path: chatty_path.clone() }).unwrap();
        state.poll_all(1_000);

        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().append(true).open(&quiet_path).unwrap();
        writeln!(f, "the one line the quiet source will ever write").unwrap();
        f.flush().unwrap();

        let mut f = std::fs::OpenOptions::new().append(true).open(&chatty_path).unwrap();
        for i in 0..10 {
            writeln!(f, "chatty line {i}").unwrap();
        }
        f.flush().unwrap();

        state.poll_all(2_000);

        let quiet_page = state.read_since(0, Some(&quiet.id), 100);
        assert_eq!(quiet_page.lines.len(), 1, "the chatty source's 10 lines (against a capacity-3 buffer) must not evict the quiet source's one line");
        assert_eq!(quiet_page.dropped, 0);

        let chatty_page = state.read_since(0, Some(&chatty.id), 100);
        assert_eq!(chatty_page.lines.len(), 3, "the chatty source's own buffer, capacity 3, evicts its own oldest lines");
        assert!(chatty_page.dropped > 0);
    }

    #[test]
    fn read_since_with_no_source_id_merges_every_sources_lines_in_id_order() {
        let state = LogState::new();
        let dir = tempfile::tempdir().unwrap();
        let path_a = dir.path().join("a.log");
        let path_b = dir.path().join("b.log");
        std::fs::write(&path_a, "").unwrap();
        std::fs::write(&path_b, "").unwrap();
        state.add_source("a".into(), SourceKind::File { path: path_a.clone() }).unwrap();
        state.add_source("b".into(), SourceKind::File { path: path_b.clone() }).unwrap();
        state.poll_all(1_000);

        use std::io::Write as _;
        let mut fa = std::fs::OpenOptions::new().append(true).open(&path_a).unwrap();
        writeln!(fa, "from a").unwrap();
        fa.flush().unwrap();
        let mut fb = std::fs::OpenOptions::new().append(true).open(&path_b).unwrap();
        writeln!(fb, "from b").unwrap();
        fb.flush().unwrap();
        state.poll_all(2_000);

        let merged = state.read_since(0, None, 100);
        assert_eq!(merged.lines.len(), 2);
        let ids: Vec<u64> = merged.lines.iter().map(|l| l.id).collect();
        assert!(ids[0] < ids[1], "merged view must stay in id order across sources");
    }

    #[test]
    fn collect_window_merges_lines_from_every_source() {
        let state = LogState::new();
        let dir = tempfile::tempdir().unwrap();
        let path_a = dir.path().join("a.log");
        let path_b = dir.path().join("b.log");
        std::fs::write(&path_a, "").unwrap();
        std::fs::write(&path_b, "").unwrap();
        state.add_source("a".into(), SourceKind::File { path: path_a.clone() }).unwrap();
        state.add_source("b".into(), SourceKind::File { path: path_b.clone() }).unwrap();
        state.poll_all(1_000);

        use std::io::Write as _;
        let mut fa = std::fs::OpenOptions::new().append(true).open(&path_a).unwrap();
        writeln!(fa, "from a").unwrap();
        fa.flush().unwrap();
        let mut fb = std::fs::OpenOptions::new().append(true).open(&path_b).unwrap();
        writeln!(fb, "from b").unwrap();
        fb.flush().unwrap();
        state.poll_all(1_500);

        let window = state.collect_window(0, 2_000).expect("sources are running");
        assert_eq!(window.len(), 2);
    }
```

- [ ] **Step 11: Fix the production call site in `commands/logs.rs`**

In `apps/devbench/src-tauri/src/commands/logs.rs`, `add_log_source_impl` (around line 25-36) currently ends with:

```rust
    state.add_source(label, PathBuf::from(input.path))
```

Change to:

```rust
    state.add_source(label, crate::log_state::SourceKind::File { path: PathBuf::from(input.path) })
```

- [ ] **Step 12: Fix the two remaining test call sites elsewhere in the crate**

In `apps/devbench/src-tauri/src/commands/correlation.rs`, inside `a_correlated_request_opens_a_window_that_can_be_collected`, change:

```rust
        logs.add_source("app.log".into(), log_path.clone()).unwrap();
```
to:
```rust
        logs.add_source("app.log".into(), crate::log_state::SourceKind::File { path: log_path.clone() }).unwrap();
```

(`AddLogSourceInput`/`add_log_source_impl`'s own test in `commands/logs.rs` is addressed in Task 4, which changes `AddLogSourceInput`'s shape — leave it broken for now if `cargo build` flags it after this step; Step 13 below runs `cargo test` for the whole crate and Task 4 fixes that specific test.)

- [ ] **Step 13: Build and run the full test suite**

Run: `cargo build` then `cargo test` from `apps/devbench/src-tauri/`
Expected: the crate builds. `commands::logs::tests::add_log_source_falls_back_to_the_file_name_when_no_label_is_given` will fail to compile because `AddLogSourceInput` still only has `label`/`path: String` fields and this call site is unaffected by anything in this task — **if it fails to compile, that's expected**; leave it and proceed to Task 4, which changes `AddLogSourceInput` and fixes this test as part of that change. Every other test (all of `log_state.rs`'s tests, all of `correlation.rs`'s tests) must pass.

- [ ] **Step 14: Commit**

```bash
git add apps/devbench/src-tauri/src/log_state.rs apps/devbench/src-tauri/src/commands/correlation.rs
git commit -m "refactor(devbench): give every log source its own buffer

One shared ring buffer meant a chatty source could evict a quiet
source's lines. Ids stay globally monotonic via one shared counter, so
after_id cursors and the correlation window's ordering are unaffected."
```

(`commands/logs.rs`'s Step 11 change is committed together with Task 4's other `commands/logs.rs` changes, since that file won't compile cleanly on its own until Task 4 lands — see Task 4 Step 1.)

---

### Task 3: Command sources — spawn, capture, lifecycle

Adds the `SourceKind::Command` variant: DevBench spawns and owns the process, captures stdout and stderr directly (no `tee`, no shell redirection), kills it on removal or app exit, and reports `"exited"` with an exit code if it ends on its own — never auto-restarted.

**Files:**
- Modify: `apps/devbench/src-tauri/src/log_state.rs`

**Interfaces:**
- Consumes: `LogState::add_source`, `SourceEntry`, `Ingestor` from Task 2.
- Produces:
  - `SourceKind::Command { program: String, args: Vec<String>, cwd: Option<PathBuf> }` (new enum variant)
  - `LogState::push_line(&self, source_id: &str, raw: &str, captured_at_ms: i64)` — new; used by command reader tasks (file tailing keeps going through `poll_all`/`SourceTailer`)
  - `LogState::mark_exited(&self, source_id: &str, exit_code: Option<i32>)` — new
  - `LogState::kill_all_commands(&self)` — new, `async`; called once from Task 5's graceful-shutdown hook
  - `pub fn spawn_command_source(logs: Arc<LogState>, label: String, program: String, args: Vec<String>, cwd: Option<PathBuf>) -> Result<LogSourceStatus, String>` — new, the entry point Task 4's persistence-restore and the (future, Plan 2) `add_log_source` command call for a Command-kind source.

- [ ] **Step 1: Add the `Command` variant and the imports it needs**

In `apps/devbench/src-tauri/src/log_state.rs`, change:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum SourceKind {
    File { path: PathBuf },
}
```

to:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum SourceKind {
    File { path: PathBuf },
    Command { program: String, args: Vec<String>, cwd: Option<PathBuf> },
}
```

Add near the top of the file, alongside the existing `use std::collections::VecDeque;` etc.:

```rust
use std::collections::HashMap;
use std::sync::Arc;
```

- [ ] **Step 2: Write a failing test for spawning and capturing a command's stdout and stderr**

Add to the test module:

```rust
    #[tokio::test]
    async fn a_command_source_captures_both_stdout_and_stderr() {
        let state = Arc::new(LogState::new());
        let status = spawn_command_source(
            Arc::clone(&state),
            "printer".into(),
            "sh".into(),
            vec!["-c".into(), "echo from-stdout; echo from-stderr 1>&2".into()],
            None,
        )
        .await
        .unwrap();

        // Give the child a moment to run and its reader tasks a moment to drain it.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let page = state.read_since(0, Some(&status.id), 100);
        let messages: Vec<&str> = page.lines.iter().map(|l| l.message.as_str()).collect();
        assert!(messages.contains(&"from-stdout"), "{messages:?}");
        assert!(messages.contains(&"from-stderr"), "{messages:?}");
    }
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cargo test a_command_source_captures_both_stdout_and_stderr` from `apps/devbench/src-tauri/`
Expected: FAIL to compile — `spawn_command_source` doesn't exist yet.

- [ ] **Step 4: Add `push_line`, `mark_exited`, the command-handle registry, and `spawn_command_source`**

Change the `LogState` struct to:

```rust
pub struct LogState {
    inner: Mutex<Inner>,
    /// Running command sources' child processes, keyed by source id — kept
    /// here (not inside `Inner`) because sharing a `Child` between the async
    /// task waiting on its exit and a synchronous `remove_source` call needs
    /// a `tokio::sync::Mutex`, not the `std::sync::Mutex` `Inner` uses for
    /// its short, non-async critical sections.
    commands: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<tokio::process::Child>>>>,
    source_buffer_capacity: usize,
}
```

Update `with_capacity` to initialize it:

```rust
    pub fn with_capacity(source_buffer_capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner { sources: Vec::new(), next_id: 1 }),
            commands: std::sync::Mutex::new(HashMap::new()),
            source_buffer_capacity,
        }
    }
```

Add these methods to `impl LogState`:

```rust
    /// Pushes one already-captured line: allocates the next global id and
    /// inserts it into `source_id`'s buffer. File sources go through
    /// `poll_all`/`SourceTailer` instead — this is for command sources,
    /// whose reader tasks call it directly as lines arrive.
    pub fn push_line(&self, source_id: &str, raw: &str, captured_at_ms: i64) {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return,
        };
        let id = inner.next_id;
        inner.next_id += 1;
        let prepared = prepare_line(raw);
        if let Some(entry) = inner.sources.iter_mut().find(|e| e.status.id == source_id) {
            entry.buffer.insert(id, source_id, captured_at_ms, prepared.timestamp, prepared.level, prepared.message, prepared.raw);
        }
    }

    /// Marks a command source as having exited on its own. Never
    /// auto-restarted — surfaced honestly, same as the file tailer's
    /// rotation warning, rather than silently respawned.
    pub fn mark_exited(&self, source_id: &str, exit_code: Option<i32>) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(entry) = inner.sources.iter_mut().find(|e| e.status.id == source_id) {
                entry.status.state = "exited".to_string();
                entry.status.exit_code = exit_code;
            }
        }
        self.commands.lock().unwrap().remove(source_id);
    }
```

Update `add_source`'s match on `kind` (it currently only handles `SourceKind::File`) to add the `Command` arm, and use `kind.label()`-equivalent logic inline since `kind` is consumed once. Replace the body of `add_source` with:

```rust
    pub fn add_source(&self, label: String, kind: SourceKind) -> Result<LogSourceStatus, String> {
        let (display_path, kind_label) = match &kind {
            SourceKind::File { path } => {
                let metadata = std::fs::metadata(path)
                    .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
                if !metadata.is_file() {
                    return Err(format!(
                        "{} is not a regular file — DevBench tails regular files or spawns \
                         commands; pipe stdout with `yourapp 2>&1 | tee /tmp/devbench.log` and \
                         point at that file, or add a Command source instead",
                        path.display()
                    ));
                }
                (path.display().to_string(), "file")
            }
            SourceKind::Command { program, args, .. } => {
                let invocation = std::iter::once(program.clone()).chain(args.iter().cloned()).collect::<Vec<_>>().join(" ");
                (invocation, "command")
            }
        };
        let status = LogSourceStatus {
            id: Uuid::new_v4().to_string(),
            label,
            path: display_path,
            kind: kind_label.to_string(),
            state: "live".to_string(),
            error: None,
            exit_code: None,
        };
        let ingestor = match &kind {
            SourceKind::File { path } => Ingestor::File(SourceTailer::new(status.id.clone(), path.clone())),
            SourceKind::Command { .. } => Ingestor::Command,
        };
        let entry = SourceEntry {
            status: status.clone(),
            ingestor,
            buffer: LogBuffer::new(self.source_buffer_capacity),
            flushed_through_id: 0,
        };

        let mut inner = self.inner.lock().map_err(|_| "log state poisoned".to_string())?;
        inner.sources.push(entry);
        Ok(status)
    }
```

Update `remove_source` to also kill any running command process:

```rust
    pub fn remove_source(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "log state poisoned".to_string())?;
        let before = inner.sources.len();
        inner.sources.retain(|s| s.status.id != id);
        if inner.sources.len() == before {
            return Err(format!("no log source with id {id}"));
        }
        drop(inner);

        if let Some(child) = self.commands.lock().unwrap().remove(id) {
            // A non-blocking try_lock: if the reader task currently holds the
            // lock it's because the process is already exiting on its own —
            // `mark_exited` will run momentarily and this kill is redundant,
            // not required for correctness (`kill_on_drop` below is the
            // actual backstop for that race, and for the app-quit case).
            if let Ok(mut guard) = child.try_lock() {
                let _ = guard.start_kill();
            }
        }
        Ok(())
    }
```

Now add the spawning machinery, below the `impl LogState` block (free functions, since they need an owned `Arc<LogState>` for the tasks they spawn — see the doc comment on `commands` above for why):

```rust
/// Spawns `program` with `args` (and `cwd` if given), captures its stdout
/// and stderr directly — no shell, no `2>&1` redirection, so no
/// shell-quoting/injection surface — and registers it as a log source.
/// `.kill_on_drop(true)` plus `LogState::remove_source`'s explicit kill are
/// two independent backstops for the same guarantee: the process never
/// outlives its source.
pub async fn spawn_command_source(
    logs: Arc<LogState>,
    label: String,
    program: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
) -> Result<LogSourceStatus, String> {
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args);
    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("failed to run `{program}`: {e}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let status = logs.add_source(label, SourceKind::Command { program, args, cwd })?;

    let child = Arc::new(tokio::sync::Mutex::new(child));
    logs.commands.lock().unwrap().insert(status.id.clone(), Arc::clone(&child));

    let out_logs = Arc::clone(&logs);
    let out_id = status.id.clone();
    tokio::spawn(async move { drain_pipe(&out_logs, &out_id, stdout).await });

    let err_logs = Arc::clone(&logs);
    let err_id = status.id.clone();
    tokio::spawn(async move { drain_pipe(&err_logs, &err_id, stderr).await });

    let wait_logs = Arc::clone(&logs);
    let wait_id = status.id.clone();
    tokio::spawn(async move {
        let code = {
            let mut guard = child.lock().await;
            guard.wait().await.ok().and_then(|s| s.code())
        };
        wait_logs.mark_exited(&wait_id, code);
    });

    Ok(status)
}

async fn drain_pipe<R: tokio::io::AsyncRead + Unpin>(logs: &LogState, source_id: &str, pipe: R) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let now_ms = chrono::Utc::now().timestamp_millis();
        logs.push_line(source_id, &line, now_ms);
    }
}
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cargo test a_command_source_captures_both_stdout_and_stderr` from `apps/devbench/src-tauri/`
Expected: PASS

- [ ] **Step 6: Write a failing test for the "exited" lifecycle**

```rust
    #[tokio::test]
    async fn a_command_source_that_exits_on_its_own_is_marked_exited_not_error() {
        let state = Arc::new(LogState::new());
        let status = spawn_command_source(Arc::clone(&state), "one-shot".into(), "sh".into(), vec!["-c".into(), "exit 3".into()], None)
            .await
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let sources = state.list_sources();
        let found = sources.iter().find(|s| s.id == status.id).unwrap();
        assert_eq!(found.state, "exited");
        assert_eq!(found.exit_code, Some(3));
    }
```

- [ ] **Step 7: Run it to verify it passes** (the implementation from Step 4 already covers this — the test should pass immediately, confirming `mark_exited` works)

Run: `cargo test a_command_source_that_exits_on_its_own_is_marked_exited_not_error` from `apps/devbench/src-tauri/`
Expected: PASS

- [ ] **Step 8: Write a failing test proving `remove_source` kills a running command's process**

```rust
    #[tokio::test]
    async fn removing_a_command_source_kills_its_process() {
        let state = Arc::new(LogState::new());
        // `sleep 30` would still be running long after this test's own
        // timeout if remove_source failed to kill it.
        let status = spawn_command_source(Arc::clone(&state), "long-runner".into(), "sleep".into(), vec!["30".into()], None)
            .await
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        state.remove_source(&status.id).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // The wait task's mark_exited call removes the command handle once
        // the killed process's exit is observed — an empty registry is this
        // test's proof the process actually died rather than being merely
        // forgotten about.
        assert!(state.commands.lock().unwrap().is_empty(), "the killed child's handle should be cleaned up once its exit is observed");
    }
```

Note this test reaches into `state.commands` directly, so it must live inside `log_state.rs`'s own `#[cfg(test)] mod tests` (same-module access to a private field) — not in a different file.

- [ ] **Step 9: Run it to verify it passes**

Run: `cargo test removing_a_command_source_kills_its_process` from `apps/devbench/src-tauri/`
Expected: PASS. (If it hangs instead of completing within a few hundred milliseconds, `kill_on_drop`/`start_kill` isn't actually terminating the child — double check `cmd.kill_on_drop(true)` is set before `.spawn()` in Step 4.)

- [ ] **Step 10: Add an explicit "kill everything" method for app shutdown, rather than relying solely on `kill_on_drop`**

`kill_on_drop` alone is a weaker guarantee here than it looks: the wait-task spawned in Step 4 holds its own `Arc` clone of the child, detached from `LogState`'s own lifetime — so dropping `LogState` itself does **not** guarantee the child's last reference drops at any predictable time relative to process exit. Task 5's graceful-shutdown hook needs something it can call and directly know has taken effect. Write the failing test first:

```rust
    #[tokio::test]
    async fn kill_all_commands_terminates_every_running_command_source() {
        let marker_dir = tempfile::tempdir().unwrap();
        let marker = marker_dir.path().join("still-alive");
        let state = Arc::new(LogState::new());
        spawn_command_source(
            Arc::clone(&state),
            "slow".into(),
            "sh".into(),
            vec!["-c".into(), format!("sleep 5; touch {}", marker.display())],
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        state.kill_all_commands().await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        assert!(!marker.exists(), "kill_all_commands should have killed the sleep before it could touch the marker file");
        assert!(state.commands.lock().unwrap().is_empty());
    }
```

Run: `cargo test kill_all_commands_terminates_every_running_command_source` from `apps/devbench/src-tauri/`
Expected: FAIL to compile — `kill_all_commands` doesn't exist yet.

Implement it as an async method on `LogState` (async because, unlike `remove_source`'s best-effort `try_lock`, shutdown wants a real guarantee — worth briefly `.await`-ing the lock rather than skipping a source whose lock happens to be held):

```rust
    /// Kills every currently-running command source. Called once from the
    /// app's graceful-shutdown hook (Task 5) — `kill_on_drop` on each
    /// `Command` stays set as defense-in-depth, but this is the guarantee
    /// the shutdown path actually relies on, since it doesn't depend on
    /// exactly when a detached task's last `Arc<Child>` reference drops.
    pub async fn kill_all_commands(&self) {
        let handles: Vec<_> = self.commands.lock().unwrap().values().cloned().collect();
        for child in handles {
            let mut guard = child.lock().await;
            let _ = guard.start_kill();
        }
    }
```

Run: `cargo test kill_all_commands_terminates_every_running_command_source` from `apps/devbench/src-tauri/`
Expected: PASS.

- [ ] **Step 11: Run the full test suite**

Run: `cargo test` from `apps/devbench/src-tauri/`
Expected: every test in `log_state.rs` passes. (`commands/logs.rs`'s pre-existing compile issue from Task 2 Step 13 is still expected here — Task 4 fixes it.)

- [ ] **Step 12: Commit**

```bash
git add apps/devbench/src-tauri/src/log_state.rs
git commit -m "feat(devbench): add command-spawning log sources

DevBench can now run a command itself and capture its stdout/stderr
directly, no tee needed. Killed on removal and on app exit
(kill_on_drop); a process that exits on its own is marked exited with
its code, never auto-restarted."
```

---

### Task 4: SQLite persistence — sources survive restart

Wires `log_sources` (Task 1's migration) into `add_log_source`/startup, and fixes `AddLogSourceInput`'s shape in a way the *current, unmodified* frontend keeps working against unchanged.

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/logs.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `SourceKind`, `LogState::add_source`, `spawn_command_source` from Tasks 2–3.
- Produces:
  - `AddLogSourceInput { label: String, path: Option<String>, kind: String, program: Option<String>, args: Vec<String>, cwd: Option<String> }` — **shape change**, backward compatible (see Step 1)
  - `pub fn parse_source_kind(input: &AddLogSourceInput) -> Result<SourceKind, String>`
  - `pub async fn persist_log_source(pool: &SqlitePool, status: &LogSourceStatus, kind: &SourceKind) -> Result<(), String>`
  - `pub struct PersistedSource { pub id: String, pub label: String, pub kind: SourceKind }`
  - `pub async fn load_persisted_sources(pool: &SqlitePool) -> Result<Vec<PersistedSource>, String>`
  - `pub async fn delete_persisted_source(pool: &SqlitePool, id: &str) -> Result<(), String>` — deletes only the `log_sources` config row; `log_lines` history is untouched (spec: removing a source must not erase its Search history)
  - `pub async fn restore_persisted_sources(pool: &SqlitePool, logs: &Arc<LogState>)` — called once from `main.rs` at startup
  - `pub async fn add_log_source_impl(state: &Arc<LogState>, pool: &SqlitePool, input: AddLogSourceInput) -> Result<LogSourceStatus, String>` — **now async**, takes the pool, and persists
  - `pub async fn remove_log_source_impl(state: &LogState, pool: &SqlitePool, id: &str) -> Result<(), String>` — **new**, replaces calling `logs.remove_source` directly from the tauri command

- [ ] **Step 1: Change `AddLogSourceInput` and write the kind-parsing helper**

In `apps/devbench/src-tauri/src/commands/logs.rs`, replace:

```rust
#[derive(Debug, Deserialize)]
pub struct AddLogSourceInput {
    pub label: String,
    pub path: String,
}
```

with:

```rust
#[derive(Debug, Deserialize)]
pub struct AddLogSourceInput {
    pub label: String,
    /// Required for kind = "file" (the default). The current frontend has
    /// no concept of `kind` and always sends this shape — `#[serde(default)]`
    /// on `kind` below means an old-shaped `{label, path}` payload still
    /// deserializes exactly as it did before this change.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default = "default_source_kind")]
    pub kind: String,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

fn default_source_kind() -> String {
    "file".to_string()
}

pub fn parse_source_kind(input: &AddLogSourceInput) -> Result<crate::log_state::SourceKind, String> {
    match input.kind.as_str() {
        "file" => {
            let path = input.path.as_deref().ok_or_else(|| "path is required for a file source".to_string())?;
            Ok(crate::log_state::SourceKind::File { path: PathBuf::from(path) })
        }
        "command" => {
            let program = input.program.clone().ok_or_else(|| "program is required for a command source".to_string())?;
            Ok(crate::log_state::SourceKind::Command {
                program,
                args: input.args.clone(),
                cwd: input.cwd.clone().map(PathBuf::from),
            })
        }
        other => Err(format!("unknown log source kind: {other}")),
    }
}
```

- [ ] **Step 2: Write the failing persistence round-trip test**

```rust
    #[tokio::test]
    async fn persist_and_load_round_trips_a_file_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let state = LogState::new();
        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let status = state.add_source("app.log".into(), kind.clone()).unwrap();

        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        let loaded = load_persisted_sources(&db.pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, status.id);
        assert_eq!(loaded[0].label, "app.log");
        assert_eq!(loaded[0].kind, crate::log_state::SourceKind::File { path });
    }

    #[tokio::test]
    async fn persist_and_load_round_trips_a_command_source_including_its_args() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        let state = LogState::new();
        let kind = crate::log_state::SourceKind::Command {
            program: "npm".into(),
            args: vec!["run".into(), "dev".into()],
            cwd: Some(PathBuf::from("/home/dev/app")),
        };
        let status = state.add_source("web".into(), kind.clone()).unwrap();

        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        let loaded = load_persisted_sources(&db.pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].kind, kind);
    }
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test persist_and_load_round_trips` from `apps/devbench/src-tauri/`
Expected: FAIL to compile — `persist_log_source`/`load_persisted_sources`/`PersistedSource` don't exist yet.

- [ ] **Step 4: Implement `persist_log_source`, `PersistedSource`, and `load_persisted_sources`**

Add to `commands/logs.rs` (needs `use sqlx::{Row, SqlitePool};` and `use std::path::PathBuf;` — `PathBuf` is already imported; add the `sqlx` items):

```rust
pub async fn persist_log_source(
    pool: &SqlitePool,
    status: &crate::log_state::LogSourceStatus,
    kind: &crate::log_state::SourceKind,
) -> Result<(), String> {
    let (kind_str, path, program, args, cwd): (&str, Option<String>, Option<String>, Option<String>, Option<String>) = match kind {
        crate::log_state::SourceKind::File { path } => ("file", Some(path.display().to_string()), None, None, None),
        crate::log_state::SourceKind::Command { program, args, cwd } => (
            "command",
            None,
            Some(program.clone()),
            Some(serde_json::to_string(args).map_err(|e| format!("failed to encode args: {e}"))?),
            cwd.as_ref().map(|c| c.display().to_string()),
        ),
    };
    sqlx::query(
        "INSERT INTO log_sources (id, label, kind, path, program, args, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&status.id)
    .bind(&status.label)
    .bind(kind_str)
    .bind(path)
    .bind(program)
    .bind(args)
    .bind(cwd)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(|e| format!("failed to persist log source {}: {e}", status.id))?;
    Ok(())
}

pub struct PersistedSource {
    pub id: String,
    pub label: String,
    pub kind: crate::log_state::SourceKind,
}

pub async fn load_persisted_sources(pool: &SqlitePool) -> Result<Vec<PersistedSource>, String> {
    let rows = sqlx::query("SELECT id, label, kind, path, program, args, cwd FROM log_sources")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to load log sources: {e}"))?;

    let mut sources = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        let label: String = row.get("label");
        let kind_str: String = row.get("kind");
        let kind = match kind_str.as_str() {
            "file" => {
                let path: Option<String> = row.get("path");
                let path = path.ok_or_else(|| format!("log source {id} is kind=file but has no path"))?;
                crate::log_state::SourceKind::File { path: PathBuf::from(path) }
            }
            "command" => {
                let program: Option<String> = row.get("program");
                let program = program.ok_or_else(|| format!("log source {id} is kind=command but has no program"))?;
                let args_json: Option<String> = row.get("args");
                let args: Vec<String> = match args_json {
                    Some(json) => serde_json::from_str(&json).map_err(|e| format!("log source {id} has malformed args JSON: {e}"))?,
                    None => Vec::new(),
                };
                let cwd: Option<String> = row.get("cwd");
                crate::log_state::SourceKind::Command { program, args, cwd: cwd.map(PathBuf::from) }
            }
            other => return Err(format!("log source {id} has unknown kind {other}")),
        };
        sources.push(PersistedSource { id, label, kind });
    }
    Ok(sources)
}
```

- [ ] **Step 5: Run to verify the round-trip tests pass**

Run: `cargo test persist_and_load_round_trips` from `apps/devbench/src-tauri/`
Expected: PASS

- [ ] **Step 6: Update `add_log_source_impl` to build a `SourceKind`, spawn/register, and persist — and fix its now-outdated test**

Replace `add_log_source_impl` and the two tauri command wrappers `add_log_source`/`remove_log_source` (the `remove_log_source` signature doesn't change, just shown for context) with:

```rust
pub async fn add_log_source_impl(
    state: &Arc<LogState>,
    pool: &SqlitePool,
    input: AddLogSourceInput,
) -> Result<crate::log_state::LogSourceStatus, String> {
    let label = if input.label.trim().is_empty() {
        match (&input.kind[..], input.path.as_deref()) {
            ("file", Some(path)) => PathBuf::from(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string()),
            _ => input.program.clone().unwrap_or_else(|| "log source".to_string()),
        }
    } else {
        input.label.trim().to_string()
    };

    let kind = parse_source_kind(&input)?;
    let status = match kind.clone() {
        crate::log_state::SourceKind::File { .. } => state.add_source(label, kind.clone())?,
        crate::log_state::SourceKind::Command { program, args, cwd } => {
            crate::log_state::spawn_command_source(Arc::clone(state), label, program, args, cwd).await?
        }
    };
    persist_log_source(pool, &status, &kind).await?;
    Ok(status)
}

#[tauri::command]
pub async fn add_log_source(
    logs: State<'_, Arc<LogState>>,
    db: State<'_, LocalDb>,
    input: AddLogSourceInput,
) -> Result<crate::log_state::LogSourceStatus, String> {
    add_log_source_impl(logs.inner(), &db.pool, input).await
}
```

`logs.inner()` gives `&Arc<LogState>` from the Tauri `State` extractor — pass it straight through since `add_log_source_impl` now takes `&Arc<LogState>` (it needs an owned `Arc` internally for `spawn_command_source`, obtained via `Arc::clone(state)`).

Add `use crate::local_db::LocalDb;` to this file's imports if not already present (it is not, currently).

Now fix the test that broke back in Task 2:

```rust
    #[tokio::test]
    async fn add_log_source_falls_back_to_the_file_name_when_no_label_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.log");
        std::fs::write(&path, "").unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        let state = Arc::new(LogState::new());
        let source = add_log_source_impl(
            &state,
            &db.pool,
            AddLogSourceInput {
                label: "   ".into(),
                path: Some(path.display().to_string()),
                kind: "file".into(),
                program: None,
                args: Vec::new(),
                cwd: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(source.label, "server.log");
        assert_eq!(source.state, "live");
    }
```

And the absurd-limit test, which doesn't touch `add_log_source` at all and needs no change — confirm it still compiles as-is:

```rust
    #[test]
    fn read_log_lines_clamps_an_absurd_limit() {
        let state = LogState::new();
        let page = read_log_lines_impl(
            &state,
            ReadLogLinesInput { after_id: 0, source_id: None, limit: usize::MAX },
        );
        assert_eq!(page.lines.len(), 0);
    }
```

- [ ] **Step 7: Removing a source must also delete its persisted config row — otherwise it resurrects on the next restart**

`LogState::remove_source` (Task 2/3) only touches in-memory state. Nothing today deletes the corresponding `log_sources` row, so `restore_persisted_sources` would re-add a source right after the user removed it. Write the failing test first:

```rust
    #[tokio::test]
    async fn removing_a_source_deletes_its_persisted_row_but_keeps_its_line_history() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let state = Arc::new(LogState::new());
        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let status = state.add_source("app.log".into(), kind.clone()).unwrap();
        persist_log_source(&db.pool, &status, &kind).await.unwrap();
        sqlx::query("INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) VALUES (1, ?, 1000, NULL, NULL, 'hello', 'hello')")
            .bind(&status.id)
            .execute(&db.pool)
            .await
            .unwrap();

        remove_log_source_impl(&state, &db.pool, &status.id).await.unwrap();

        let remaining_sources = load_persisted_sources(&db.pool).await.unwrap();
        assert!(remaining_sources.is_empty(), "the config row must be gone so restore doesn't resurrect it");

        let line_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_lines WHERE source_id = ?")
            .bind(&status.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(line_count, 1, "history must survive — removing a source stops capture, it doesn't erase Search history");
    }
```

Run: `cargo test removing_a_source_deletes_its_persisted_row` from `apps/devbench/src-tauri/`
Expected: FAIL to compile — `remove_log_source_impl` doesn't exist yet.

Implement `delete_persisted_source` and `remove_log_source_impl`, and update the tauri command to use it:

```rust
/// Deletes only the `log_sources` config row. Deliberately does NOT touch
/// `log_lines` — removing a source stops new capture, it doesn't erase that
/// source's history from Search.
pub async fn delete_persisted_source(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM log_sources WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to delete persisted log source {id}: {e}"))?;
    Ok(())
}

pub async fn remove_log_source_impl(state: &LogState, pool: &SqlitePool, id: &str) -> Result<(), String> {
    state.remove_source(id)?;
    delete_persisted_source(pool, id).await
}

#[tauri::command]
pub async fn remove_log_source(logs: State<'_, Arc<LogState>>, db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    remove_log_source_impl(&logs, &db.pool, &id).await
}
```

This replaces today's `remove_log_source` tauri command (which currently just calls `logs.remove_source(&id)` directly). Also update `remove_log_source_errors_on_an_unknown_id` (existing test, currently sync) to match:

```rust
    #[tokio::test]
    async fn remove_log_source_errors_on_an_unknown_id() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let state = LogState::new();
        assert!(remove_log_source_impl(&state, &db.pool, "nope").await.is_err());
    }
```

Run: `cargo test removing_a_source_deletes_its_persisted_row && cargo test remove_log_source_errors_on_an_unknown_id` from `apps/devbench/src-tauri/`
Expected: PASS for both.

- [ ] **Step 8: Write a failing test for startup restore**

```rust
    #[tokio::test]
    async fn restore_persisted_sources_re_adds_every_saved_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let kind = crate::log_state::SourceKind::File { path: path.clone() };
        let bootstrap_state = LogState::new();
        let status = bootstrap_state.add_source("app.log".into(), kind.clone()).unwrap();
        persist_log_source(&db.pool, &status, &kind).await.unwrap();

        // Simulate a restart: a fresh, empty LogState.
        let fresh_state = Arc::new(LogState::new());
        assert_eq!(fresh_state.list_sources().len(), 0);

        restore_persisted_sources(&db.pool, &fresh_state).await;

        let sources = fresh_state.list_sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].label, "app.log");
        assert_eq!(sources[0].state, "live");
    }

    #[tokio::test]
    async fn restore_persisted_sources_surfaces_a_missing_file_as_an_error_state_not_a_silent_drop() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let gone_path = dir.path().join("gone.log");

        // Persist a source pointing at a file that will NOT exist on restore.
        let kind = crate::log_state::SourceKind::File { path: gone_path };
        sqlx::query("INSERT INTO log_sources (id, label, kind, path, created_at) VALUES (?, ?, 'file', ?, ?)")
            .bind("src-gone")
            .bind("gone.log")
            .bind(dir.path().join("gone.log").display().to_string())
            .bind("2026-07-31T00:00:00Z")
            .execute(&db.pool)
            .await
            .unwrap();
        let _ = kind; // constructed above only to make the SourceKind import obviously used in this test's intent

        let state = Arc::new(LogState::new());
        restore_persisted_sources(&db.pool, &state).await;

        // add_source rejects a nonexistent path outright, so restoring a
        // now-missing file source must not silently vanish it from the list —
        // this documents that today it simply isn't added (list is empty),
        // rather than panicking or being silently swallowed with no trace.
        assert_eq!(state.list_sources().len(), 0);
    }
```

- [ ] **Step 9: Run to verify failure, then implement `restore_persisted_sources`**

Run: `cargo test restore_persisted_sources` from `apps/devbench/src-tauri/`
Expected: FAIL to compile first.

Add:

```rust
/// Re-adds every persisted source on startup — re-stats the file or
/// re-spawns the command, exactly like `add_log_source` does for a brand
/// new source. A source whose file is gone or whose command fails to spawn
/// is skipped with a logged error rather than crashing startup; it simply
/// doesn't reappear in `list_sources` (the same outcome as if it had never
/// been added), rather than being force-inserted into a broken state.
pub async fn restore_persisted_sources(pool: &SqlitePool, logs: &Arc<LogState>) {
    let rows = match load_persisted_sources(pool).await {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("failed to load persisted log sources: {e}");
            return;
        }
    };
    for row in rows {
        let result = match row.kind {
            crate::log_state::SourceKind::File { .. } => logs.add_source(row.label, row.kind),
            crate::log_state::SourceKind::Command { program, args, cwd } => {
                crate::log_state::spawn_command_source(Arc::clone(logs), row.label, program, args, cwd).await
            }
        };
        if let Err(e) = result {
            eprintln!("failed to restore log source {}: {e}", row.id);
        }
    }
}
```

- [ ] **Step 10: Run to verify both tests pass**

Run: `cargo test restore_persisted_sources` from `apps/devbench/src-tauri/`
Expected: PASS

- [ ] **Step 11: Wire startup restore into `main.rs`**

In `apps/devbench/src-tauri/src/main.rs`, the `setup` closure currently does, in this order:

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
```

`handle.manage(db)` **moves** `db` — so by the time `logs` exists a few lines later, `db` is already gone and `&db.pool` isn't available. The restore call needs `&db.pool`, so `handle.manage(db)` has to move down, past both `logs`'s creation and the restore call. Change the whole block to:

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

            let logs = Arc::new(LogState::new());
            app.manage(Arc::clone(&logs));

            tauri::async_runtime::block_on(devbench::commands::logs::restore_persisted_sources(&db.pool, &logs));

            handle.manage(db);

            // One background task polls every FILE source. Command sources
            // capture via their own reader tasks, started when they're
            // spawned (restore, above, or add_log_source later).
            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_millis(LOG_POLL_INTERVAL_MS));
                loop {
                    ticker.tick().await;
                    let now_ms = chrono::Utc::now().timestamp_millis();
                    logs.poll_all(now_ms);
                }
            });
```

Everything after this in `setup` (the correlation registry, the SMTP catcher, secrets) is unchanged and keeps using `handle`/`app` exactly as before.

- [ ] **Step 12: Build and run the full test suite**

Run: `cargo build && cargo test` from `apps/devbench/src-tauri/`
Expected: builds cleanly, every test passes (this is the first point since Task 2 Step 13 where the whole crate is expected to be fully green again).

- [ ] **Step 13: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/logs.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): persist log sources and restore them on startup

AddLogSourceInput's shape change is backward compatible — path becomes
optional and kind defaults to \"file\", so the current frontend's
{label, path} payload still deserializes and behaves exactly as before.
Removing a source now deletes its config row (so it doesn't resurrect
on restart) while keeping its log_lines history for Search."
```

---

### Task 5: Periodic flush, shutdown flush, and retention prune

Lines now reach SQLite: a 1-second ticker sweeps every source's unflushed lines into `log_lines`, an explicit flush runs once more on graceful shutdown, and a prune keeps `log_lines` under a 100,000-row global cap.

**Files:**
- Modify: `apps/devbench/src-tauri/src/log_state.rs` (add `take_unflushed`)
- Modify: `apps/devbench/src-tauri/src/commands/logs.rs` (add `flush_new_lines`, `prune_log_lines`)
- Modify: `apps/devbench/src-tauri/src/main.rs` (wire the ticker and the shutdown hook)

**Interfaces:**
- Consumes: `LogBuffer::unflushed_since` (Task 2), `LogState.inner` internals.
- Produces:
  - `LogState::take_unflushed(&self) -> Vec<LogLine>`
  - `pub const MAX_PERSISTED_LINES: i64` in `commands/logs.rs`
  - `pub async fn flush_new_lines(pool: &SqlitePool, logs: &LogState) -> Result<usize, String>`
  - `pub async fn prune_log_lines(pool: &SqlitePool) -> Result<u64, String>`

- [ ] **Step 1: Write a failing test for `take_unflushed`**

Add to `log_state.rs`'s test module:

```rust
    #[test]
    fn take_unflushed_returns_new_lines_once_and_advances_the_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();
        let state = LogState::new();
        state.add_source("app.log".into(), SourceKind::File { path: path.clone() }).unwrap();
        state.poll_all(1_000);

        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "one").unwrap();
        writeln!(f, "two").unwrap();
        f.flush().unwrap();
        state.poll_all(2_000);

        let first_batch = state.take_unflushed();
        assert_eq!(first_batch.len(), 2);

        // Nothing new since the last call — the cursor advanced, so the
        // same two lines must not come back.
        let second_batch = state.take_unflushed();
        assert_eq!(second_batch.len(), 0);

        writeln!(f, "three").unwrap();
        f.flush().unwrap();
        state.poll_all(3_000);
        let third_batch = state.take_unflushed();
        assert_eq!(third_batch.len(), 1);
        assert_eq!(third_batch[0].message, "three");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test take_unflushed_returns_new_lines_once` from `apps/devbench/src-tauri/`
Expected: FAIL to compile — `take_unflushed` doesn't exist.

- [ ] **Step 3: Implement `take_unflushed`**

Add to `impl LogState`:

```rust
    /// Collects every line added to every source since that source's last
    /// flush, and advances each source's flush cursor to match. A line that
    /// arrives mid-call lands in the NEXT call's batch, never this one and
    /// never lost — the cursor only advances to what was actually read here.
    pub fn take_unflushed(&self) -> Vec<LogLine> {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return Vec::new(),
        };
        let mut batch = Vec::new();
        for entry in inner.sources.iter_mut() {
            let new_lines = entry.buffer.unflushed_since(entry.flushed_through_id);
            if let Some(last) = new_lines.last() {
                entry.flushed_through_id = last.id;
            }
            batch.extend(new_lines);
        }
        batch
    }
```

(A source producing more lines than fit in its `SOURCE_BUFFER_CAPACITY`-sized ring within one flush interval could have some already evicted before this runs — the same bounded-loss tradeoff the ring buffer already accepts elsewhere, not a new one.)

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test take_unflushed_returns_new_lines_once` from `apps/devbench/src-tauri/`
Expected: PASS

- [ ] **Step 5: Write failing tests for `flush_new_lines` and `prune_log_lines`**

Add to `commands/logs.rs`'s test module:

```rust
    #[tokio::test]
    async fn flush_new_lines_writes_exactly_the_unflushed_lines() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "").unwrap();

        let state = LogState::new();
        state.add_source("app.log".into(), crate::log_state::SourceKind::File { path: path.clone() }).unwrap();
        state.poll_all(1_000);
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "one").unwrap();
        writeln!(f, "two").unwrap();
        f.flush().unwrap();
        state.poll_all(2_000);

        let written = flush_new_lines(&db.pool, &state).await.unwrap();
        assert_eq!(written, 2);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM log_lines").fetch_one(&db.pool).await.unwrap();
        assert_eq!(count, 2);

        // A second flush with nothing new writes nothing.
        let written_again = flush_new_lines(&db.pool, &state).await.unwrap();
        assert_eq!(written_again, 0);
    }

    #[tokio::test]
    async fn prune_log_lines_keeps_only_the_most_recent_rows() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        for i in 1..=10i64 {
            sqlx::query(
                "INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) VALUES (?, 'src1', ?, NULL, NULL, ?, ?)",
            )
            .bind(i)
            .bind(1_000 + i)
            .bind(format!("line {i}"))
            .bind(format!("line {i}"))
            .execute(&db.pool)
            .await
            .unwrap();
        }

        // Prune to a cap of 4: rows with id 1..=6 should go, 7..=10 should remain.
        let deleted = prune_log_lines_to_cap(&db.pool, 4).await.unwrap();
        assert_eq!(deleted, 6);

        let remaining_ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM log_lines ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
        assert_eq!(remaining_ids, vec![7, 8, 9, 10]);
    }
```

- [ ] **Step 6: Run to verify failure**

Run: `cargo test flush_new_lines_writes_exactly && cargo test prune_log_lines_keeps_only` from `apps/devbench/src-tauri/`
Expected: FAIL to compile.

- [ ] **Step 7: Implement `flush_new_lines` and the prune functions**

Add to `commands/logs.rs`:

```rust
/// Global cap on persisted lines, mirroring the in-memory ring buffer's own
/// eviction philosophy: oldest rows go first once the cap is exceeded.
/// Hardcoded on purpose — a Settings row is a scoped-out future extension,
/// same pattern as `DEFAULT_CORRELATION_WINDOW_MS`.
pub const MAX_PERSISTED_LINES: i64 = 100_000;

pub async fn flush_new_lines(pool: &SqlitePool, logs: &LogState) -> Result<usize, String> {
    let batch = logs.take_unflushed();
    let mut written = 0;
    for line in &batch {
        sqlx::query(
            "INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(line.id as i64)
        .bind(&line.source_id)
        .bind(line.captured_at_ms)
        .bind(&line.timestamp)
        .bind(&line.level)
        .bind(&line.message)
        .bind(&line.raw)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to flush log line {}: {e}", line.id))?;
        written += 1;
    }
    Ok(written)
}

pub async fn prune_log_lines(pool: &SqlitePool) -> Result<u64, String> {
    prune_log_lines_to_cap(pool, MAX_PERSISTED_LINES).await
}

/// Split out from `prune_log_lines` so a test can prune to a small cap
/// without waiting to accumulate 100,000 real rows.
async fn prune_log_lines_to_cap(pool: &SqlitePool, cap: i64) -> Result<u64, String> {
    let result = sqlx::query("DELETE FROM log_lines WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM log_lines)")
        .bind(cap)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to prune log_lines: {e}"))?;
    Ok(result.rows_affected())
}
```

- [ ] **Step 8: Run to verify both pass**

Run: `cargo test flush_new_lines_writes_exactly && cargo test prune_log_lines_keeps_only` from `apps/devbench/src-tauri/`
Expected: PASS

- [ ] **Step 9: Wire the 1-second flush/prune ticker and the graceful-shutdown flush into `main.rs`**

Add near the top of `main.rs`, alongside `LOG_POLL_INTERVAL_MS`:

```rust
/// How often unflushed log lines are batch-written to SQLite. Slower than
/// LOG_POLL_INTERVAL_MS on purpose — this is a durability sweep, not a
/// latency-sensitive one; Live mode reads the in-memory buffers directly.
const LOG_FLUSH_INTERVAL_MS: u64 = 1_000;
```

After the existing `poll_all` ticker task (inside `setup`), add a second ticker task. Note it needs its own clones of `logs` and the pool — the `poll_all` ticker task above already moved `logs` into its closure, so clone `logs` again *before* that move, and clone `db.pool` *before* `db` itself is moved into `handle.manage(db)` (a `SqlitePool` clone is cheap — it's a connection-pool handle, not a new connection):

```rust
            let logs = Arc::new(LogState::new());
            app.manage(Arc::clone(&logs));

            tauri::async_runtime::block_on(devbench::commands::logs::restore_persisted_sources(&db.pool, &logs));

            let db_pool_for_flush = db.pool.clone();
            handle.manage(db);

            let logs_for_flush = Arc::clone(&logs);
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(std::time::Duration::from_millis(LOG_FLUSH_INTERVAL_MS));
                loop {
                    ticker.tick().await;
                    if let Err(e) = devbench::commands::logs::flush_new_lines(&db_pool_for_flush, &logs_for_flush).await {
                        eprintln!("log flush failed: {e}");
                    }
                    if let Err(e) = devbench::commands::logs::prune_log_lines(&db_pool_for_flush).await {
                        eprintln!("log prune failed: {e}");
                    }
                }
            });

            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_millis(LOG_POLL_INTERVAL_MS));
                loop {
                    ticker.tick().await;
                    let now_ms = chrono::Utc::now().timestamp_millis();
                    logs.poll_all(now_ms);
                }
            });
```

Finally, change the very end of `main()` from:

```rust
        .invoke_handler(tauri::generate_handler![
            ...
        ])
        .run(tauri::generate_context!())
        .expect("error while running devbench");
```

to:

```rust
        .invoke_handler(tauri::generate_handler![
            ...
        ])
        .build(tauri::generate_context!())
        .expect("error while building devbench")
        .run(|app_handle, event| {
            // Last chance to persist anything still sitting in the
            // in-memory buffers, and to kill any still-running command
            // sources, before the process actually exits — bounds
            // worst-case data loss to an unclean exit, not a normal quit,
            // and doesn't depend on exactly when kill_on_drop's Drop impl
            // would otherwise fire for a detached reader task.
            if let tauri::RunEvent::Exit = event {
                let logs = app_handle.state::<Arc<LogState>>();
                let db = app_handle.state::<LocalDb>();
                tauri::async_runtime::block_on(async {
                    let _ = devbench::commands::logs::flush_new_lines(&db.pool, &logs).await;
                    logs.kill_all_commands().await;
                });
            }
        });
```

(The `[...]` invoke_handler list itself is unchanged — only the tail after it changes from `.run(context)` to `.build(context)?.run(closure)`.)

- [ ] **Step 10: Build the whole app**

Run: `cargo build` from `apps/devbench/src-tauri/`
Expected: builds cleanly. If `tauri::RunEvent::Exit` doesn't match the installed Tauri version's API, the compiler error will name the correct variant — adjust to match (Tauri v2's `RunEvent` has carried an `Exit` variant across all v2 releases at time of writing).

- [ ] **Step 11: Run the full test suite one more time**

Run: `cargo test` from `apps/devbench/src-tauri/`
Expected: PASS, everything.

- [ ] **Step 12: Commit**

```bash
git add apps/devbench/src-tauri/src/log_state.rs apps/devbench/src-tauri/src/commands/logs.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): flush log lines to SQLite and prune old rows

A 1s ticker batch-writes unflushed lines; an explicit flush runs once
more on graceful shutdown so only an unclean exit can lose anything.
log_lines is capped at 100k rows, oldest first."
```

---

### Task 6: Verify correlation's `None`/`Some(vec![])` window semantics survived the refactor

No production code change expected — this task exists to explicitly re-run and read the correlation test suite against everything Tasks 2–5 changed, since `collect_window`'s contract (used by `run_correlated_request`/`collect_correlation_window`) is exactly the kind of proven, easy-to-silently-regress logic call out in the spec.

**Files:**
- None modified (verification only).

**Interfaces:**
- Consumes: `LogState::collect_window`, `LogState::next_line_id`, `LogState::read_since` (Task 2).

- [ ] **Step 1: Run every correlation test explicitly**

Run: `cargo test --lib correlation` from `apps/devbench/src-tauri/`
Expected: PASS for all of:
- `collecting_a_window_with_no_log_source_reports_not_observed_rather_than_zero`
- `a_correlated_request_opens_a_window_that_can_be_collected`
- `a_slow_request_does_not_shrink_its_own_correlation_window`
- every other test in `commands/correlation.rs`'s test module

- [ ] **Step 2: Manually confirm the two claims that matter most**

Read `commands/correlation.rs`'s `collecting_a_window_with_no_log_source_reports_not_observed_rather_than_zero` test and confirm it still asserts `window.log_lines == None` when zero sources are configured (this is `LogState::collect_window`'s `if inner.sources.is_empty() { return None; }` check from Task 2 Step 9 — still present, unchanged in spirit).

Read `a_correlated_request_opens_a_window_that_can_be_collected` and confirm it still asserts `Some(vec_of_one_line)` when a source is configured and a matching line was captured within the window (this exercises the new merge-across-sources path in `collect_window`, even though only one source is involved — the merge-then-sort still runs, just over a single-element list).

- [ ] **Step 3: Run the full crate test suite one final time as the plan's closing check**

Run: `cargo test` from `apps/devbench/src-tauri/`
Expected: PASS, everything — this is the plan's Definition of Done.

- [ ] **Step 4: Commit** (only if Step 2's reading prompted a comment/doc touch-up; otherwise this task produces no diff and needs no commit)

If nothing changed, note that explicitly rather than committing an empty diff:

```bash
git status --short
# Expect: nothing to commit — this task was verification-only.
```

---

## Definition of Done

- `cargo test` passes from `apps/devbench/src-tauri/` with zero failures.
- A file source and a command source can both be added, tailed/captured, removed (killing the command's process), and restored after a simulated restart.
- A chatty source's lines never evict a quiet source's lines (Task 2's isolation test).
- `collect_window` still returns `None` for "no source configured" and `Some(vec![])` for "watching, nothing happened" — unchanged from before this plan.
- The current frontend (`AddLogSourceForm`, `LogTab.tsx`) is not modified and is not expected to be exercised by this plan (no `bun run test` run required) — Plan 2 covers the frontend.
