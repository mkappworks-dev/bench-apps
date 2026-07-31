# DevBench log capture — redesign

Log capture already exists and works: regular-file tailing over 250ms offset
polling, JSON-ish line parsing, one shared 5000-line in-memory ring buffer, a
non-persisted source list, and a client-side substring filter. This spec is
about what it becomes, not a rebuild — three problems, weighed together
because they interact:

1. **Nothing survives a restart.** Sources vanish; the buffer is wiped.
2. **One shared buffer across all sources.** A chatty source can evict a quiet
   source's lines, and the v2-chrome work (duplicable, always-mounted tool
   tabs) means N Log tabs can now be open on N different sources at once —
   the shared buffer was never sized for that.
3. **Capture is file-only.** A process not already writing to a file needs a
   `tee` workaround; there's no way to watch a spawned command's own output or
   a Docker container's logs.

Reference mockup: `docs/mockups/devbench-log-capture.html` (interactive —
forked from `docs/mockups/devbench-v2-shell.html`'s chrome/tokens/popup
primitive; switch between the two pre-loaded Log tabs, try each source, open
the Add Source popup for File/Command/Docker, toggle level chips, switch
Live/Search).

## Non-goals

- Auto-restarting a command source that exits on its own (crashed or
  one-shot) — it's reported, not resurrected.
- Attaching to an already-running **bare** process's stdout after the fact.
  There's no portable way to do that; it's exactly the gap `tee` works around
  today, and command sources solve it going forward by having DevBench spawn
  the process itself. Docker is different only in that `docker logs -f` is
  the thing being spawned, and Docker already lets that attach to a running
  container.
- Full-text/regex search syntax. Search mode's query is substring, matching
  today's filter semantics — just against SQLite instead of the rendered
  array.
- Per-source retention limits, reordering/renaming sources.
- Sandboxing spawned commands. Running an arbitrary user-supplied command is
  the feature, not a vulnerability to close — the same trust boundary as
  today's "read any file this OS user can read." DevBench already runs as
  that user.

## Architecture

### Data model

Two new SQLite tables (migration `0004_log_capture.sql`):

```sql
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

CREATE TABLE log_lines (
  id             INTEGER PRIMARY KEY,   -- same id space the in-memory buffer uses
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

`log_sources` rows are the persisted *config* only — no `state` column.
Runtime status (`live`/`error`/`exited`, an error message, an exit code) is
never written to SQLite; it's recomputed fresh every time a source is added,
including the re-add DevBench does for every row on startup (re-stat the
file, or re-spawn the command). A source that's gone (file deleted, command
not found) shows up already in the error state rather than silently
vanishing, but that state itself is never stale-loaded from disk.

`log_lines` rows are **not** cascade-deleted when their `log_sources` row is
removed. Removing a source stops new capture; it doesn't erase the source's
history from Search, which is the point of persisting lines at all — you may
well remove a source right after the debugging session that made you want to
search it. Only the retention prune (below) removes old rows, regardless of
whether their source still exists.

### Ingestion: `SourceKind`

```rust
enum SourceKind {
    File { path: PathBuf },
    Command { program: String, args: Vec<String>, cwd: Option<PathBuf> },
}
```

- **File** sources keep exactly today's `SourceTailer`: 250ms offset-based
  polling, EOF-seek on first poll, rotation/truncation warning. Unchanged.
- **Command** sources spawn via `tokio::process::Command` with
  `Stdio::piped()` on both stdout and stderr, `.kill_on_drop(true)`. Two async
  reader loops (one per pipe) push lines into the *same* per-source buffer,
  tagged with the same `source_id` — no shell-based `2>&1` redirection, so no
  shell-quoting/injection surface. This is genuinely event-driven (a pipe
  read resolves when there's data), not polled — the 250ms tick only concerns
  file sources.
- A **Docker** source is not a third kind — it's a form preset in the
  frontend that fills in `Command { program: "docker", args: ["logs", "-f",
  "<container>"] }`. Nothing in the backend knows "docker" exists.
- **Lifecycle**: a command's child is killed when its source is removed, and
  killed when DevBench quits (`kill_on_drop`). On restart, DevBench re-spawns
  fresh — it never tries to reattach to an old process. If the child exits on
  its own, the source status becomes `"exited"` (new state, distinct from
  `"error"`, carries the exit code) and is **not** auto-restarted — the same
  "surface it honestly, don't paper over it" instinct as the existing
  rotation warning.

### Buffering: per-source, not global

```rust
struct Inner {
    sources: HashMap<String, SourceEntry>,   // id -> { status, ingestor, buffer: LogBuffer }
    next_id: u64,                            // still ONE global id counter, shared across sources
}
```

Each source gets its own `LogBuffer` (same `VecDeque` type as today, smaller
cap — proposing **1,000** lines/source as the "hot" live-tail cache, since
SQLite is now the durable tier). The `id` counter stays global and monotonic
across all sources so ordering and `after_id` cursors keep working exactly as
they do today. A chatty command source filling its own ring no longer touches
a quiet file source's lines — this is what directly fixes the shared-buffer
gap, and it's what makes N simultaneously-mounted Log tabs safe: each tab just
tracks its own `after_id` cursor against whichever source it's viewing.

`read_since(after_id, source_id: Option, limit)`: `Some(id)` reads one
source's ring; `None` ("all sources") merges across every source's ring by
`id` (cheap — each ring is already id-sorted, and source count stays in the
"handful" range this state was sized for).

`collect_window` (correlation): unchanged in spirit — `None` if
`sources.is_empty()`, else `Some(merged between() across all rings)`. **Still
reads only the in-memory rings, never SQLite** — correlation windows are
seconds-long, so the hot tier is always sufficient, and this keeps the tested
`None` vs `Some(vec![])` code path essentially untouched, just merged across N
per-source rings instead of read from one.

### Persistence: periodic flush

The existing `poll_all` tick (or a slightly slower dedicated ticker, e.g. 1s)
also sweeps every source's ring for lines added since the last flush and
bulk-inserts them into `log_lines`. No new task/channel type — this reuses
the same `tokio::time::interval` shape the codebase already leans on. A hard
crash between flushes loses at most that window's worth of the newest lines,
which is an acceptable trade for a local dev tool's "don't lose everything on
restart" goal — this isn't an audit log.

(Considered and rejected: synchronous write-through, which ties the poll tick
and a command source's stdout reader to disk I/O on every line — a burst from
a command source, e.g. hundreds of lines during a `npm run dev` rebuild,
would stall ingestion on disk I/O one line at a time instead of one batched
insert; and an async batched writer behind an mpsc channel, which adds a task
type and a shutdown-coordination edge case — what happens to lines still in
the channel when the app quits — for a durability guarantee this tool
doesn't need.)

DevBench also runs one **explicit final flush on graceful shutdown** (in
`main.rs`, before exit), so a normal quit never loses anything — only an
actual crash or `kill -9` can lose the last partial interval. This is nearly
free (it's the same sweep, called once more) and it means the periodic
interval only has to bound worst-case loss on an unclean exit, not on the
common case of the user just closing the app.

**Retention**: a periodic prune keeps `log_lines` under a global cap
(proposing **100,000** rows, hardcoded constant — matching this codebase's
existing pattern of "hardcoded now, a Settings row is a scoped-out future
extension," same as `DEFAULT_CORRELATION_WINDOW_MS`). Oldest rows deleted
first, mirroring the ring buffer's own eviction philosophy.

### Commands surface

Changes to `commands/logs.rs`:

- `add_log_source` — input gains `kind` plus command fields; persists to
  `log_sources` in addition to registering the live source.
- `search_log_lines { query, level, source_id, after_ms, before_ms, limit }`
  — new command, queries SQLite directly. Deliberately a different code path
  from `read_log_lines` (which stays in-memory-only, unchanged) — live tail
  and history search have different latency/semantics and shouldn't be
  conflated into one query.
- `list_log_sources` — unchanged shape; `state` gains `"exited"` as a
  possible value alongside `"live"`/`"error"`, and the exit code rides along
  for exited sources.

## Frontend

Validated in the reference mockup (`docs/mockups/devbench-log-capture.html`)
and confirmed against the real shell chrome, not just described in the
abstract:

- **Add Source** is a popup (File / Command / Docker), reusing the same glass
  `Menu` primitive the v2-chrome work already builds for the tab-strip's `+`
  menu — no second one-off dropdown. Picking a kind reveals a form scoped to
  just that kind's fields (path; or program + args; or container name),
  rather than one form with a permanently-visible kind switcher. This was
  chosen over two alternatives explored as wireframes first: a segmented
  switch with one row that reflows per kind, and a segmented switch with the
  label field pinned above a kind-specific row. Both keep a switcher
  permanently in the resting state for no benefit once the popup can do the
  same disambiguation with one extra click and reuses an existing component.
- **Live / Search** is a segmented toggle in the toolbar, per Log tab
  instance (part of that tab's own state, alongside its `sourceId`). Live
  mode is today's UX unchanged — polling, client-side substring filter — plus
  **level-filter chips** (INFO/WARN/ERROR, client-side toggle — level is
  already parsed onto every rendered line, so this needs no backend change).
  Search mode calls `search_log_lines` with text + level + source + time
  range and renders a **separate, static (non-live) result list** — not
  `LogStream` reused, since a virtualized auto-scrolling live tail and a
  scrollable historical result list are different interaction models wearing
  the same font. Search's level filter is a **minimum-severity threshold**
  ("WARN+" meaning WARN and ERROR), not Live mode's exact multi-select
  chips — searching history is closer to "show me trouble at or above this
  severity" than "show me exactly these levels," and the two controls should
  look different (a select, not chips) so they don't read as the same
  control with two skins.
- **Source list** shows a kind glyph, a live/error/exited status dot, and —
  for the selected source only, when it isn't live — inline detail (the
  error message, or "exited (code N) — not auto-restarted").
- Nothing here changes how many Log tabs can be mounted or how their polling
  works — that's the v2-chrome shell's concern. This spec's job is making the
  backend safe for however many exist, which the per-source buffers in
  Architecture above handle; the mockup's two pre-loaded Log tab instances
  (one Live on a file source, one already in Search mode on a command source)
  exist specifically to make that independence visible rather than asserted.

## Testing

**Rust**: per-source buffer isolation (a chatty source doesn't evict a quiet
source's lines), command-source stdout+stderr merge-by-arrival, kill-on-drop,
`"exited"` state on natural exit, the flush sweep writes exactly the new
lines since the last flush (as one `flush_now()`-style function called by
both the periodic ticker and the shutdown hook, so testing it once covers
both call sites), retention prune keeps the row cap, `read_since`'s
merge-across-sources ordering, and `collect_window`'s `None`/`Some(vec![])`
behavior re-verified against the merged-per-source implementation (this is
the one piece of existing, carefully-tested logic this spec touches — it
must not regress).

**Frontend (vitest + RTL)**: kind-conditional Add Source form fields, the
Live/Search toggle switching components (not just visibility), level chips
filtering rendered lines, search results rendering distinctly from live tail,
error/exited detail rendering only for the selected source.

Window-decoration-style concerns don't apply here (no windowing/config
changes), so no manual-verification carve-out is needed beyond the usual
`bun run test`.

## Suggested split into plans

1. **Architecture** — the `log_sources`/`log_lines` migration, `SourceKind`
   and command-source spawning/lifecycle, per-source buffers, the periodic
   flush and retention sweep, and re-verifying correlation's
   `None`/`Some(vec![])` behavior against the new per-source merge. Backend
   only; ships the fixes that matter most (persistence, buffer isolation)
   without touching the UI.
2. **Search and the redesigned Add Source form** — `search_log_lines`, the
   Add Source popup and its three scoped forms (including the Docker preset),
   the Live/Search toggle, level chips, and the search results view. Depends
   on plan 1's `add_log_source` accepting `kind`.

Plan 1 is the one that actually fixes the gaps called out in the motivation
(restart survival, buffer contention under N tabs); plan 2 is the surface
that makes command/Docker sources and history search reachable from the UI.
Shipping plan 1 alone is a coherent, valuable stopping point if needed.
