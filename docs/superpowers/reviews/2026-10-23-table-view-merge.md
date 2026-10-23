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
- Row-copy trigger and menu names include identity: primary-key column/value for tables, page-aware numbers without a usable key, and one-based numbers for generic query results.

Each change has a regression test observed failing before implementation. The focused passing suites contain 23 query-tab tests, 22 tab-controller tests, 18 IPC tests, and 93 grid/table-tab tests.

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

`bun run test`: 567 passed across 51 files. `bun run build`: passed, 274 modules, no warnings. `cargo test`: 263 library tests passed, 1 ignored; all 6 smoke tests passed. Existing React `act(...)` warnings and Node localStorage warnings remain in frontend test output; they were present in the initial baseline too.
