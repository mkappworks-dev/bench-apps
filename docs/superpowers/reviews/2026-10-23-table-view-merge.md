# Table view: merge and follow-up verification

## Preserved evidence

The original ignored Slice 4 ledger (`.superpowers/sdd/2026-08-19-table-view-slice-4-queries/progress.md`) was absent when this session resumed on 2026-10-23. The feature branch survived at `d9c0144`; its missing worktree was recreated. This document preserves the evidence available in committed files, rather than reconstructing the missing 35 rulings or parked minors.

The full historical measurements remain in the [Slice 4 plan's measured results](../plans/2026-08-19-table-view-slice-4-queries.md#measured-results). In particular:

- Editor and results use the page background; query chrome carries the neutral tint.
- Full-width grip, centered 36px pill, editor limits 90px/560px, and a 210px rail across table/query switches were measured in Chromium at 1440 × 900.
- Flex-item blockification makes authored `inline-flex` compute to `flex`; icon/label alignment, not that computed string, proves the button's horizontal layout.
- `elementFromPoint` establishes hit targets. Virtualized rows create stacking contexts through transforms, so comparing z-index cannot prove clickability.

Accepted residual behavior is recorded in [spec §18](../specs/2026-08-02-devbench-table-view-design.md#18-risks-and-known-gaps): expensive first counts, conflicts after staging, rerun divergence, un-requeried staged values, SQL-only groups, stale in-flight results, FK text-cast disagreement, and bare transaction-control statements. This follow-up does not change them.

## Merge gates

`origin/main` was fetched and remained `03a0633`, the feature's fork point. All 153 feature commits landed together in local merge `dbcb11a`; there were no conflicts.

Both the feature tip and the merged checkout were verified independently:

| Gate | Feature `d9c0144` | Merged `dbcb11a` |
|---|---|---|
| `bun run test` | 552 passed / 51 files | 552 passed / 51 files |
| `bun run build` | passed, 274 modules, no warnings | passed, 274 modules, no warnings |
| `cargo test` | 263 library passed, 1 ignored; 6 smoke passed | 263 library passed, 1 ignored; 6 smoke passed |

Host port 5432 was free before Compose started. The restored checkout's service, `devbench-db-connections-postgres-1`, was then confirmed healthy on `0.0.0.0:5432`. The service name differs from the former root checkout's `bench-apps-postgres-1` because Compose derives its project name from the checkout directory. Sibling databases bind host ports 55419 and 55432; none was stopped. Tests created their own fixtures; no schema was seeded.

## Four closed gaps

- Query resizing now supports keyboard focus, numeric ARIA values, ArrowUp/ArrowDown in 10px steps, and Home/End at the exported bounds.
- Document lookup searches both panes. A legacy left-pane match wins independent of array order; query state and its pinned connection are preserved. Other deep links still patch the matched document. A missing document opens on the left.
- Apply strips frontend-only `connection_id` from each nested change instead of depending on serde ignoring it. Exact payload assertions cover update/insert/delete/SQL, nulls, and caller immutability.
- Row-copy trigger and menu names include identity: primary-key column/value for tables, page-aware numbers from the successfully loaded row snapshot without a usable key, and one-based numbers for generic query results.

Each change has a regression test observed failing before implementation. The focused passing suites contain 23 query-tab tests, 22 tab-controller tests, 18 IPC tests, and 95 grid/table-tab tests after the review fix.

## Browser gate (2026-10-23)

Playwright Chromium 151.0.7922.34, viewport 1440 × 900, devicePixelRatio 1; `apps/devbench/scripts/fk-stub.js` injected before app loading. The collaborative preview twice returned `Preview automation snapshot timed out after 15000ms.`, so verification used standalone Playwright.

| Check | Measured result |
|---|---|
| Rendered grid rows | 24 of 260 stub rows |
| Horizontal scroll / maximum header-body drift | 1112px / 0px |
| Document scrollWidth / clientWidth | 1440px / 1440px |
| Copy button center hit | true; rectangle (1047, 182.75), 20 × 20px |
| Copy menu item center hit | true; rectangle (984, 241.75), 110 × 24px |
| Initial editor height / ARIA value | 220px / 220 |
| Tab from SQL editor reaches grip | true |
| Focus outline | solid, 2px |
| Home / ArrowUp at minimum | 90px / 90px |
| ArrowDown from minimum | 100px |
| End / ArrowDown at maximum | 560px / 560px |
| ArrowUp from maximum | 550px |
| Grip center hit | true; rectangle (450, 623), 670 × 14px |
| Centered pill width | 36px |
| Mouse drag minimum / maximum | 90px / 560px, matching ARIA values |

Bounds were read from the running QueryTab module, not copied into the browser assertions. Every hit check used `document.elementFromPoint` at the target's center. No z-index comparison was used.

## Follow-up gates

`bun run test`: 569 passed across 51 files. `bun run build`: passed, 274 modules, no warnings. `cargo test`: 263 library tests passed, 1 ignored; all 6 smoke tests passed. Existing React `act(...)` warnings and Node localStorage warnings remain in frontend test output; they were present in the initial baseline too.

## Fresh review and fix

A fresh read-only review by gpt-6-astra/high covered `dbcb11a..934f9cc`. It found no Critical issues and one issue initially graded Minor: keyless copy labels used the requested page before its rows loaded. A failed fetch could leave old row data permanently labeled with the new page's numbers. This was regraded Important because it directly undermined the row-identity accessibility fix.

Two deferred-fetch regressions (success and rejection) failed first. The fix stores the successful fetch's offset alongside its rows and uses that snapshot for fallback labels. Both tests then passed, the full suite passed 569/569, and the build, full Rust suite and Playwright gate passed again. No review findings remain deferred.

The reviewer set aside the existing accepted §18 stale-result/FK-comparison trade-offs and the pre-existing z-index tests as proof of clickability. Those rulings stand: the former remain explicitly accepted (cost: confusing stale results or an empty FK-jump grid); clickability rests on browser `elementFromPoint` measurements (cost if relying on jsdom instead: missed occluded controls).

## Final main verification and cleanup

The follow-ups landed in local merge `6efd4ca`. All three gates were rerun on that merged main checkout: 569 frontend tests / 51 files; clean build with 274 modules and no warnings; 263 Rust library tests passed, 1 ignored, and 6 smoke tests passed.

Only after those gates passed, the temporary Vite server was stopped, the restored worktree was removed, and both merged local branches were deleted. The original feature branch's stale remote upstream initially blocked safe deletion; its main ancestry was verified, the local upstream association removed, and safe deletion then succeeded. Remote branches were not changed. No push or PR was made.

The available historical decisions and all new measurements are preserved above. This session's raw ledger, Playwright script, JSON measurements and screenshot were also copied to `/private/tmp/devbench-table-view-verification-2026-10-23` before removing the worktree. That temporary copy is optional diagnostic material; the durable record is this committed document.
