# API composer UI polish — implementation and verification

Worktree: `.claude/worktrees/continue-plan-7db8d1`
Branch: `claude/devbench-composer-main-merge-5bd49a`
Plan: `docs/superpowers/plans/2026-10-23-devbench-api-ui-polish.md`
Implementation baseline: `a151444` (approved plan), integrated source `7286a13`.

## Implemented

- Params keep unfinished rows locally while URL remains the only persisted/wire
  source. Safe decoding preserves duplicates, fragments, plus signs and query
  delimiters. Direct and external URL edits discard obsolete editor drafts.
- Request and response tabs use the incumbent Base UI wrapper with keyboard
  navigation and independent ARIA IDs per instance.
- Row controls have specific labels, SVG removal, shared add buttons, visible
  focus, pointer/touch resizing, cancellation cleanup, and keyboard resizing.
  Height remains 168px initially, bounded to 64–420px in 16px keyboard steps.
- Body/Auth use shared Menu pickers; body drafts survive None, all Auth fields
  have labels, and Basic previews contain no reversible credential prefix.
- Composer pickers opt into closing after selection. Other Menu callers retain
  their previous behavior because closeOnSelect defaults to false.
- Response shows a heading, truthful status color, full repeated headers, empty
  body copy, and UTF-8 history-body byte counts. History distinguishes loading,
  empty, failed, and unavailable deep-linked entries.
- API owns pane padding/scrolling. Its history rail stacks below 640px; Send
  takes a full-width row below 480px. Forms and long data stay within the pane.
- Supporting rollup text uses the stronger existing muted token inside API only.

Plan 2 Saved requests and persistence of headers/body/auth remain out of scope.
Rust wire types, commands, correlation IDs, and database migrations are unchanged.

## Automated verification

All full commands exited **0**, with full output saved without piping runners:

- `bun run test` from `apps/devbench`: **675 passed**, 58 files.
- `bun run build` from `apps/devbench`: **tsc && vite build passed**.
- `PGPORT=5432 cargo test --manifest-path apps/devbench/src-tauri/Cargo.toml`
  from the worktree root: **274 unit tests + 6 smoke tests passed**; the existing
  OS-keychain test remains explicitly ignored.
- Impeccable detector: exit 0, no findings, run once over changed UI sources.
- Migration numeric prefixes: exactly **0001–0009**, no duplicates. Their files
  are byte-for-byte unchanged from `7286a13`; no Rust source was changed either.

Logs: `/tmp/devbench-ui-polish/`, especially `frontend-final.log`,
`build-final.log`, `rust-final.log`, and `detector.json`.

Focused red/green cycles:

- Params: 10 initial failures → 27 focused tests green.
- Tabs/rows: 7 initial failures → 31 green.
- Body/Auth: 7 initial failures, plus a failing opt-in Menu-close test → 41 green.
- Response/history: 4 initial failures → 39 green.
- Layout/state: 18 focused tests green; two mounted API instances keep independent
  URLs, headers and active panels. jsdom tests are not used to claim geometry.
- Final local review found stale draft resurrection on external URL changes;
  `drops stale draft rows when the controlled URL changes externally` failed,
  then passed with URL-change reconciliation. Full suite afterward: 675 green.

The existing `bench-apps-postgres-1` test database on 5432 was verified using
Docker psql. No database container or unrelated service was stopped or created.
The plan's 5433 override was unnecessary because the correct test DB was available.

## Rendered browser evidence

T3 collaborative preview was explicitly authorized by the user for this private
UI with synthetic data. Its browser evaluator worked against the real React UI.
No real credentials, private records, or production database were used.

A development-only fixture is saved at
`apps/devbench/scripts/api-composer-stub.js`; production HTML does not import it.
A scratch Vite server at `/tmp/devbench-ui-polish/serve.mjs` injects it before
main.tsx and serves `http://127.0.0.1:5187/`. Re-run with
`bun /tmp/devbench-ui-polish/serve.mjs` if the server has stopped.
Scenario query values: success, empty, no-connection, history-loading,
history-failure, request-failure, sending, and split. Unknown IPC commands throw
instead of silently succeeding.

Measured DOM/computed-style checks:

- Actual browser viewport: 1440×900. API widths 880/640/420/320px were constrained
  in the browser and measured after real layout, in dark and light themes.
- At every width, API scrollWidth equaled clientWidth; main content also had no
  horizontal overflow. History changed from rail to stacked layout at 640px.
  Send widths were 396px in a 420px pane and 296px in a 320px pane.
- Twenty header rows stayed in the 168px outer rows box (166px client height,
  736px scroll height). A 2,000-character header value and a 2,014-character URL
  reached the synthetic send payload intact, with one named header; unnamed
  rows were not sent.
- Two actual split API panes were each 440px wide with no horizontal overflow,
  distinct URLs and unique tab IDs.
- At 200% **CSS zoom on the API component**, its 440px CSS width occupied 880
  physical pixels without overflowing. This is not native browser zoom evidence.
- In the final sampled response/history state, minimum text contrast was
  **6.43:1 dark / 4.75:1 light**, after allowing theme transitions to settle.
- Basic preview remained fully masked while a synthetic u:p request sent
  `Authorization: Basic dTpw`. History showed `6B body` for `é🙂`.
- Actual response status colors were success for 201, warning for 302, danger
  for 404/500. Repeated Set-Cookie rows remained distinct and inspectable.
- Browser checks confirmed no-connection disabled Send, distinct loading and
  failed history copy, request-error recovery, and empty response body copy.
- A real ArrowDown key press on the focused resize separator changed 168→184.
  Unit tests cover its bounds, pointer cancellation and unmount cleanup.
- No page error/unhandled rejection was observed during the captured synthetic
  send and response/auth checks. QA evaluation mistakes were tool-side errors,
  not application exceptions.

Metrics: `/tmp/devbench-ui-polish/browser-first-pass.json` and
`browser-confirmation.json`.

## Verification limits and review

**Screenshot review is incomplete.** Every T3 snapshot attempt returned
`Preview automation snapshot timed out after 15000ms`, including without an
image request. Native Chrome fallback was unavailable/denied. No screenshot
baseline or final screenshot was obtained, and no screenshot was fabricated.

T3 resize accepted a 1024×768 setting but the browser evaluator continued to
report 1440×900. Therefore native 1024×768 viewport and native 200% browser zoom
checks are unverified. Component-width/zoom metrics above are the evidence
actually obtained; visual fidelity to the mockup is not certified.

Review was local. The prior external-review disclosure rejection was not retried:
user authorization covered collaborative preview, not a delegated reviewer.

Rulings made during execution:

1. Proceed with code/tests and browser DOM checks while screenshots remain
   unavailable. Cost: a human screenshot/visual review is still needed before
   calling the complete visual gate satisfied.
2. Add an opt-in Menu closeOnSelect rather than change all existing pickers.
   Cost if this behavior is unwanted: composer callers can omit the option;
   unrelated callers are unaffected.

No deferred code-quality minors were identified in the final local review.
Nothing has been pushed; no PR, merge, branch creation, or worktree change occurred.
