# DevBench log search and the redesigned Add Source form (Plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make command/Docker sources and persisted log history reachable from the UI — a `search_log_lines` backend command over SQLite, an Add Source popup with three kind-scoped forms, and a per-tab Live/Search toggle with level filtering.

**Architecture:** Add one new Tauri command (`search_log_lines`) that queries the `log_lines` table directly, deliberately separate from `read_log_lines`'s in-memory live tail. On the frontend, replace the single-shape `AddLogSourceForm` with a `Menu`-driven kind picker plus three scoped forms (File / Command / Docker, where Docker is a preset that fills a Command), and split the Log tab's body into a Live view (today's `LogStream` plus level chips) and a new static `SearchResults` view, with the mode stored in the tab instance's own persisted state.

**Tech Stack:** Rust, Tauri v2, `sqlx` (SQLite); React 18, TypeScript, zustand, Tailwind, `@base-ui-components/react` (via the existing `Menu` primitive), vitest + React Testing Library.

## Global Constraints

- **This plan depends on Plan 1 (`2026-07-31-devbench-log-capture-architecture.md`) being merged.** Plan 1 delivered the `log_sources`/`log_lines` tables, `SourceKind::{File,Command}`, command spawning, persistence, and the flush/prune sweep. Do not re-implement any of it.
- **Base your work on a tree that contains BOTH Plan 1's backend AND the v2-chrome shell** (`Menu`, `Tab` instances, `useTabController`, `ToolPane`). These arrived by different routes: the v2-chrome shell is on `main`; Plan 1's backend is on branch `worktree-devbench-log-capture`, which must be merged into `main` before this plan starts. Verify both before Task 1 — if `apps/devbench/src/components/ui/Menu.tsx` is absent, you lack v2-chrome; if `apps/devbench/src-tauri/migrations/0006_log_capture.sql` is absent, you lack Plan 1. **STOP and report** if either is missing rather than working around it.
- Plan 1's merge renumbered its migration to `0006_log_capture.sql` specifically because `main` already carries `0004_tabs.sql` and `0005_captured_emails.sql`. If you find a `0004_log_capture.sql` in your tree, the merge was done wrong — STOP and report.
- Comments stay sparse — only for non-obvious rationale (a hidden constraint, a subtle invariant), never restating what the code already says.
- Every new/changed piece of behavior gets a test; TDD (failing test → minimal implementation → passing test) throughout.
- Search is **substring only**, matching today's Live filter semantics — no full-text or regex syntax. (Spec: Non-goals.)
- Search's level filter is a **minimum-severity threshold** (`WARN` means WARN and ERROR), rendered as a select. Live's level filter is an **exact multi-select** rendered as chips. These are deliberately different controls and must not be unified.
- Search results render in a **separate, static, non-virtualized component** — do not reuse `LogStream`, whose auto-scroll-to-bottom behavior is wrong for historical results.
- Backend: follow the existing patterns in `apps/devbench/src-tauri/src/commands/logs.rs` — a `pub async fn *_impl(pool: &SqlitePool, ...) -> Result<T, String>` that is unit-testable without a running Tauri app, plus a thin `#[tauri::command]` wrapper that just calls it. Tests use `crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap()` against a `tempfile::tempdir()`.
- Frontend: components live in `apps/devbench/src/components/log/`. Tests are colocated as `<Component>.test.tsx`, use `@testing-library/react` (`render`, `screen`, `fireEvent`) and `vitest` (`describe`, `it`, `expect`, `vi`).
- Run Rust tests with `cargo test` from `apps/devbench/src-tauri/`. Run frontend tests with `bun run test` from `apps/devbench/`.
- Use only the semantic Tailwind classes already in use in this directory: `bg-bg`, `bg-surface`, `bg-surface-2`, `border-border`, `text-text`, `text-text-muted`, `text-text-faint`, `bg-accent`, `text-accent-on`, `text-danger`, `bg-danger-bg`, `text-warning`, `bg-warning-bg`, `bg-success`. Do not introduce new color tokens.

---

## File Structure

| File | Change |
|---|---|
| `apps/devbench/src-tauri/src/commands/logs.rs` | Add `SearchLogLinesInput`, `search_log_lines_impl`, the `search_log_lines` command, and their tests. |
| `apps/devbench/src-tauri/src/main.rs` | Register `search_log_lines` in `invoke_handler`. |
| `apps/devbench/src/lib/tauri.ts` | Extend `LogSourceStatus` with `kind`/`exit_code`; add `AddLogSourceInput`, `SearchLogLinesArgs`; change `invokeAddLogSource`'s signature; add `invokeSearchLogLines`. |
| `apps/devbench/src/components/log/AddLogSourcePopup.tsx` | New. `Menu` kind picker + the three scoped forms. |
| `apps/devbench/src/components/log/AddLogSourcePopup.test.tsx` | New. |
| `apps/devbench/src/components/log/AddLogSourceForm.tsx` | Deleted (replaced by the popup). |
| `apps/devbench/src/components/log/AddLogSourceForm.test.tsx` | Deleted. |
| `apps/devbench/src/components/log/LevelChips.tsx` | New. Live mode's exact multi-select level filter. |
| `apps/devbench/src/components/log/LevelChips.test.tsx` | New. |
| `apps/devbench/src/components/log/SearchResults.tsx` | New. Static historical result list. |
| `apps/devbench/src/components/log/SearchResults.test.tsx` | New. |
| `apps/devbench/src/components/log/SearchBar.tsx` | New. Query + min-level + time-range inputs for Search mode. |
| `apps/devbench/src/components/log/SearchBar.test.tsx` | New. |
| `apps/devbench/src/components/log/LogStream.tsx` | Modify: accept an optional `levels` filter alongside `filter`. |
| `apps/devbench/src/components/log/LogStream.test.tsx` | Modify: add level-filter cases. |
| `apps/devbench/src/components/log/LogSourcesSidebar.tsx` | Modify: kind glyph, three-state status dot, inline detail for the selected non-live source. |
| `apps/devbench/src/components/log/LogSourcesSidebar.test.tsx` | Modify: add the new cases. |
| `apps/devbench/src/components/log/LogTab.tsx` | Modify: Live/Search mode from tab state, wire the new components. |
| `apps/devbench/src/components/log/LogTab.test.tsx` | New. |

No other files change. No new dependencies.

---

### Task 1: `search_log_lines` — query persisted history from SQLite

The one backend change in this plan. `read_log_lines` stays exactly as it is (in-memory live tail); this is a deliberately separate code path against the `log_lines` table Plan 1 fills.

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/logs.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: the `log_lines` table (Plan 1's migration `0006_log_capture.sql`), `crate::log_state::LogLine`, `crate::local_db::LocalDb`.
- Produces:
  - `pub struct SearchLogLinesInput { pub query: Option<String>, pub level: Option<String>, pub source_id: Option<String>, pub after_ms: Option<i64>, pub before_ms: Option<i64>, pub limit: usize }`
  - `pub async fn search_log_lines_impl(pool: &SqlitePool, input: SearchLogLinesInput) -> Result<Vec<LogLine>, String>`
  - `#[tauri::command] pub async fn search_log_lines(db: State<'_, LocalDb>, input: SearchLogLinesInput) -> Result<Vec<LogLine>, String>`
  - `const MAX_SEARCH_LIMIT: usize = 1_000;`
  - `fn levels_at_or_above(level: &str) -> Vec<&'static str>`

- [ ] **Step 1: Write the failing tests**

Append these inside the existing `#[cfg(test)] mod tests { ... }` block in `apps/devbench/src-tauri/src/commands/logs.rs`:

```rust
    async fn seed_line(
        pool: &sqlx::SqlitePool,
        id: i64,
        source_id: &str,
        captured_at_ms: i64,
        level: Option<&str>,
        message: &str,
    ) {
        sqlx::query(
            "INSERT INTO log_lines (id, source_id, captured_at_ms, timestamp, level, message, raw) \
             VALUES (?, ?, ?, NULL, ?, ?, ?)",
        )
        .bind(id)
        .bind(source_id)
        .bind(captured_at_ms)
        .bind(level)
        .bind(message)
        .bind(message)
        .execute(pool)
        .await
        .unwrap();
    }

    fn search_input() -> SearchLogLinesInput {
        SearchLogLinesInput {
            query: None,
            level: None,
            source_id: None,
            after_ms: None,
            before_ms: None,
            limit: 100,
        }
    }

    #[tokio::test]
    async fn search_matches_a_substring_of_the_message_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        seed_line(&db.pool, 1, "src1", 1_000, Some("INFO"), "Connection refused").await;
        seed_line(&db.pool, 2, "src1", 1_001, Some("INFO"), "all good").await;

        let found = search_log_lines_impl(
            &db.pool,
            SearchLogLinesInput { query: Some("connection".into()), ..search_input() },
        )
        .await
        .unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message, "Connection refused");
    }

    #[tokio::test]
    async fn search_treats_level_as_a_minimum_severity_threshold_not_an_exact_match() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        seed_line(&db.pool, 1, "src1", 1_000, Some("DEBUG"), "debug line").await;
        seed_line(&db.pool, 2, "src1", 1_001, Some("INFO"), "info line").await;
        seed_line(&db.pool, 3, "src1", 1_002, Some("WARN"), "warn line").await;
        seed_line(&db.pool, 4, "src1", 1_003, Some("ERROR"), "error line").await;
        seed_line(&db.pool, 5, "src1", 1_004, Some("FATAL"), "fatal line").await;

        let found = search_log_lines_impl(
            &db.pool,
            SearchLogLinesInput { level: Some("WARN".into()), ..search_input() },
        )
        .await
        .unwrap();

        let messages: Vec<&str> = found.iter().map(|l| l.message.as_str()).collect();
        assert_eq!(messages, vec!["warn line", "error line", "fatal line"]);
    }

    #[tokio::test]
    async fn search_filters_by_source_and_time_range() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        seed_line(&db.pool, 1, "src1", 1_000, None, "too early").await;
        seed_line(&db.pool, 2, "src1", 2_000, None, "in range").await;
        seed_line(&db.pool, 3, "src1", 3_000, None, "too late").await;
        seed_line(&db.pool, 4, "src2", 2_000, None, "other source").await;

        let found = search_log_lines_impl(
            &db.pool,
            SearchLogLinesInput {
                source_id: Some("src1".into()),
                after_ms: Some(1_500),
                before_ms: Some(2_500),
                ..search_input()
            },
        )
        .await
        .unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message, "in range");
    }

    #[tokio::test]
    async fn search_returns_the_newest_rows_first_and_clamps_an_absurd_limit() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        for i in 1..=5i64 {
            seed_line(&db.pool, i, "src1", 1_000 + i, None, &format!("line {i}")).await;
        }

        let found = search_log_lines_impl(
            &db.pool,
            SearchLogLinesInput { limit: usize::MAX, ..search_input() },
        )
        .await
        .unwrap();

        assert_eq!(found.len(), 5, "an absurd limit must clamp, not overflow or error");
        assert_eq!(found[0].message, "line 5", "newest first");
        assert_eq!(found[4].message, "line 1");
    }

    #[tokio::test]
    async fn search_with_no_filters_returns_everything_up_to_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        for i in 1..=3i64 {
            seed_line(&db.pool, i, "src1", 1_000 + i, None, &format!("line {i}")).await;
        }

        let found = search_log_lines_impl(&db.pool, search_input()).await.unwrap();
        assert_eq!(found.len(), 3);
    }

    #[tokio::test]
    async fn search_finds_history_from_a_source_that_no_longer_exists() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::local_db::LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        // No matching log_sources row is ever inserted: removing a source stops
        // capture but must not erase its history from Search.
        seed_line(&db.pool, 1, "removed-src", 1_000, Some("ERROR"), "last words").await;

        let found = search_log_lines_impl(
            &db.pool,
            SearchLogLinesInput { source_id: Some("removed-src".into()), ..search_input() },
        )
        .await
        .unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message, "last words");
    }

    #[test]
    fn levels_at_or_above_returns_the_threshold_and_everything_more_severe() {
        assert_eq!(levels_at_or_above("ERROR"), vec!["ERROR", "FATAL"]);
        assert_eq!(levels_at_or_above("WARN"), vec!["WARN", "ERROR", "FATAL"]);
        assert_eq!(
            levels_at_or_above("DEBUG"),
            vec!["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]
        );
        assert!(
            levels_at_or_above("NOPE").is_empty(),
            "an unknown level must not silently widen the filter to everything"
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test search_` from `apps/devbench/src-tauri/`
Expected: FAIL to compile — `SearchLogLinesInput`, `search_log_lines_impl`, and `levels_at_or_above` do not exist yet.

- [ ] **Step 3: Implement the level ladder**

Add to `apps/devbench/src-tauri/src/commands/logs.rs`, near the top alongside `MAX_READ_LIMIT`:

```rust
/// Upper bound on how many rows one `search_log_lines` call returns.
const MAX_SEARCH_LIMIT: usize = 1_000;

/// Severity order, least to most severe. Search's level filter is a minimum
/// threshold ("WARN" means WARN and worse), unlike Live mode's exact
/// multi-select — searching history is a "show me trouble at or above this"
/// question.
const LEVEL_LADDER: [&str; 5] = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

/// The given level and everything more severe. An unrecognized level yields an
/// empty set rather than the whole ladder, so a typo can never silently turn a
/// narrow filter into "match everything".
fn levels_at_or_above(level: &str) -> Vec<&'static str> {
    match LEVEL_LADDER.iter().position(|l| l.eq_ignore_ascii_case(level)) {
        Some(index) => LEVEL_LADDER[index..].to_vec(),
        None => Vec::new(),
    }
}
```

- [ ] **Step 4: Implement the input struct and the query**

Add to the same file, after `ReadLogLinesInput`:

```rust
#[derive(Debug, Deserialize)]
pub struct SearchLogLinesInput {
    /// Substring match against `message`, case-insensitive. `None` or empty
    /// means no text constraint.
    pub query: Option<String>,
    /// Minimum severity — see `levels_at_or_above`.
    pub level: Option<String>,
    pub source_id: Option<String>,
    pub after_ms: Option<i64>,
    pub before_ms: Option<i64>,
    pub limit: usize,
}

/// Queries persisted history. Deliberately separate from `read_log_lines`,
/// which reads the in-memory rings only — a live tail and a historical search
/// have different latency and freshness semantics and shouldn't share a path.
pub async fn search_log_lines_impl(
    pool: &SqlitePool,
    input: SearchLogLinesInput,
) -> Result<Vec<crate::log_state::LogLine>, String> {
    let mut sql = String::from(
        "SELECT id, source_id, captured_at_ms, timestamp, level, message, raw FROM log_lines WHERE 1 = 1",
    );

    let query = input.query.as_deref().map(str::trim).filter(|q| !q.is_empty());
    if query.is_some() {
        sql.push_str(" AND lower(message) LIKE ?");
    }
    let levels = match input.level.as_deref() {
        Some(level) => levels_at_or_above(level),
        None => Vec::new(),
    };
    if !levels.is_empty() {
        sql.push_str(" AND level IN (");
        sql.push_str(&vec!["?"; levels.len()].join(", "));
        sql.push(')');
    }
    if input.source_id.is_some() {
        sql.push_str(" AND source_id = ?");
    }
    if input.after_ms.is_some() {
        sql.push_str(" AND captured_at_ms >= ?");
    }
    if input.before_ms.is_some() {
        sql.push_str(" AND captured_at_ms <= ?");
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");

    let mut q = sqlx::query(&sql);
    if let Some(needle) = query {
        // `escape` is not used: LIKE wildcards a user types are a reasonable
        // convenience here, and there is no injection surface — the value is
        // always bound, never interpolated.
        q = q.bind(format!("%{}%", needle.to_lowercase()));
    }
    for level in &levels {
        q = q.bind(*level);
    }
    if let Some(source_id) = &input.source_id {
        q = q.bind(source_id);
    }
    if let Some(after_ms) = input.after_ms {
        q = q.bind(after_ms);
    }
    if let Some(before_ms) = input.before_ms {
        q = q.bind(before_ms);
    }
    q = q.bind(input.limit.clamp(1, MAX_SEARCH_LIMIT) as i64);

    let rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to search log lines: {e}"))?;

    let mut lines = Vec::with_capacity(rows.len());
    for row in rows {
        let id: i64 = row.get("id");
        lines.push(crate::log_state::LogLine {
            id: id as u64,
            source_id: row.get("source_id"),
            captured_at_ms: row.get("captured_at_ms"),
            timestamp: row.get("timestamp"),
            level: row.get("level"),
            message: row.get("message"),
            raw: row.get("raw"),
        });
    }
    Ok(lines)
}
```

Note: a `level` that is `Some` but unrecognized produces an empty `levels` vec, which appends no clause — so it matches everything. That is intentional and matches `levels_at_or_above`'s test: the ladder function refuses to widen, and the only caller that can produce a bad level is a hand-written IPC payload, not the UI (whose select is fixed to ladder values).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test search_ && cargo test levels_at_or_above` from `apps/devbench/src-tauri/`
Expected: PASS — 7 tests.

- [ ] **Step 6: Add the Tauri command wrapper**

Add to `apps/devbench/src-tauri/src/commands/logs.rs`, alongside the other `#[tauri::command]` wrappers:

```rust
#[tauri::command]
pub async fn search_log_lines(
    db: State<'_, LocalDb>,
    input: SearchLogLinesInput,
) -> Result<Vec<crate::log_state::LogLine>, String> {
    search_log_lines_impl(&db.pool, input).await
}
```

- [ ] **Step 7: Register the command**

In `apps/devbench/src-tauri/src/main.rs`, in the `invoke_handler![...]` list, add a line after `commands::logs::read_log_lines,`:

```rust
            commands::logs::search_log_lines,
```

- [ ] **Step 8: Build and run the full Rust suite**

Run: `cargo build && cargo test` from `apps/devbench/src-tauri/`
Expected: builds with zero warnings; every test passes.

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/logs.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): add search_log_lines over persisted history

Substring match on message, minimum-severity level threshold, optional
source and time-range bounds. Deliberately a separate path from
read_log_lines, which stays in-memory-only."
```

---

### Task 2: TypeScript bindings for the new and changed backend surface

Brings `lib/tauri.ts` in line with the Rust types Plan 1 already changed (`LogSourceStatus` gained `kind` and `exit_code`) and adds the `search_log_lines` binding plus the kind-aware add input. No component changes yet — this task is the typed seam every later task builds on.

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Modify: `apps/devbench/src/components/log/LogTab.tsx` (one call site, to keep the build green)

**Interfaces:**
- Consumes: Task 1's `search_log_lines` command; Plan 1's `add_log_source` payload shape (`{ label, path?, kind, program?, args, cwd? }`).
- Produces:
  - `LogSourceStatus` gains `kind: string` and `exit_code: number | null`
  - `export interface AddLogSourceInput { label: string; kind: "file" | "command"; path?: string; program?: string; args?: string[]; cwd?: string }`
  - `export interface SearchLogLinesArgs { query?: string; level?: string; sourceId?: string; afterMs?: number; beforeMs?: number; limit: number }`
  - `export function invokeAddLogSource(input: AddLogSourceInput): Promise<LogSourceStatus>` — **signature change** from `(label: string, path: string)`
  - `export function invokeSearchLogLines(args: SearchLogLinesArgs): Promise<LogLine[]>`

- [ ] **Step 1: Extend `LogSourceStatus`**

In `apps/devbench/src/lib/tauri.ts`, replace:

```ts
export interface LogSourceStatus {
  id: string;
  label: string;
  path: string;
  state: string;
  error: string | null;
}
```

with:

```ts
export interface LogSourceStatus {
  id: string;
  label: string;
  /** File path for a file source, or the invocation (`program` + args) for a command source. */
  path: string;
  /** "file" | "command" */
  kind: string;
  /** "live" | "error" | "exited" */
  state: string;
  error: string | null;
  /** Set only when `state === "exited"`. */
  exit_code: number | null;
}
```

- [ ] **Step 2: Replace `invokeAddLogSource` and add `invokeSearchLogLines`**

In the same file, replace:

```ts
export function invokeAddLogSource(label: string, path: string): Promise<LogSourceStatus> {
  return invoke("add_log_source", { input: { label, path } });
}
```

with:

```ts
export interface AddLogSourceInput {
  label: string;
  kind: "file" | "command";
  /** kind === "file" */
  path?: string;
  /** kind === "command" */
  program?: string;
  args?: string[];
  cwd?: string;
}

export function invokeAddLogSource(input: AddLogSourceInput): Promise<LogSourceStatus> {
  return invoke("add_log_source", {
    input: {
      label: input.label,
      kind: input.kind,
      path: input.path ?? null,
      program: input.program ?? null,
      args: input.args ?? [],
      cwd: input.cwd ?? null,
    },
  });
}

export interface SearchLogLinesArgs {
  query?: string;
  /** Minimum severity: "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL". */
  level?: string;
  sourceId?: string;
  afterMs?: number;
  beforeMs?: number;
  limit: number;
}

export function invokeSearchLogLines(args: SearchLogLinesArgs): Promise<LogLine[]> {
  return invoke("search_log_lines", {
    input: {
      query: args.query ?? null,
      level: args.level ?? null,
      source_id: args.sourceId ?? null,
      after_ms: args.afterMs ?? null,
      before_ms: args.beforeMs ?? null,
      limit: args.limit,
    },
  });
}
```

- [ ] **Step 3: Update the one existing call site so the build stays green**

In `apps/devbench/src/components/log/LogTab.tsx`, replace:

```tsx
  async function handleAdd(input: { label: string; path: string }) {
    setAddError(null);
    try {
      await invokeAddLogSource(input.label, input.path);
```

with:

```tsx
  async function handleAdd(input: { label: string; path: string }) {
    setAddError(null);
    try {
      await invokeAddLogSource({ label: input.label, kind: "file", path: input.path });
```

(Task 6 replaces this function entirely; this step exists only so the tree compiles between tasks.)

- [ ] **Step 4: Typecheck and run the frontend suite**

Run: `bun run build` then `bun run test` from `apps/devbench/`
Expected: `tsc` reports no errors; every existing test still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/components/log/LogTab.tsx
git commit -m "feat(devbench): type the kind-aware add input and search binding"
```

---

### Task 3: The Add Source popup and its three kind-scoped forms

Replaces the single always-file form with a `Menu` kind picker (File / Command / Docker) that reveals a form scoped to just that kind's fields. Docker is a frontend preset only — it submits a Command source with `program: "docker"`, `args: ["logs", "-f", "<container>"]`. Nothing in the backend knows Docker exists.

**Files:**
- Create: `apps/devbench/src/components/log/AddLogSourcePopup.tsx`
- Create: `apps/devbench/src/components/log/AddLogSourcePopup.test.tsx`
- Delete: `apps/devbench/src/components/log/AddLogSourceForm.tsx`
- Delete: `apps/devbench/src/components/log/AddLogSourceForm.test.tsx`

**Interfaces:**
- Consumes: `AddLogSourceInput` from Task 2; the `Menu` primitive from `../ui/Menu` (props: `label: string`, `options: MenuOption[]`, `onSelect: (value: string) => void`, `trigger: React.ReactNode`, `triggerClassName?: string`, `align?: "start" | "end"`; `MenuOption` is `{ value: string; label: string; description?: string; icon?: React.ReactNode }`).
- Produces:
  - `export type AddSourceKind = "file" | "command" | "docker"`
  - `export function AddLogSourcePopup({ onSubmit, onCancel, error }: { onSubmit: (input: AddLogSourceInput) => void; onCancel: () => void; error: string | null }): JSX.Element`
  - `export function parseArgs(raw: string): string[]` — splits a whitespace-separated arg string, honoring double quotes.

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/log/AddLogSourcePopup.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddLogSourcePopup, parseArgs } from "./AddLogSourcePopup";

function pickKind(kind: "File" | "Command" | "Docker") {
  fireEvent.click(screen.getByRole("button", { name: "Add log source" }));
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(kind) }));
}

describe("parseArgs", () => {
  it("splits on whitespace", () => {
    expect(parseArgs("run dev --port 3000")).toEqual(["run", "dev", "--port", "3000"]);
  });

  it("keeps a double-quoted group together", () => {
    expect(parseArgs('-c "echo hello world"')).toEqual(["-c", "echo hello world"]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseArgs("   ")).toEqual([]);
  });
});

describe("AddLogSourcePopup", () => {
  it("shows no form until a kind is picked", () => {
    render(<AddLogSourcePopup onSubmit={() => {}} onCancel={() => {}} error={null} />);
    expect(screen.queryByPlaceholderText("/tmp/devbench.log")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("npm")).not.toBeInTheDocument();
  });

  it("submits a file source", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("File");
    fireEvent.change(screen.getByPlaceholderText("/tmp/devbench.log"), {
      target: { value: "/tmp/app.log" },
    });
    fireEvent.change(screen.getByPlaceholderText("server.log"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({ label: "api", kind: "file", path: "/tmp/app.log" });
  });

  it("shows only the file field for a file source", () => {
    render(<AddLogSourcePopup onSubmit={() => {}} onCancel={() => {}} error={null} />);
    pickKind("File");
    expect(screen.getByPlaceholderText("/tmp/devbench.log")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("npm")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("my-container")).not.toBeInTheDocument();
  });

  it("submits a command source with parsed args and an optional cwd", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("Command");
    fireEvent.change(screen.getByPlaceholderText("npm"), { target: { value: "npm" } });
    fireEvent.change(screen.getByPlaceholderText("run dev"), { target: { value: "run dev" } });
    fireEvent.change(screen.getByPlaceholderText("/path/to/project (optional)"), {
      target: { value: "/home/dev/app" },
    });
    fireEvent.change(screen.getByPlaceholderText("web"), { target: { value: "web" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({
      label: "web",
      kind: "command",
      program: "npm",
      args: ["run", "dev"],
      cwd: "/home/dev/app",
    });
  });

  it("omits cwd when it is left blank", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("Command");
    fireEvent.change(screen.getByPlaceholderText("npm"), { target: { value: "npm" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({
      label: "",
      kind: "command",
      program: "npm",
      args: [],
      cwd: undefined,
    });
  });

  it("turns the docker preset into a plain command source", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("Docker");
    fireEvent.change(screen.getByPlaceholderText("my-container"), { target: { value: "api-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({
      label: "api-1",
      kind: "command",
      program: "docker",
      args: ["logs", "-f", "api-1"],
      cwd: undefined,
    });
  });

  it("does not submit a file source with an empty path", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("File");
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit a command source with an empty program", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("Command");
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a backend error", () => {
    render(<AddLogSourcePopup onSubmit={() => {}} onCancel={() => {}} error="is not a regular file" />);
    expect(screen.getByText(/is not a regular file/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test AddLogSourcePopup` from `apps/devbench/`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/devbench/src/components/log/AddLogSourcePopup.tsx`:

```tsx
import { useState } from "react";
import { Menu } from "../ui/Menu";
import type { AddLogSourceInput } from "../../lib/tauri";

export type AddSourceKind = "file" | "command" | "docker";

const KIND_OPTIONS = [
  { value: "file", label: "File", description: "Tail a log file this app can read" },
  { value: "command", label: "Command", description: "Run a program and capture its output" },
  { value: "docker", label: "Docker", description: "Follow a container's logs" },
];

const INPUT_CLASS = "rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text";

/** Splits a whitespace-separated argument string, keeping double-quoted
 *  groups intact. Args are passed to the process directly (no shell), so this
 *  is only about letting one argument contain spaces. */
export function parseArgs(raw: string): string[] {
  const matches = raw.match(/"[^"]*"|\S+/g);
  if (!matches) return [];
  return matches.map((token) =>
    token.startsWith('"') && token.endsWith('"') && token.length >= 2 ? token.slice(1, -1) : token,
  );
}

export function AddLogSourcePopup({
  onSubmit,
  onCancel,
  error,
}: {
  onSubmit: (input: AddLogSourceInput) => void;
  onCancel: () => void;
  error: string | null;
}) {
  const [kind, setKind] = useState<AddSourceKind | null>(null);
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [container, setContainer] = useState("");

  function submit() {
    const trimmedLabel = label.trim();
    if (kind === "file") {
      if (!path.trim()) return;
      onSubmit({ label: trimmedLabel, kind: "file", path: path.trim() });
    } else if (kind === "command") {
      if (!program.trim()) return;
      onSubmit({
        label: trimmedLabel,
        kind: "command",
        program: program.trim(),
        args: parseArgs(args),
        cwd: cwd.trim() || undefined,
      });
    } else if (kind === "docker") {
      const name = container.trim();
      if (!name) return;
      // Docker is a preset, not a backend kind — it fills in a Command source.
      onSubmit({
        label: trimmedLabel || name,
        kind: "command",
        program: "docker",
        args: ["logs", "-f", name],
        cwd: undefined,
      });
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <Menu
          label="Add log source"
          options={KIND_OPTIONS}
          onSelect={(value) => setKind(value as AddSourceKind)}
          triggerClassName="rounded-sm border border-border bg-bg px-2.5 py-1.5 text-sm text-text-muted hover:bg-surface-2"
          trigger={<span>{kind ? KIND_LABELS[kind] : "Choose a kind…"}</span>}
        />
        {kind ? <span className="text-xs text-text-faint">{KIND_HINTS[kind]}</span> : null}
      </div>

      {kind === "file" ? (
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/tmp/devbench.log"
            className={`flex-1 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="server.log"
            className={`w-40 ${INPUT_CLASS}`}
          />
        </div>
      ) : null}

      {kind === "command" ? (
        <div className="flex gap-2">
          <input
            value={program}
            onChange={(e) => setProgram(e.target.value)}
            placeholder="npm"
            className={`w-32 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="run dev"
            className={`flex-1 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project (optional)"
            className={`w-56 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="web"
            className={`w-32 ${INPUT_CLASS}`}
          />
        </div>
      ) : null}

      {kind === "docker" ? (
        <div className="flex gap-2">
          <input
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            placeholder="my-container"
            className={`flex-1 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="api"
            className={`w-32 ${INPUT_CLASS}`}
          />
        </div>
      ) : null}

      {kind ? (
        <div className="flex gap-2">
          <button onClick={submit} className="rounded-sm bg-accent px-4 py-1.5 text-sm font-bold text-accent-on">
            Add source
          </button>
          <button onClick={onCancel} className="rounded-sm px-3 text-sm text-text-muted hover:bg-surface-2">
            Cancel
          </button>
        </div>
      ) : null}

      {error ? <div className="rounded-sm bg-danger-bg px-2 py-1 text-xs text-danger">{error}</div> : null}
    </div>
  );
}

const KIND_LABELS: Record<AddSourceKind, string> = {
  file: "File",
  command: "Command",
  docker: "Docker",
};

const KIND_HINTS: Record<AddSourceKind, string> = {
  file: "DevBench tails the file; it is never written to.",
  command: "DevBench runs the program and captures stdout and stderr. No shell is involved.",
  docker: "Runs `docker logs -f <container>`.",
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test AddLogSourcePopup` from `apps/devbench/`
Expected: PASS — 12 tests.

If the `pickKind` helper's `getByRole("menuitem", ...)` query fails, the `Menu` primitive renders through a portal; check `Menu.test.tsx` on this branch for the exact role/query it uses and mirror it. Do not change `Menu.tsx` to suit the test.

- [ ] **Step 5: Delete the old form and its test**

```bash
git rm apps/devbench/src/components/log/AddLogSourceForm.tsx apps/devbench/src/components/log/AddLogSourceForm.test.tsx
```

`LogTab.tsx` still imports it at this point; Task 6 replaces that import. To keep the tree compiling until then, in `apps/devbench/src/components/log/LogTab.tsx` replace the import line:

```tsx
import { AddLogSourceForm } from "./AddLogSourceForm";
```

with:

```tsx
import { AddLogSourcePopup } from "./AddLogSourcePopup";
```

and replace its single usage:

```tsx
          <AddLogSourceForm onSubmit={handleAdd} onCancel={() => setShowAdd(false)} error={addError} />
```

with:

```tsx
          <AddLogSourcePopup onSubmit={handleAdd} onCancel={() => setShowAdd(false)} error={addError} />
```

and change `handleAdd` to take the new shape:

```tsx
  async function handleAdd(input: AddLogSourceInput) {
    setAddError(null);
    try {
      await invokeAddLogSource(input);
      setShowAdd(false);
      await refreshSources();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  }
```

adding `type AddLogSourceInput` to the existing `../../lib/tauri` import list.

- [ ] **Step 6: Typecheck and run the whole frontend suite**

Run: `bun run build && bun run test` from `apps/devbench/`
Expected: `tsc` clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A apps/devbench/src/components/log apps/devbench/src/lib/tauri.ts
git commit -m "feat(devbench): add source popup with file, command, and docker forms

Docker is a frontend preset that fills a Command source — the backend
has no concept of it."
```

---

### Task 4: Level chips for Live mode

Live mode's level filter: an exact multi-select over INFO/WARN/ERROR, applied client-side to already-rendered lines. Deliberately different from Search's minimum-severity select.

**Files:**
- Create: `apps/devbench/src/components/log/LevelChips.tsx`
- Create: `apps/devbench/src/components/log/LevelChips.test.tsx`
- Modify: `apps/devbench/src/components/log/LogStream.tsx`
- Modify: `apps/devbench/src/components/log/LogStream.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const LIVE_LEVELS: readonly ["INFO", "WARN", "ERROR"]`
  - `export function LevelChips({ selected, onToggle }: { selected: string[]; onToggle: (level: string) => void }): JSX.Element`
  - `LogStream`'s props become `{ lines: LogLine[]; filter: string; levels?: string[] }` — `levels` omitted or empty means no level constraint.

- [ ] **Step 1: Write the failing chip tests**

Create `apps/devbench/src/components/log/LevelChips.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LevelChips } from "./LevelChips";

describe("LevelChips", () => {
  it("renders one chip per level", () => {
    render(<LevelChips selected={[]} onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "INFO" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "WARN" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ERROR" })).toBeInTheDocument();
  });

  it("marks a selected chip as pressed", () => {
    render(<LevelChips selected={["WARN"]} onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "WARN" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "INFO" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the toggled level", () => {
    const onToggle = vi.fn();
    render(<LevelChips selected={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "ERROR" }));
    expect(onToggle).toHaveBeenCalledWith("ERROR");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test LevelChips` from `apps/devbench/`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `LevelChips`**

Create `apps/devbench/src/components/log/LevelChips.tsx`:

```tsx
export const LIVE_LEVELS = ["INFO", "WARN", "ERROR"] as const;

/** Live mode's level filter: an exact multi-select, not a threshold. Nothing
 *  selected means "no level constraint" rather than "match nothing". */
export function LevelChips({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (level: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {LIVE_LEVELS.map((level) => {
        const on = selected.includes(level);
        return (
          <button
            key={level}
            onClick={() => onToggle(level)}
            aria-pressed={on}
            className={`rounded-sm px-2 py-1 text-[11px] font-bold ${
              on ? "bg-surface-2 text-text" : "text-text-faint hover:bg-surface-2"
            }`}
          >
            {level}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify the chip tests pass**

Run: `bun run test LevelChips` from `apps/devbench/`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing `LogStream` level tests**

Append inside the existing `describe("LogStream", ...)` block in `apps/devbench/src/components/log/LogStream.test.tsx` (it already defines a `line(id, over)` helper — reuse it):

```tsx
  it("shows only lines whose level is selected", () => {
    render(
      <LogStream
        lines={[line(1, { level: "INFO" }), line(2, { level: "ERROR" })]}
        filter=""
        levels={["ERROR"]}
      />,
    );
    const rendered = screen.getAllByTestId("log-line");
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toHaveTextContent("line 2");
  });

  it("applies no level constraint when none are selected", () => {
    render(
      <LogStream lines={[line(1, { level: "INFO" }), line(2, { level: "ERROR" })]} filter="" levels={[]} />,
    );
    expect(screen.getAllByTestId("log-line")).toHaveLength(2);
  });

  it("combines the text filter and the level filter", () => {
    render(
      <LogStream
        lines={[
          line(1, { level: "ERROR", message: "boom" }),
          line(2, { level: "ERROR", message: "quiet" }),
          line(3, { level: "INFO", message: "boom" }),
        ]}
        filter="boom"
        levels={["ERROR"]}
      />,
    );
    const rendered = screen.getAllByTestId("log-line");
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toHaveTextContent("boom");
  });

  it("hides a line with no level when a level filter is active", () => {
    render(<LogStream lines={[line(1, { level: null })]} filter="" levels={["INFO"]} />);
    expect(screen.getByText(/No lines match/)).toBeInTheDocument();
  });
```

- [ ] **Step 6: Run to verify they fail**

Run: `bun run test LogStream` from `apps/devbench/`
Expected: FAIL — `LogStream` does not accept a `levels` prop, so all four render every line (and TypeScript rejects the unknown prop).

- [ ] **Step 7: Add the level filter to `LogStream`**

In `apps/devbench/src/components/log/LogStream.tsx`, replace the component signature and the `visible` memo:

```tsx
export function LogStream({ lines, filter }: { lines: LogLine[]; filter: string }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((l) => l.raw.toLowerCase().includes(needle));
  }, [lines, filter]);
```

with:

```tsx
export function LogStream({
  lines,
  filter,
  levels = [],
}: {
  lines: LogLine[];
  filter: string;
  /** Exact level multi-select. Empty means no level constraint. */
  levels?: string[];
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return lines.filter((l) => {
      if (needle && !l.raw.toLowerCase().includes(needle)) return false;
      // An unparsed line has no level, so it can't satisfy a level filter.
      if (levels.length > 0 && (l.level === null || !levels.includes(l.level))) return false;
      return true;
    });
  }, [lines, filter, levels]);
```

Also update the empty-result message so it stays accurate when the filter text is blank but a level filter is active — replace:

```tsx
  if (visible.length === 0) {
    return <div className="p-4 text-sm text-text-faint">No lines match "{filter}".</div>;
  }
```

with:

```tsx
  if (visible.length === 0) {
    return (
      <div className="p-4 text-sm text-text-faint">
        No lines match {filter.trim() ? `"${filter}"` : "the current filter"}.
      </div>
    );
  }
```

- [ ] **Step 8: Run to verify all `LogStream` tests pass**

Run: `bun run test LogStream` from `apps/devbench/`
Expected: PASS — the pre-existing tests plus the four new ones.

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src/components/log/LevelChips.tsx apps/devbench/src/components/log/LevelChips.test.tsx apps/devbench/src/components/log/LogStream.tsx apps/devbench/src/components/log/LogStream.test.tsx
git commit -m "feat(devbench): filter the live tail by level"
```

---

### Task 5: The Search bar and the static results view

Search mode's two components: the query controls, and a non-virtualized result list that is deliberately not `LogStream` — historical results scroll from the top and never auto-follow.

**Files:**
- Create: `apps/devbench/src/components/log/SearchBar.tsx`
- Create: `apps/devbench/src/components/log/SearchBar.test.tsx`
- Create: `apps/devbench/src/components/log/SearchResults.tsx`
- Create: `apps/devbench/src/components/log/SearchResults.test.tsx`

**Interfaces:**
- Consumes: `LogLine` and `SearchLogLinesArgs` from `../../lib/tauri` (Task 2).
- Produces:
  - `export interface SearchQuery { query: string; level: string; afterMs: number | null; beforeMs: number | null }`
  - `export const SEARCH_LEVELS: readonly ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]`
  - `export function SearchBar({ value, onChange, onSubmit, busy }: { value: SearchQuery; onChange: (next: SearchQuery) => void; onSubmit: () => void; busy: boolean }): JSX.Element`
  - `export function SearchResults({ lines, searched, error }: { lines: LogLine[]; searched: boolean; error: string | null }): JSX.Element`

- [ ] **Step 1: Write the failing `SearchBar` tests**

Create `apps/devbench/src/components/log/SearchBar.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchBar, type SearchQuery } from "./SearchBar";

const EMPTY: SearchQuery = { query: "", level: "", afterMs: null, beforeMs: null };

describe("SearchBar", () => {
  it("reports a typed query", () => {
    const onChange = vi.fn();
    render(<SearchBar value={EMPTY} onChange={onChange} onSubmit={() => {}} busy={false} />);
    fireEvent.change(screen.getByPlaceholderText("Search history…"), {
      target: { value: "refused" },
    });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, query: "refused" });
  });

  it("offers minimum-severity levels, not exact chips", () => {
    render(<SearchBar value={EMPTY} onChange={() => {}} onSubmit={() => {}} busy={false} />);
    const select = screen.getByLabelText("Minimum level");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "WARN and above" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Any level" })).toBeInTheDocument();
  });

  it("reports a chosen minimum level", () => {
    const onChange = vi.fn();
    render(<SearchBar value={EMPTY} onChange={onChange} onSubmit={() => {}} busy={false} />);
    fireEvent.change(screen.getByLabelText("Minimum level"), { target: { value: "ERROR" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, level: "ERROR" });
  });

  it("submits on click", () => {
    const onSubmit = vi.fn();
    render(<SearchBar value={EMPTY} onChange={() => {}} onSubmit={onSubmit} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("submits on Enter in the query field", () => {
    const onSubmit = vi.fn();
    render(<SearchBar value={EMPTY} onChange={() => {}} onSubmit={onSubmit} busy={false} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Search history…"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalled();
  });

  it("disables the button while a search is in flight", () => {
    render(<SearchBar value={EMPTY} onChange={() => {}} onSubmit={() => {}} busy={true} />);
    expect(screen.getByRole("button", { name: "Searching…" })).toBeDisabled();
  });

  it("reports a time bound as epoch milliseconds", () => {
    const onChange = vi.fn();
    render(<SearchBar value={EMPTY} onChange={onChange} onSubmit={() => {}} busy={false} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-02T10:00" } });
    const next = onChange.mock.calls[0][0] as SearchQuery;
    expect(next.afterMs).toBe(new Date("2026-08-02T10:00").getTime());
  });

  it("clears a time bound back to null when emptied", () => {
    const onChange = vi.fn();
    render(
      <SearchBar
        value={{ ...EMPTY, afterMs: 1_000 }}
        onChange={onChange}
        onSubmit={() => {}}
        busy={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });
    expect((onChange.mock.calls[0][0] as SearchQuery).afterMs).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test SearchBar` from `apps/devbench/`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `SearchBar`**

Create `apps/devbench/src/components/log/SearchBar.tsx`:

```tsx
export interface SearchQuery {
  query: string;
  /** Minimum severity; "" means no level constraint. */
  level: string;
  afterMs: number | null;
  beforeMs: number | null;
}

export const SEARCH_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;

const CONTROL_CLASS = "rounded-sm border border-border bg-bg px-2.5 py-1.5 text-sm text-text";

/** `1754121600000` -> `2026-08-02T10:00`, the format `datetime-local` wants. */
function toLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: SearchQuery;
  onChange: (next: SearchQuery) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-2.5">
      <input
        value={value.query}
        onChange={(e) => onChange({ ...value, query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        placeholder="Search history…"
        className={`min-w-40 flex-1 ${CONTROL_CLASS}`}
      />
      <label className="flex items-center gap-1.5 text-xs text-text-muted">
        <span>Level</span>
        <select
          aria-label="Minimum level"
          value={value.level}
          onChange={(e) => onChange({ ...value, level: e.target.value })}
          className={CONTROL_CLASS}
        >
          <option value="">Any level</option>
          {SEARCH_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level} and above
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-text-muted">
        <span>From</span>
        <input
          aria-label="From"
          type="datetime-local"
          value={toLocalInput(value.afterMs)}
          onChange={(e) => onChange({ ...value, afterMs: fromLocalInput(e.target.value) })}
          className={CONTROL_CLASS}
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-text-muted">
        <span>To</span>
        <input
          aria-label="To"
          type="datetime-local"
          value={toLocalInput(value.beforeMs)}
          onChange={(e) => onChange({ ...value, beforeMs: fromLocalInput(e.target.value) })}
          className={CONTROL_CLASS}
        />
      </label>
      <button
        onClick={onSubmit}
        disabled={busy}
        className="rounded-sm bg-accent px-4 py-1.5 text-sm font-bold text-accent-on disabled:opacity-60"
      >
        {busy ? "Searching…" : "Search"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify the `SearchBar` tests pass**

Run: `bun run test SearchBar` from `apps/devbench/`
Expected: PASS — 8 tests.

- [ ] **Step 5: Write the failing `SearchResults` tests**

Create `apps/devbench/src/components/log/SearchResults.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchResults } from "./SearchResults";
import type { LogLine } from "../../lib/tauri";

function line(id: number, over: Partial<LogLine> = {}): LogLine {
  return {
    id,
    source_id: "src1",
    captured_at_ms: 1_000 + id,
    timestamp: "2026-07-30T14:02:11.482Z",
    level: "INFO",
    message: `line ${id}`,
    raw: `line ${id}`,
    ...over,
  };
}

describe("SearchResults", () => {
  it("prompts before the first search", () => {
    render(<SearchResults lines={[]} searched={false} error={null} />);
    expect(screen.getByText(/Search persisted log history/)).toBeInTheDocument();
  });

  it("reports an empty result distinctly from not having searched", () => {
    render(<SearchResults lines={[]} searched={true} error={null} />);
    expect(screen.getByText(/No stored lines match/)).toBeInTheDocument();
    expect(screen.queryByText(/Search persisted log history/)).not.toBeInTheDocument();
  });

  it("renders every result row", () => {
    render(<SearchResults lines={[line(1), line(2), line(3)]} searched={true} error={null} />);
    expect(screen.getAllByTestId("search-result")).toHaveLength(3);
  });

  it("shows the full date, not just the time — results span days", () => {
    render(
      <SearchResults
        lines={[line(1, { captured_at_ms: new Date("2026-07-30T14:02:11Z").getTime() })]}
        searched={true}
        error={null}
      />,
    );
    expect(screen.getByTestId("search-result")).toHaveTextContent("2026-07-30");
  });

  it("shows a search error", () => {
    render(<SearchResults lines={[]} searched={true} error="failed to search log lines: disk full" />);
    expect(screen.getByText(/disk full/)).toBeInTheDocument();
  });

  it("does not auto-scroll like the live tail", () => {
    render(<SearchResults lines={[line(1)]} searched={true} error={null} />);
    // The live tail is `data-testid="log-stream"`; search results must be a
    // distinct component so nothing pins them to the newest row.
    expect(screen.queryByTestId("log-stream")).not.toBeInTheDocument();
    expect(screen.getByTestId("search-results")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `bun run test SearchResults` from `apps/devbench/`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement `SearchResults`**

Create `apps/devbench/src/components/log/SearchResults.tsx`:

```tsx
import type { LogLine } from "../../lib/tauri";

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

/** Search results can span days, so they carry the date the live tail omits. */
function stamp(capturedAtMs: number): string {
  const d = new Date(capturedAtMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Historical results — a plain scrollable list, deliberately not `LogStream`.
 * A live tail pins itself to the newest line; a result set the user is reading
 * must not move under them.
 */
export function SearchResults({
  lines,
  searched,
  error,
}: {
  lines: LogLine[];
  /** False until a search has actually run, so "no results" and "nothing
   *  searched yet" render as the different states they are. */
  searched: boolean;
  error: string | null;
}) {
  if (error) {
    return <div className="m-3 rounded-sm bg-danger-bg px-2 py-1 text-xs text-danger">{error}</div>;
  }
  if (!searched) {
    return (
      <div className="p-4 text-sm text-text-faint">
        Search persisted log history — including sources you have since removed.
      </div>
    );
  }
  if (lines.length === 0) {
    return <div className="p-4 text-sm text-text-faint">No stored lines match this search.</div>;
  }

  return (
    <div className="h-full overflow-y-auto font-mono text-xs" data-testid="search-results">
      {lines.map((l) => (
        <div
          key={l.id}
          data-testid="search-result"
          className="flex items-baseline gap-2.5 border-b border-border px-3 py-1"
        >
          <span className="w-36 shrink-0 tabular-nums text-text-faint">{stamp(l.captured_at_ms)}</span>
          <span className={`w-12 shrink-0 font-bold ${levelClass(l.level)}`}>{l.level ?? ""}</span>
          <span className="break-all text-text">{l.message}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Run to verify the results tests pass**

Run: `bun run test SearchResults` from `apps/devbench/`
Expected: PASS — 6 tests.

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src/components/log/SearchBar.tsx apps/devbench/src/components/log/SearchBar.test.tsx apps/devbench/src/components/log/SearchResults.tsx apps/devbench/src/components/log/SearchResults.test.tsx
git commit -m "feat(devbench): add the log search bar and static results view"
```

---

### Task 6: Wire Live/Search into the Log tab, and enrich the source list

The assembly task. Adds the mode toggle (persisted in the tab instance's own state, so two Log tabs can be in different modes), routes the body to Live or Search, and upgrades the sidebar with the kind glyph, three-state dot, and inline detail for a selected non-live source.

**Files:**
- Modify: `apps/devbench/src/components/log/LogSourcesSidebar.tsx`
- Modify: `apps/devbench/src/components/log/LogSourcesSidebar.test.tsx`
- Modify: `apps/devbench/src/components/log/LogTab.tsx`
- Create: `apps/devbench/src/components/log/LogTab.test.tsx`

**Interfaces:**
- Consumes: `AddLogSourcePopup` (Task 3), `LevelChips`/`LIVE_LEVELS` and `LogStream`'s `levels` prop (Task 4), `SearchBar`/`SearchQuery`/`SearchResults` (Task 5), `invokeSearchLogLines` (Task 2).
- Produces:
  - `LogTab`'s props become `{ sourceId: string | null; mode: "live" | "search"; onPatchState: (patch: Record<string, unknown>) => void }` — **prop change**; `ToolPane` passes `mode` from `tab.state`.
  - `LogSourcesSidebar`'s props gain nothing; its rendering changes.

- [ ] **Step 1: Update the existing sidebar fixture and the one test this task's behavior change invalidates**

Two pre-existing things in `apps/devbench/src/components/log/LogSourcesSidebar.test.tsx` break under this task and must be fixed first.

First, the `sources` fixture predates Task 2's added fields, so it no longer satisfies `LogSourceStatus`. Replace:

```tsx
const sources = [
  { id: "a", label: "server.log", path: "/tmp/server.log", state: "live", error: null },
  { id: "b", label: "worker.log", path: "/tmp/worker.log", state: "error", error: "cannot read /tmp/worker.log" },
];
```

with:

```tsx
const sources = [
  { id: "a", label: "server.log", path: "/tmp/server.log", kind: "file", state: "live", error: null, exit_code: null },
  {
    id: "b",
    label: "worker.log",
    path: "/tmp/worker.log",
    kind: "file",
    state: "error",
    error: "cannot read /tmp/worker.log",
    exit_code: null,
  },
];
```

Second, the existing test `"shows the error text for a source that cannot be read"` asserts the error is visible while passing `activeSourceId={null}`. This task deliberately narrows inline detail to the **selected** source only (spec: "for the selected source only, when it isn't live"), so that assertion is now wrong. Replace that whole test with one that pins the new rule:

```tsx
  it("shows the error text for a source that cannot be read, once it is selected", () => {
    render(
      <LogSourcesSidebar sources={sources} activeSourceId="b" onSelect={() => {}} onRemove={() => {}} onAdd={() => {}} />,
    );
    expect(screen.getByText(/cannot read \/tmp\/worker\.log/)).toBeInTheDocument();
  });
```

- [ ] **Step 1b: Write the failing sidebar tests**

Append these inside the same `describe("LogSourcesSidebar", ...)` block.

```tsx
  const exited = {
    id: "s-exited",
    label: "one-shot",
    path: "sh -c exit 3",
    kind: "command",
    state: "exited",
    error: null,
    exit_code: 3,
  };

  it("marks an exited source distinctly from an errored one", () => {
    render(
      <LogSourcesSidebar
        sources={[exited]}
        activeSourceId={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByTestId("status-s-exited")).toHaveAttribute("data-state", "exited");
  });

  it("shows a kind glyph for a command source", () => {
    render(
      <LogSourcesSidebar
        sources={[exited]}
        activeSourceId={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByTestId("kind-s-exited")).toHaveTextContent("$");
  });

  it("explains an exited source only when it is the selected one", () => {
    const { rerender } = render(
      <LogSourcesSidebar
        sources={[exited]}
        activeSourceId={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.queryByText(/not auto-restarted/)).not.toBeInTheDocument();

    rerender(
      <LogSourcesSidebar
        sources={[exited]}
        activeSourceId="s-exited"
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText(/exited \(code 3\) — not auto-restarted/)).toBeInTheDocument();
  });

  it("shows an error message only for the selected source", () => {
    const broken = {
      id: "s-err",
      label: "gone",
      path: "/tmp/gone.log",
      kind: "file",
      state: "error",
      error: "cannot read /tmp/gone.log",
      exit_code: null,
    };
    const { rerender } = render(
      <LogSourcesSidebar
        sources={[broken]}
        activeSourceId={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.queryByText(/cannot read/)).not.toBeInTheDocument();

    rerender(
      <LogSourcesSidebar
        sources={[broken]}
        activeSourceId="s-err"
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText(/cannot read/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test LogSourcesSidebar` from `apps/devbench/`
Expected: FAIL — no `status-*`/`kind-*` test ids exist, no exited handling, and the error detail currently renders for every source regardless of selection.

- [ ] **Step 3: Rewrite the sidebar's source rows**

In `apps/devbench/src/components/log/LogSourcesSidebar.tsx`, add above the component:

```tsx
const STATUS_CLASS: Record<string, string> = {
  live: "bg-success",
  exited: "bg-text-faint",
  error: "bg-danger",
};

/** An exited command is not an error — it ran and finished. */
function statusClass(state: string): string {
  return STATUS_CLASS[state] ?? "bg-danger";
}

function detail(source: LogSourceStatus): string | null {
  if (source.state === "exited") {
    const code = source.exit_code === null ? "unknown" : String(source.exit_code);
    return `exited (code ${code}) — not auto-restarted`;
  }
  return source.error;
}
```

Then replace the whole `{sources.map((source) => ( ... ))}` block with:

```tsx
        {sources.map((source) => {
          const selected = activeSourceId === source.id;
          const note = selected ? detail(source) : null;
          return (
            <div key={source.id} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onSelect(source.id)}
                  aria-current={selected}
                  className={`flex flex-1 items-center gap-1.5 rounded-sm p-2 text-left text-xs ${
                    selected ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
                  }`}
                >
                  <span
                    data-testid={`status-${source.id}`}
                    data-state={source.state}
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass(source.state)}`}
                  />
                  <span
                    data-testid={`kind-${source.id}`}
                    aria-hidden="true"
                    className="shrink-0 font-mono text-text-faint"
                  >
                    {source.kind === "command" ? "$" : "≡"}
                  </span>
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
              {note ? (
                <div className="mx-2 rounded-sm bg-danger-bg px-2 py-1 text-[11px] text-danger">{note}</div>
              ) : null}
            </div>
          );
        })}
```

- [ ] **Step 4: Run to verify the sidebar tests pass**

Run: `bun run test LogSourcesSidebar` from `apps/devbench/`
Expected: PASS — pre-existing tests plus the four new ones.

- [ ] **Step 5: Write the failing `LogTab` tests**

Create `apps/devbench/src/components/log/LogTab.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LogTab } from "./LogTab";

vi.mock("../../lib/tauri", () => ({
  invokeListLogSources: vi.fn(async () => []),
  invokeReadLogLines: vi.fn(async () => ({ lines: [], next_id: 0, dropped: 0 })),
  invokeAddLogSource: vi.fn(async () => ({})),
  invokeRemoveLogSource: vi.fn(async () => {}),
  invokeSearchLogLines: vi.fn(async () => []),
}));

import { invokeSearchLogLines, invokeReadLogLines } from "../../lib/tauri";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => {} };
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LogTab", () => {
  it("renders the live tail in live mode", () => {
    render(<LogTab sourceId={null} mode="live" onPatchState={() => {}} />);
    expect(screen.getByPlaceholderText("Filter…")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search history…")).not.toBeInTheDocument();
  });

  it("renders the search UI in search mode", () => {
    render(<LogTab sourceId={null} mode="search" onPatchState={() => {}} />);
    expect(screen.getByPlaceholderText("Search history…")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Filter…")).not.toBeInTheDocument();
  });

  it("persists the mode to tab state when toggled", () => {
    const onPatchState = vi.fn();
    render(<LogTab sourceId={null} mode="live" onPatchState={onPatchState} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onPatchState).toHaveBeenCalledWith({ mode: "search" });
  });

  it("does not poll the live tail while in search mode", async () => {
    render(<LogTab sourceId={null} mode="search" onPatchState={() => {}} />);
    await new Promise((r) => setTimeout(r, 60));
    expect(invokeReadLogLines).not.toHaveBeenCalled();
  });

  it("passes the current source and query through to the backend search", async () => {
    render(<LogTab sourceId="src1" mode="search" onPatchState={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Search history…"), {
      target: { value: "refused" },
    });
    fireEvent.change(screen.getByLabelText("Minimum level"), { target: { value: "WARN" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(invokeSearchLogLines).toHaveBeenCalledWith(
        expect.objectContaining({ query: "refused", level: "WARN", sourceId: "src1" }),
      );
    });
  });

  it("searches every source when none is selected", async () => {
    render(<LogTab sourceId={null} mode="search" onPatchState={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(invokeSearchLogLines).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: undefined }),
      );
    });
  });

  it("surfaces a search failure", async () => {
    vi.mocked(invokeSearchLogLines).mockRejectedValueOnce(new Error("disk full"));
    render(<LogTab sourceId={null} mode="search" onPatchState={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(screen.getByText(/disk full/)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `bun run test LogTab` from `apps/devbench/`
Expected: FAIL — `LogTab` does not accept a `mode` prop and renders no search UI.

- [ ] **Step 7: Rewrite `LogTab`**

Replace the entire contents of `apps/devbench/src/components/log/LogTab.tsx` with:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { LogSourcesSidebar } from "./LogSourcesSidebar";
import { AddLogSourcePopup } from "./AddLogSourcePopup";
import { LogStream } from "./LogStream";
import { LevelChips } from "./LevelChips";
import { SearchBar, type SearchQuery } from "./SearchBar";
import { SearchResults } from "./SearchResults";
import {
  invokeAddLogSource,
  invokeListLogSources,
  invokeReadLogLines,
  invokeRemoveLogSource,
  invokeSearchLogLines,
  type AddLogSourceInput,
  type LogLine,
  type LogSourceStatus,
} from "../../lib/tauri";

/** How often the frontend drains newly-tailed lines from the Rust buffer. */
const POLL_INTERVAL_MS = 500;
/** How many lines the UI keeps rendered. Matches the Rust buffer's own cap. */
const MAX_RENDERED_LINES = 5_000;
const SEARCH_LIMIT = 500;

const EMPTY_SEARCH: SearchQuery = { query: "", level: "", afterMs: null, beforeMs: null };

export function LogTab({
  sourceId,
  mode,
  onPatchState,
}: {
  sourceId: string | null;
  mode: "live" | "search";
  onPatchState: (patch: Record<string, unknown>) => void;
}) {
  const [sources, setSources] = useState<LogSourceStatus[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [levels, setLevels] = useState<string[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [search, setSearch] = useState<SearchQuery>(EMPTY_SEARCH);
  const [results, setResults] = useState<LogLine[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const afterIdRef = useRef(0);

  const refreshSources = useCallback(async () => {
    try {
      setSources(await invokeListLogSources());
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  // Changing the source filter restarts the read cursor so the pane shows that
  // source's buffered history rather than only what arrives from now on.
  useEffect(() => {
    afterIdRef.current = 0;
    setLines([]);
    setDropped(0);
  }, [sourceId]);

  useEffect(() => {
    // Search mode reads SQLite on demand; polling the live buffer behind it
    // would burn IPC for a view nobody is looking at.
    if (mode !== "live") return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const page = await invokeReadLogLines({
          afterId: afterIdRef.current,
          sourceId: sourceId ?? undefined,
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
  }, [sourceId, mode, refreshSources]);

  async function handleAdd(input: AddLogSourceInput) {
    setAddError(null);
    try {
      await invokeAddLogSource(input);
      setShowAdd(false);
      await refreshSources();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemove(id: string) {
    try {
      await invokeRemoveLogSource(id);
      if (sourceId === id) onPatchState({ sourceId: null });
      await refreshSources();
    } catch {
      await refreshSources();
    }
  }

  async function runSearch() {
    setSearching(true);
    setSearchError(null);
    try {
      const found = await invokeSearchLogLines({
        query: search.query.trim() || undefined,
        level: search.level || undefined,
        sourceId: sourceId ?? undefined,
        afterMs: search.afterMs ?? undefined,
        beforeMs: search.beforeMs ?? undefined,
        limit: SEARCH_LIMIT,
      });
      setResults(found);
    } catch (err) {
      setResults([]);
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearched(true);
      setSearching(false);
    }
  }

  function toggleLevel(level: string) {
    setLevels((prev) => (prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]));
  }

  return (
    <div className="-m-6 flex h-full">
      <LogSourcesSidebar
        sources={sources}
        activeSourceId={sourceId}
        onSelect={(id) => onPatchState({ sourceId: id })}
        onRemove={handleRemove}
        onAdd={() => setShowAdd(true)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {showAdd ? (
          <AddLogSourcePopup onSubmit={handleAdd} onCancel={() => setShowAdd(false)} error={addError} />
        ) : null}

        <div className="flex items-center gap-1 border-b border-border px-2.5 py-1.5">
          <ModeButton mode="live" current={mode} onSelect={onPatchState} label="Live" />
          <ModeButton mode="search" current={mode} onSelect={onPatchState} label="Search" />
        </div>

        {mode === "live" ? (
          <>
            <div className="flex items-center gap-2 border-b border-border p-2.5">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-sm text-text"
              />
              <LevelChips selected={levels} onToggle={toggleLevel} />
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
              <LogStream lines={lines} filter={filter} levels={levels} />
            </div>
          </>
        ) : (
          <>
            <SearchBar value={search} onChange={setSearch} onSubmit={runSearch} busy={searching} />
            <div className="flex-1 overflow-hidden">
              <SearchResults lines={results} searched={searched} error={searchError} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  mode,
  current,
  onSelect,
  label,
}: {
  mode: "live" | "search";
  current: "live" | "search";
  onSelect: (patch: Record<string, unknown>) => void;
  label: string;
}) {
  const active = current === mode;
  return (
    <button
      onClick={() => onSelect({ mode })}
      aria-pressed={active}
      className={`rounded-sm px-3 py-1 text-xs font-semibold ${
        active ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
      }`}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 8: Run to verify the `LogTab` tests pass**

Run: `bun run test LogTab` from `apps/devbench/`
Expected: PASS — 7 tests.

- [ ] **Step 9: Pass `mode` from the tab's persisted state**

In `apps/devbench/src/components/shell/ToolPane.tsx`, replace the `"log"` case:

```tsx
    case "log":
      return (
        <LogTab sourceId={typeof tab.state.sourceId === "string" ? tab.state.sourceId : null} onPatchState={onPatchState} />
      );
```

with:

```tsx
    case "log":
      return (
        <LogTab
          sourceId={typeof tab.state.sourceId === "string" ? tab.state.sourceId : null}
          mode={tab.state.mode === "search" ? "search" : "live"}
          onPatchState={onPatchState}
        />
      );
```

Each Log tab instance therefore holds its own mode, and `useTabController`'s existing debounced `patchTabState` write persists it to SQLite with no further change.

- [ ] **Step 10: Typecheck and run the whole frontend suite**

Run: `bun run build && bun run test` from `apps/devbench/`
Expected: `tsc` clean; every test passes.

- [ ] **Step 11: Run the whole Rust suite once more**

Run: `cargo test` from `apps/devbench/src-tauri/`
Expected: PASS — this plan's only backend change was Task 1, but confirm nothing regressed.

- [ ] **Step 12: Commit**

```bash
git add apps/devbench/src/components/log apps/devbench/src/components/shell/ToolPane.tsx
git commit -m "feat(devbench): per-tab Live/Search modes and a richer source list

Mode lives in the tab instance's own state, so two Log tabs can sit in
different modes. Search mode stops polling the live buffer."
```

---

## Definition of Done

- `cargo test` passes from `apps/devbench/src-tauri/` with zero failures and no new warnings.
- `bun run build && bun run test` pass from `apps/devbench/`.
- A File, a Command, and a Docker source can each be added from the Add Source popup, and each shows only its own kind's fields.
- Docker sources reach the backend as ordinary Command sources (`program: "docker"`); nothing backend-side knows Docker exists.
- Live mode filters by substring and by exact level chips; Search mode queries SQLite with a substring, a minimum-severity threshold, and optional source and time bounds.
- Search finds lines from a source that has since been removed.
- Search results render in a distinct, non-auto-scrolling component.
- Two Log tab instances can be in different modes simultaneously, and each tab's mode survives a restart via the existing tab-state persistence.
- The source list distinguishes `live` / `error` / `exited`, shows a kind glyph, and shows inline detail only for the selected source.
