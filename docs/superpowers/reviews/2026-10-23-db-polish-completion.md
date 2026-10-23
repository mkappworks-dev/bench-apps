# DB polish completion

The remaining count-cache, boolean-rendering, stale-query and FK-navigation work is implemented. The edit-guard audit also found and fixed two important races. This record preserves the useful execution decisions and measured evidence from the ignored workspace.

## Result

- Counts are cached by session, connection, qualified table and applied filter, including pending-request deduplication. Paging and sorting reuse counts. Refresh invalidates the table; successful Apply and connection edits/deletion invalidate the actual connection. Failed requests can retry, and invalidated promises cannot repopulate the cache. Row loading remains independent; unknown counts display `of —`.
- Rust returns Postgres `column_types` for table rows, referenced rows and query previews, including aliased expressions and zero-row results. Only boolean metadata selects checkbox rendering. Text `true`/`false` stays text; NULL remains distinct. Missing metadata has a text fallback.
- Query generations suppress stale results and errors after edits, document changes or unmount. Every returned preview is rolled back, and staging waits for rollback. Unresolved rollback failures live outside the tab, persist in local storage, and remain visible after closing/reopening or visiting Settings. An older successful run cannot clear a newer warning.
- Pinned FK navigation uses `eq_typed`. Rust resolves and validates the column type before interpolating its cast; values stay bound. Popover, list and count agree for timestamp offsets, extreme floats, empty keys and hostile text.
- Cell staging is synchronous local intent and opens no transaction. Apply retains sent-entry identity and dock dismissal protection, and now locks its submitted cells/deletes in both the UI and store. Unrelated cells remain editable. Query execution retains its separate rollback and server sweep machinery.

## Fresh review and corrections

A fresh read-only gpt-6-astra/high review covered `1494b89..a0a7bbe`. It reported no Critical findings and two Important findings:

1. A same-cell change during Apply could remove a pending boolean correction or retain an obsolete text conflict baseline. Regressions reproduce `false → true → false` and `A → B → C`; submitted cells/deletes now refuse changes until Apply settles. Unrelated additions survive by identity, and later edits are accepted again.
2. Rollback failure state disappeared when its tab unmounted, including a response arriving after closure. Regressions close before/after the response, reopen the document, reconstruct stored warnings, and cover corrupt storage. Failures now persist independently of the component and surface globally when its document is hidden. Settings also preserves visibility.

Both findings were reproduced with failing tests before correction. The settings visibility regression also failed before its fix. The reviewer did not independently rerun the full gates or browser measurements; those were performed by the implementing agent. No second review round is claimed.

## Verification

Initial baseline: 569 frontend tests / 51 files; build clean; 263 Rust library tests and 6 smoke tests passed, 1 library test ignored.

Final worktree gates:

| Command | Result |
|---|---|
| `cd apps/devbench && bun run test` | 601 passed / 53 files |
| `cd apps/devbench && bun run build` | passed, 276 modules, no warnings |
| `cd apps/devbench/src-tauri && cargo test` | 265 library passed, 1 ignored; 6 smoke passed |

The Rust gate included integration/smoke compilation and execution. Tests use their own uniquely named fixtures in `devbench_test`, separate from `devbench_demo`. The healthy DevBench Compose container owns host 5432; sibling databases were not stopped. Existing React act and Node localStorage warnings remain in test output.

Local merge `8c03314` was checked independently: 601 frontend tests / 53 files, clean production build (276 modules), and full `cargo test` with 265 library plus 6 smoke tests passed, 1 ignored. The worktree was fast-forwarded to that merge and retained. `bun run tauri dev` then compiled and launched from the worktree, with its `DEVBENCH_DATA_DIR` override confirmed. Local Demo still contains 500 customers, 300 products, 1,200 orders and 1,200 order items. Nothing was pushed and no PR was opened.

New regression coverage includes cache key boundaries, retries/in-flight invalidation, Refresh/Apply/connection invalidation, unknown count UI, typed booleans and text, stale runs, awaited rollback, durable warnings, submitted-cell locks, and popover/list/count typed equality.

## Browser measurements

Chromium 151.0.7922.34 at 1440 × 900, using the repository IPC stub with mixed boolean/text result metadata. The collaborative browser supplied some earlier measurements, then interaction returned `Preview automation click timed out after 15000ms.` twice on the same step. The final measurements below were independently completed with standalone Playwright. A query-header locator was corrected to its actual accessible name before the successful final run.

| Check | Measured result |
|---|---|
| Initial / next page / sort / Refresh count calls | 1 / 1 / 1 / 2 |
| Corresponding row calls | 2 / 3 / 4 / 5 |
| First table row | 1 real-boolean checkbox; text `true` has 0 checkboxes |
| Query rows | 3; 2 disabled real-boolean checkboxes; text `true`/`false` have 0 checkboxes; 3 NULL cells |
| Virtualized rows / horizontal scroll | 24 / 1112px |
| Maximum header/body drift | 0px |
| Document scrollWidth / clientWidth | 1440px / 1440px |
| Copy button center hit | true; rectangle (1047, 182.75), 20 × 20px |
| Copy menu center hit | true; rectangle (984, 241.75), 110 × 24px |
| Query resize grip center hit | true; rectangle (450, 293), 670 × 14px |

Hit checks used `document.elementFromPoint`; no z-index comparison or jsdom layout assertion was used. The final browser harness did not click Apply. Automatic approval review rejected that mocked click as a potential database write; it was left unperformed. IPC invalidation tests and real Rust transaction fixtures cover the corresponding behavior, but this report does not claim a browser Apply integration check.

## Decisions and remaining limits

| Decision | Reason and cost |
|---|---|
| Keep cache in session memory with production invalidation APIs | Avoid a test-only global reset; unused filter entries can remain until restart. |
| Type only pinned FK equality | Preserve existing user filter semantics; ordinary equality remains display-text matching. |
| Lock submitted cells instead of rebasing newer intent | Prevent lost intent/obsolete baselines; users retry edits to those cells after Apply settles. |
| Persist rollback warnings, tolerate unavailable storage | Closing a tab cannot erase uncertainty; storage-disabled sessions retain only the running app's warning. |
| Leave the rejected browser Apply click unperformed | Respect automatic approval review; that one integration interaction is not measured. |
| Retain the worktree and isolated Local Demo data | The user wants to run this checkout; no cleanup deletes the app state or demo database. |

Accepted limits remain in spec §18: expensive first counts, staging conflicts, SQL rerun divergence, staged values not being re-sorted/re-filtered, SQL-only groups, and confusing bare transaction-control statements. No push or PR is authorized or performed.
