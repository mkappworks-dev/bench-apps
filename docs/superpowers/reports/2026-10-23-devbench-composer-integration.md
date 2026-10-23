# API composer integration with main

Workspace: `.claude/worktrees/continue-plan-7db8d1`
Branch: `claude/devbench-composer-main-merge-5bd49a`
Base: `origin/main` at `d7d92ed`

## Recovered state and integration

The supplied branch began clean at `03a0633`, without the composer changes.
It was rebased onto fetched `origin/main` before replaying the composer commits
reachable at `worktree-devbench-api-composer` (`6cc482b`). Eighteen commits were
replayed; the nineteenth, an ignore-only change, was already present on main.
No new branch or worktree was created. Nothing was pushed and no PR was opened.

- Keep main's persisted method/URL props, Menu method picker (including PATCH),
  connection IDs, qualified table identities, and history IDs for Email links.
- Params edits write through `onPatchState({ url })`. A controlled-component
  regression test checks both directions and fails if the persistence update
  is removed.
- Keep the frontend/Rust boundary flat: enabled headers and resolved auth reach
  Rust only as HeaderPair entries or URL query entries; Rust has no auth modes.
- Append the history migration as `0009_request_history_headers.sql`, because
  main already owns migrations 0001–0008. Its legacy-database test withholds
  version 9 and asserts eight earlier migrations. The pre-0003 test is intact.
- Retain both sides' history/composer tests. Repair stale literals in newer
  main tests, including the shell history-focus fixture. The end-to-end smoke
  fixture stores the actual response headers.
- Headers/body/auth editor state retains Plan 1's component-local behavior.
  Saved requests (Plan 2) remain out of scope.

## Verification

Run from `apps/devbench`:

```sh
bun run test
bun run build
```

Run from this worktree's root:

```sh
PGPORT=5433 cargo test --manifest-path apps/devbench/src-tauri/Cargo.toml
```

The test helpers now accept PGPORT in addition to PGHOST/PGDATABASE/PGUSER/
PGPASSWORD. Verification used an isolated `postgres:17-alpine` container on
127.0.0.1:5433 with database `devbench_test` and postgres/postgres credentials.
Openstem's Postgres on 5432 and Redis were left untouched. They were running
at the initial inspection and were stopped by something outside this task
before final cleanup; this task did not stop or restart either service.

Results on the final source tree:

- Frontend: **650 passed**, 58 files, exit 0 (`frontend-final.log`).
- Build: **tsc && vite build passed**, exit 0 (`build-final.log`).
- Rust: **274 unit tests + 6 smoke tests passed**, exit 0; the explicitly
  ignored OS-keychain test remains ignored (`rust-final.log`).
- Params persistence regression: 13 RequestBuilder tests passed; deliberately
  removing the persistence update failed the new regression with zero patch
  calls, then the source was restored (`params-mutation.log`).
- `git diff --check` passed and `origin/main` is an ancestor of HEAD.

Full output and actual command exit codes were captured without piping test
commands. Logs are in `/tmp/devbench-composer-verification/`.

## Review limits and existing follow-ups

Local diff review confirmed the integration invariants above. Delegated review
was rejected by automatic approval review because disclosure of this private
repository to that reviewer destination was not explicitly authorized.

Two existing composer issues are unchanged from `6cc482b`, outside the merge
resolutions: adding a blank Params row drops it because URL serialization
filters empty keys, and malformed percent escapes throw in `decodeURIComponent`
while rendering the URL's params. Query parsing also inherits the original
helper's handling of `=` and `?` inside query values. These deserve a composer
follow-up before treating the feature's edge cases as complete.
