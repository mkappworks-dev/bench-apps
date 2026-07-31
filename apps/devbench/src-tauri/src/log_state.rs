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

        self.insert(source_id, captured_at_ms, parsed.timestamp, parsed.level, parsed.message, raw.to_string())
    }

    /// Inserts a synthetic operational note (e.g. a rotation warning) whose
    /// level is asserted directly rather than guessed from content: it is
    /// DevBench's own annotation, not a line read from the target, so running
    /// it through `parse_log_line` would leave it with no level at all.
    fn push_note(&mut self, source_id: &str, level: &str, message: &str, captured_at_ms: i64) -> u64 {
        self.insert(source_id, captured_at_ms, None, Some(level.to_string()), message.to_string(), message.to_string())
    }

    fn insert(
        &mut self,
        source_id: &str,
        captured_at_ms: i64,
        timestamp: Option<String>,
        level: Option<String>,
        message: String,
        raw: String,
    ) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.lines.push_back(LogLine {
            id,
            source_id: source_id.to_string(),
            captured_at_ms,
            timestamp,
            level,
            message,
            raw,
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
    // Set once a single physical line has already exceeded MAX_LINE_BYTES and
    // been flushed as a truncated line. While set, further bytes belonging to
    // that same still-unterminated line are discarded rather than re-emitted
    // as a second, unrelated line once its real newline eventually arrives.
    skipping_overlong_line: bool,
}

impl SourceTailer {
    pub fn new(source_id: String, path: PathBuf) -> Self {
        Self {
            source_id,
            path,
            offset: 0,
            pending: String::new(),
            started: false,
            skipping_overlong_line: false,
        }
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
            buffer.push_note(
                &self.source_id,
                "WARN",
                "log source rotated or truncated — resuming from the start of the file",
                now_ms,
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

            // Lossy conversion: a log file can contain a partial multi-byte
            // sequence at a chunk boundary or genuinely invalid bytes. Dropping
            // the whole chunk would be a silent data loss, which principle 4
            // forbids; a replacement character is the honest rendering.
            self.pending.push_str(&String::from_utf8_lossy(&chunk[..read]));

            loop {
                if self.skipping_overlong_line {
                    // Already emitted one truncated line for this physical
                    // line; discard the rest of it until its real newline.
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
                        buffer.push(&self.source_id, line, now_ms);
                    }
                } else {
                    break;
                }
            }

            // A single line longer than the cap will otherwise grow `pending`
            // without bound while we wait for a newline that may never come.
            // Flush it once as a truncated line, then discard the remainder
            // of this same physical line instead of re-buffering it piecemeal.
            if !self.skipping_overlong_line && self.pending.len() > MAX_LINE_BYTES {
                let flushed = std::mem::take(&mut self.pending);
                buffer.push(&self.source_id, &flushed, now_ms);
                self.skipping_overlong_line = true;
            }
        }

        Ok(())
    }
}

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
                        buffer.push_note(&source.status.id, "WARN", &format!("log source unreadable: {e}"), now_ms);
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
}
