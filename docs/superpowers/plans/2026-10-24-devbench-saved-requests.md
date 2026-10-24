# DevBench Saved Requests Implementation Plan (Plan 2)

**Status:** Implemented and verified on the existing branch/PR #8; see the matching verification report.
**Spec:** `docs/superpowers/specs/2026-07-31-devbench-api-composer.md`, Saved requests and composer persistence sections.
**Workspace:** existing `.claude/worktrees/continue-plan-7db8d1`, branch `claude/devbench-composer-main-merge-5bd49a`; no branch/worktree creation.

## Contracts

- A flat, session-scoped Saved section sits above History. None/unscoped lists all,
  matching History. Named sessions list only their definitions. Deleting a session
  sets saved session_id NULL; it never deletes definitions.
- First Save prompts for a name and creates; later Save updates the loaded row.
  Send never saves. Rename changes only name/timestamp. Delete confirms. History
  remains read-only and does not load or dirty the composer.
- Persist method, URL, enabled header rows, body/type, auth, active request tab,
  loaded definition metadata, and dirty flag through existing debounced tab state.
  Default-fill old method/URL-only states. Do not persist responses, resize height,
  or separate params. Preserve transient blank Params rows and controlled URL sync.
- Keep Rust request execution flat. Saved definitions have a separate enabled-row
  storage type and opaque auth JSON; the request sender does not learn auth modes.
- Preserve the spec's approved local plaintext secret storage. No keychain work,
  environments, folders, import/export, new auth schemes, replay, or layout toggle.
- Append `0010_saved_requests.sql`; never edit existing migrations 0001–0009.
- Async Save preserves newer edits and ignores stale UI completions after loading
  another request, switching session, or unmounting. Successful mutations update
  other mounted Saved lists; stale reads cannot resurrect deleted/renamed rows.
- Existing mockup and shared Menu/SecondaryButton styling remain authoritative.

## Tasks

### 1. SQLite storage and commands

- [x] Add saved_requests CRUD integration tests against real temp SQLite for full
  snapshot round-trip (including disabled rows/auth), update-in-place, rename-only,
  delete/missing IDs, validation, scoped/unscoped ordering, session deletion, and
  upgrading a real database migrated through 0009.
- [x] Observe failure, implement separate SavedHeaderRow/SavedRequestInput/SavedRequest
  storage types and five commands in commands/saved_requests.rs, register in main.rs.
- [x] Migration 0010 creates table/index only. Query ordering is updated_at DESC
  with deterministic ID tie-breaking. Names are trimmed and must be nonempty.
- [x] Run focused Rust tests and commit locally.

### 2. Composer model and IPC

- [x] Add domain defaults/normalization and snapshot-conversion tests. Old tab JSON
  defaults correctly; enabled false/auth/body survive; separate params never appear.
- [x] Define the shared ComposerDraft/AuthState/header/body/tab types in lib/apiComposer.ts.
  Keep editor type re-exports so existing consumers remain compatible.
- [x] Add SavedRequest/Input and invoke wrappers; assert exact camelCase command
  argument names and snake_case persisted DTO fields at the IPC boundary.
- [x] Lift editor state into controlled RequestBuilder props and ApiTab tab state;
  keep method/URL ownership and transient Params projection. Verify restart-style
  remount and active-tab changes preserve the full composer; commit locally.

### 3. Saved list and Save workflow

- [x] Add controlled ApiTab tests for load, dirty label, send-without-save, first
  create/later update, rename/delete, failed/cancelled operations, missing loaded
  definitions, session switches, and edits/selection changes while Save is pending.
- [x] Add a session-safe Saved-list hook with successful-mutation notifications;
  replay mutations over in-flight list reads to prevent stale row resurrection.
- [x] Build stacked Saved/History sidebar, shared-menu Rename/Delete actions,
  loaded label/unsaved pill, and Save beside Send. Save works without DB connection.
- [x] Preserve the loaded definition's original session when updating from the
  unscoped view. New definitions capture the active session at Save time.
- [x] Verify mutations across mounted API instances and loading/error/empty states;
  commit locally.

### 4. Final verification and same-PR update

- [x] Full frontend suite and build; full Rust suite with the verified local
  disposable test Postgres; real exit codes and complete logs, no runner pipes.
- [x] Confirm migration uniqueness and sender wire shape. Review locally; prior
  delegated-review disclosure rejection remains in effect.
- [x] Update synthetic QA fixture and verification report. Do not leave any server
  running; screenshot tooling limitations from UI polish remain explicit.
- [x] Commit, push this existing branch normally, and update PR #8's description
  to include both plans and new verification results. Keep it linked to this thread.
