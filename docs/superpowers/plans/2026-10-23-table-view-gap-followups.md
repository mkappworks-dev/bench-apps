# Table View Gap Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four table-view gaps identified in the merge handoff.

**Architecture:** Keep editor sizing in QueryTab state; resolve existing documents across the shell's two panes; strip frontend routing metadata at the Apply IPC boundary; let DbTab supply primary-key labels to DataGrid with numbered fallbacks for other results.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, Rust/serde, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md`, especially §3b, §16 and §18, plus the user's four-gap handoff.

## Global Constraints

- Work in the existing isolated checkout on `fix/devbench-table-view-gaps`, based on the verified four-slice merge. Explicitly `cd` before every git command.
- No pushing or opening a PR without asking the user.
- Default to no comments. Preserve non-local invariants, not narration.
- No layout assertions in jsdom. Playwright measurements use `getBoundingClientRect` and `elementFromPoint`, never z-index comparisons.
- Full gates are `bun run test`, `bun run build`, and `cargo test` (including smoke tests).
- Host port 5432 belongs to this checkout's healthy Compose service, `devbench-db-connections-postgres-1`. Do not stop sibling databases or seed schemas.
- Existing accepted §18 trade-offs remain outside this change.

## Review Focus

- A right-pane query stays pinned to its original connection after the rail's active connection changes.
- Legacy duplicate matches resolve left first regardless of array order; a different query ID never matches.
- Unhandled editor keys keep their default behavior; repeated resize keys clamp at the exported limits.
- Every Apply variant retains its values and nulls while losing only frontend `connection_id`.
- Copy labels work for primary keys, keyless table pages, and query results, independent of visual column order.

---

### Task 1: Keyboard editor resizing

**Files:** `apps/devbench/src/components/db/QueryTab.tsx`, `QueryTab.test.tsx`.

**Interfaces:** Consumes exported `MIN_EDITOR_PX = 90`, `MAX_EDITOR_PX = 560`; exposes a focusable horizontal separator whose `aria-valuenow` is the editor height in pixels.

- [x] Write tests for focusability and numeric ARIA bounds; ArrowDown/ArrowUp change by 10, Home/End select the bounds, repeated arrows clamp, unrelated keys are not prevented.
- [x] Run `bun run test src/components/db/QueryTab.test.tsx`; expect new assertions to fail because keyboard support is absent.
- [x] Add bounded key handling and ARIA values without changing mouse behavior. Give the grip a visible keyboard focus indicator.
- [x] Run the same test file; expect all tests to pass. Commit `fix(devbench): make query editor resizing keyboard accessible`.

### Task 2: Resolve documents across both panes

**Files:** `apps/devbench/src/store/useTabController.ts`, `useTabController.test.ts`.

**Interfaces:** Preserve `focusOrCreateTab(kind, statePatch?, match?): string`; search left then right, activate the matched tab in its own pane, and preserve matched query state. New tabs still open on the left.

- [x] Add regressions for a right-pane saved query with a different active connection, deterministic left priority when both panes match, right-pane deep-link state patching, and a nonmatching query ID.
- [x] Run `bun run test src/store/useTabController.test.ts`; expect right-pane lookup to fail.
- [x] Search both panes with explicit left priority and activate `existing.pane`.
- [x] Run the same file; expect all tests to pass. Commit `fix(devbench): focus existing documents across split panes`.

### Task 3: Remove frontend metadata from Apply payloads

**Files:** `apps/devbench/src/lib/tauri.ts`, `tauri.test.ts`.

**Interfaces:** `invokeApplyChanges(connectionId, changes)` keeps its public signature; nested wire changes exclude `connection_id`. Top-level `connectionId` continues to choose the target pool.

- [x] Test all four variants with exact payload equality, including null cell values, nullable SQL table, and unchanged caller entries.
- [x] Run `bun run test src/lib/tauri.test.ts`; expect extra `connection_id` properties in the payload.
- [x] Strip that field from each entry before invoking Rust, avoiding reliance on serde's unknown-field tolerance.
- [x] Run the same file; expect all tests to pass. Commit `fix(devbench): strip frontend connection metadata from apply payloads`.

### Task 4: Distinguish row copy controls

**Files:** `apps/devbench/src/components/db/DataGrid.tsx`, `DataGrid.test.tsx`, `DbTab.tsx`, `DbTab.test.tsx`, and the table-view spec.

**Interfaces:** Add optional `getRowLabel(rowIndex: number): string` to DataGrid. Default to the one-based data-row index; DbTab returns `<pk column> <pk value>` where available and a page-aware row number otherwise. Copy trigger and menu share `Copy row <label>`.

- [x] Test custom labels, numbered query-result fallbacks, primary-key labels from DbTab, and page-aware labels without a primary key. Update existing copy-trigger lookups to accept the row suffix.
- [x] Run `bun run test src/components/db/DataGrid.test.tsx src/components/db/DbTab.test.tsx`; expect missing labels/prop behavior.
- [x] Thread labels through the existing grid; leave clipboard content and row actions unchanged.
- [x] Run the same files; expect all tests to pass. Commit `fix(devbench): name row copy controls by row identity`.

## Final verification and review

- [x] In Playwright with `scripts/fk-stub.js`, measure editor heights at Home/End and Arrow steps against the exported bounds. Confirm grip, copy trigger and open copy menu are hittable using `elementFromPoint`; check horizontal containment and header/body alignment under scroll.
- [x] Record measured numbers and gate results in `docs/superpowers/reviews/2026-10-23-table-view-merge.md`; preserve links to the committed Slice 4 measurements. The original ignored 35-ruling ledger was absent when this session resumed; do not invent its contents.
- [x] Update §18 to describe the four closed gaps and their regression protection.
- [x] Run all three full gates, request a fresh review of this follow-up range, and address any important findings with failing regression tests first.
- [x] Merge the verified follow-ups locally, rerun the full gates, and only then remove the restored worktree and merged branches.
