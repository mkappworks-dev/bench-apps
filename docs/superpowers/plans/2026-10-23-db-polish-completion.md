# DB Polish Completion Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and superpowers:test-driven-development. Check each task after its tests pass.

**Goal:** Complete the remaining count, type-rendering, stale-result and FK-navigation work identified after the table-view merge, and reconcile the edit-guard review note.

**Architecture:** Cache count promises in frontend session memory, keyed by session/connection/schema/table/filter. Invalidate through successful write and connection IPC wrappers and the Refresh action. Carry Postgres result type names with table rows and query previews, with unknown metadata treated as text. Guard query continuations by document/SQL generation while always rolling back returned previews. Give pinned FK equality its own filter operator whose cast type is resolved and validated by Rust.

**Spec:** `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` §§7, 8, 13, 15, 18, and the user's request to implement the remaining items.

**Tech stack:** Existing React/TypeScript/Zustand, Rust/sqlx, Vitest, Playwright.

## Constraints

- Existing isolated worktree `devbench-db-connections`; explicitly cd before every git command.
- Keep the demo database and isolated app state. Tests use `devbench_test` on confirmed host port 5432, unique fixture names, and full `cargo test` including smoke tests.
- No push or PR without asking. Keep the worktree available to run the app after completion.
- Default no comments; document only non-local constraints and decisions that types/code cannot express.
- No jsdom layout assertions. Use browser rectangles and elementFromPoint for layout/hit targets.
- This does not add approximate counts, export-all, or automatic prevention of SQL rerun divergence; those were outside the requested remainder.

## Review focus

- Pending count requests deduplicate; rejected requests can retry; invalidated requests cannot repopulate the cache.
- Cache identities cannot cross schemas, connections or sessions; Apply invalidates the connection it actually wrote even if the picker moved.
- Text values `true` and `false` stay text; actual bools retain checkboxes, staging, and NULL distinction in tables and query results.
- A stale/unmounted query run still rolls back; stale success/errors do not restore results, while rollback failures remain visible and prevent staging.
- Typed FK jumps bind values, validate server-resolved type names, and agree with popover lookup on timestamps and float extremes.
- Cell staging opens no transaction; Apply removes only sent entries and cannot lose its conflict UI while in flight.

### Task 1: Cache counts

Files: new `src/lib/tableCountCache.ts` and tests; `DbTab.tsx` and tests; `lib/tauri.ts` and IPC tests; `grid/GridToolbar.tsx` and tests (all under `apps/devbench`).

- [x] Add red tests for cache reuse/deduplication, key boundaries, retries, invalidation during an in-flight load, Refresh/Apply/connection-edit invalidation, and a pending count shown as `of —`.
- [x] Implement `createTableCountCache()` with `get(sessionId, connectionId, table, filter, load)`, `invalidateConnection`, and `invalidateTable`; export one session-memory instance. Keep row fetching independent of count completion.
- [x] Verify focused tests and full frontend suite. Commit the count feature.

### Task 2: Render boolean types from metadata

Files: `src-tauri/src/commands/{db,db_columns,query}.rs`; `src/lib/tauri.ts`; `DataGrid.tsx`, `DbTab.tsx`, `QueryTab.tsx`, `grid/FkPopover.tsx`, and tests.

- [x] Add red regressions for text `true`/`false`, real bools and NULL, query expressions/aliases and zero-row query type metadata.
- [x] Add result `column_types` arrays from sqlx column descriptors. Frontend consumers tolerate absent metadata and render it as text; actual `bool` type alone selects boolean presentation.
- [x] Verify focused frontend/Rust tests, build and full suites. Commit the type correction.

### Task 3: Suppress stale query continuations

Files: `QueryTab.tsx` and tests.

- [x] Add red tests for edit-away/edit-back, late query failure, unmount, and rollback failure after SQL changes.
- [x] Increment a generation on SQL/document changes and unmount. Gate result/error updates and staging by current generation; always request rollback on any returned preview. Keep rollback failures visible because transaction outcome is independent of editor freshness.
- [x] Verify query tests and the frontend suite. Commit the stale-result fix.

### Task 4: Match FK navigation by real type

Files: `grid/types.ts`, `DbTab.tsx`, `src-tauri/src/commands/{db_filter,db,db_columns}.rs`, and tests.

- [x] Add red Rust regressions comparing FK popover lookup with list/count typed filters for timestamptz offsets, float extremes and hostile values. Add a frontend assertion that FK jumps emit `eq_typed`.
- [x] Add internal `eq_typed` operator for pinned FK filters. Resolve cast types in `compile_filter_for_table(pool, table, conditions, first_param_index)` and validate identifiers before interpolation; preserve ordinary text filter behavior. Use the same compiler for list and count.
- [x] Verify focused tests and full suites. Commit typed FK navigation.

### Task 5: Audit, reconcile, verify

- [x] Inspect §15 against cell staging and Apply code/tests; add regression coverage wherever the retired guards' invariant is not established. Close the stale §18 review note with evidence.
- [x] Update the spec and add a concise review/verification record, preserving accepted trade-offs rather than claiming all risks are eliminated.
- [x] Run frontend suite/build, full Rust suite, and real-browser checks for boolean/text presentation, cached pagination, and hit targets.
- [x] Request one fresh read-only review; reproduce important findings with failing tests and fix them, then rerun full gates.
- [ ] Merge locally only after green checks, retain the worktree and restart its app on Local Demo. Do not push or open a PR.
