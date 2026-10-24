# Plan 2 — Saved requests

Implemented on the existing `claude/devbench-composer-main-merge-5bd49a` branch
and included in PR #8. No new branch or worktree was created.

Spec: `docs/superpowers/specs/2026-07-31-devbench-api-composer.md`.
Plan: `docs/superpowers/plans/2026-10-24-devbench-saved-requests.md`.
Baseline: `7ca2926` (Plan 1 plus UI polish).

## Behavior

- Saved requests sit above History in the existing stacked sidebar, scoped to
  the active session; the unscoped view lists all definitions like History.
- First Save prompts for a name; subsequent Save updates the loaded definition.
  Send never saves. Save works without a selected database connection.
- Selecting a definition loads method, URL, enabled/disabled headers, raw body,
  body type and auth. Edits show the unsaved-changes indicator. Rename updates
  only the saved name; Delete confirms and preserves the current composer as
  an unsaved draft if its definition is removed.
- All composer fields, active panel, loaded identity and dirty state are
  persisted through the existing 300ms debounced tab-state write. Old tab JSON
  is default-filled. Responses, resize height and blank Params rows stay
  transient; no separate params field is saved or sent.
- Loading History remains read-only and does not replace the composer.
- Saving a definition loaded from the unscoped list preserves its original
  session. Deleting a session retains its saved definitions with NULL scope.
- Successful create/update/rename/delete notifications update other mounted
  lists. Changes received during an older list read are replayed so stale
  reads cannot restore deleted rows or overwrite newer names.
- Async Save compares the latest draft with its captured content and does not
  clear newer edits. Context/selection guards reject obsolete completions.
  Double Save is prevented, and a late send cannot repaint a newly loaded
  definition's response pane.

## Storage boundary

`0010_saved_requests.sql` appends the saved_requests table and composite index.
Migration versions are uniquely numbered 0001–0010. Existing migrations and
request.rs/correlation.rs are unchanged from Plan 1.

Saved definitions have their own enabled header-row type. Rust stores auth as
opaque JSON; the frontend still resolves auth and drops unchecked rows before
sending the existing flat method/URL/HeaderPair/body request.

Saved auth values and full tab drafts use local plaintext SQLite storage as
specified in the approved design. No keychain storage, environments, folders,
advanced auth, import/export, replay, or sidebar-layout toggle was added.
There is no automated down migration for the schema additions.

## Verification

All full commands exited 0, with complete logs in `/tmp/devbench-plan2/`:

- `bun run test` from apps/devbench: **697 passed**, 62 files.
- `bun run build`: **TypeScript + Vite passed**.
- `PGPORT=5433 cargo test --manifest-path apps/devbench/src-tauri/Cargo.toml`:
  **280 unit tests + 6 smoke tests passed**, one existing OS-keychain test ignored.
- UI detector: **exit 0, no findings**, one pass over changed UI targets.
- `git diff --check`: passed. Existing request wire code and migrations 0001–0009
  remain unchanged; no duplicate numeric migration versions.

Red/green evidence includes missing storage commands failing compilation before
six SQLite integration tests passed; missing domain/IPC and Saved-list modules
failing before implementation; eight Saved UI cases failing before the workflow
was added; and 18 final Saved UI/list-hook tests passing. Coverage includes
legacy-0009 migration, snapshot round-trip, session scoping/deletion, stable
ordering, update-in-place, rename-only behavior, missing IDs, invalid names,
full composer rehydration, Save races, cancellation/failure, cross-session
completion guards, stale reads, missing definitions and History independence.

The previously used DevBench test container was stopped. Verification used an
isolated temporary Postgres on 5433; it was removed afterward. The temporary
synthetic UI server on 5187 was stopped as well. No previously stopped service
was restarted and no server started for this work remains running.

## Browser checks

The user-authorized T3 preview used only the synthetic IPC fixture in
`apps/devbench/scripts/api-composer-stub.js`. DOM checks verified:

- Saved appears above History; loading preserves the unchecked X-Debug row.
- Editing /api/orders/42 shows dirty state. Send includes only the compiled
  Authorization header and leaves the saved URL unchanged. Save updates that
  definition in place and clears the indicator.
- Rename preserves the saved URL/disabled header; Delete removes the row and
  loaded label while keeping the current draft. A subsequent first Save creates
  a new definition retaining body type, auth, and disabled headers.
- At API widths 880/640/420/320px, scrollWidth equals clientWidth. The sidebar
  stacks below 640px and stays within its 160px maximum scroll area.

Screenshot capture again returned `Preview automation snapshot timed out after
15000ms`. No screenshot comparison or native viewport/zoom verification is
claimed; the existing UI-polish limitations remain open. Review was local;
external delegated review remains outside the granted disclosure authorization.

## Implementation decisions

- Auth JSON is opaque in saved-definition storage while the execution wire
  stays flat. The frontend owns default-filling and auth compilation.
- Plan 2 is included before merging Plan 1 because the user explicitly requested
  the same branch/PR. This increases review scope but follows that instruction.
