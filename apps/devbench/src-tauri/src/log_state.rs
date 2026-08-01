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

use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use uuid::Uuid;

/// How many parsed lines are kept in memory PER SOURCE. Old lines are
/// evicted from that source's own buffer only — a chatty source can no
/// longer push a quiet source's lines out. SQLite (Task 4) is the durable,
/// unbounded-by-comparison tier; this is just the hot live-tail cache.
pub const SOURCE_BUFFER_CAPACITY: usize = 1_000;

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

/// What a source captures from. `Command` is added in Task 3.
#[derive(Debug, Clone, PartialEq)]
pub enum SourceKind {
    File { path: PathBuf },
    Command { program: String, args: Vec<String>, cwd: Option<PathBuf> },
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

            // Lossy conversion: a log file can contain a partial multi-byte
            // sequence at a chunk boundary or genuinely invalid bytes. Dropping
            // the whole chunk would be silent data loss; a replacement
            // character is the honest rendering.
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
                        let prepared = prepare_line(line);
                        let id = *next_id;
                        *next_id += 1;
                        buffer.insert(id, &self.source_id, now_ms, prepared.timestamp, prepared.level, prepared.message, prepared.raw);
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
    /// Running command sources' child processes, keyed by source id — kept
    /// here (not inside `Inner`) because sharing a `Child` between the async
    /// task waiting on its exit and a synchronous `remove_source` call needs
    /// a `tokio::sync::Mutex`, not the `std::sync::Mutex` `Inner` uses for
    /// its short, non-async critical sections.
    commands: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<tokio::process::Child>>>>,
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
            commands: std::sync::Mutex::new(HashMap::new()),
            source_buffer_capacity,
        }
    }

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
}

impl Default for LogState {
    fn default() -> Self {
        Self::new()
    }
}

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
        // try_wait() in a poll loop, not `wait().await` while holding the
        // guard: `wait()` would hold the lock for the process's entire
        // remaining lifetime, starving `remove_source`'s try_lock and
        // `kill_all_commands`'s lock().await of any chance to ever acquire
        // it and actually kill a still-running process.
        let code = loop {
            let mut guard = child.lock().await;
            match guard.try_wait() {
                Ok(Some(exit_status)) => break exit_status.code(),
                Ok(None) => {
                    drop(guard);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(_) => break None,
            }
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

        // Capacity well above the 2,000 lines below: this test is about the
        // tailer's per-poll byte budget, not buffer eviction (SOURCE_BUFFER_CAPACITY
        // is too small here and would cap both polls at the same count).
        let mut buffer = LogBuffer::new(3_000);
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
        // B (added second, so later in `sources`) gets the lower id here and A
        // (added first) gets the higher one — the opposite of vector order. A
        // naive per-source concatenation without `read_since`'s sort by id
        // would then yield A's higher-id line before B's lower-id one, so this
        // only passes if the sort actually runs.
        let mut fb = std::fs::OpenOptions::new().append(true).open(&path_b).unwrap();
        writeln!(fb, "from b").unwrap();
        fb.flush().unwrap();
        state.poll_all(2_000);

        let mut fa = std::fs::OpenOptions::new().append(true).open(&path_a).unwrap();
        writeln!(fa, "from a").unwrap();
        fa.flush().unwrap();
        state.poll_all(3_000);

        let merged = state.read_since(0, None, 100);
        assert_eq!(merged.lines.len(), 2);
        let ids: Vec<u64> = merged.lines.iter().map(|l| l.id).collect();
        assert!(ids[0] < ids[1], "merged view must stay in id order across sources");
    }

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
}
