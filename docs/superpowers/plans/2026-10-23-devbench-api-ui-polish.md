# DevBench API UI Polish Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task in the existing worktree. Steps use checkbox (`- [x]`) syntax for tracking. Do not create a worktree or branch. Delegated review previously failed disclosure approval; do not retry it without explicit authorization.

**Status:** Approved and implemented. Automated and browser DOM checks pass; screenshot, native 1024×768, and native browser zoom checks remain unverified. See the matching verification report.

**Goal:** Finish the existing API composer workflow in DevBench's current visual
language, fixing blocked editing before cosmetic refinement.

**Architecture:** Preserve controlled method/URL state and the flat Rust wire
format. Keep editor-only Params drafts local, use incumbent UI primitives, and
adapt the API pane with scoped container queries.

**Tech Stack:** React 18, TypeScript, Tailwind v4, existing Base UI wrappers,
Vitest/Testing Library, Vite, existing Tauri/Rust backend; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-devbench-api-ui-polish-design.md`.

## Global Constraints

- Worktree: `/Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/continue-plan-7db8d1`.
- Branch: `claude/devbench-composer-main-merge-5bd49a`; baseline `7286a13`.
- Refine existing mockup/styling; retain theme tokens, font roles, and semantic colors.
- Preserve `onPatchState`, connection IDs, qualified tables, history IDs, session
  guards, and independent tab instances. No backend wire or command changes.
- No Saved features, new persistence, dependencies, or migrations. Leave 0001–0009 intact.
- Row box: 168px initial, 64–420px bounds, 16px keyboard increments, 36×4px grip.
- Body editor: 140px minimum. Layout: 640px/480px pane breakpoints as specified.
- Capture full test logs and real exit codes; never pipe a test into head/tail.
- The user authorized direct `bun run test` from `apps/devbench` with full logs.
- Obtain visual-preview authorization before external collaborative inspection.
  Do not switch browser transports to bypass the recorded rejection.
- Commit each verified task locally; push/open a PR only when the user instructs it.

## Review Focus

1. Incomplete Params rows survive editor patches but cannot silently enter the
   persisted/send URL; direct URL edits override stale drafts (Task 1).
2. Invalid escapes, duplicate keys, `=`, `?`, `+`, and fragments do not crash
   rendering or silently truncate data (Task 1).
3. Multiple API instances have separate tab/panel IDs, focus, and drafts (Tasks 2, 5).
4. Long/Unicode data remains inspectable; UTF-8 bytes and HTTP status color are
   truthful, and loading is never shown as empty history (Task 4).
5. Narrow panes, zoom, pointer cancellation, and keyboard-only operation leave
   all controls and response content reachable (Tasks 2, 3, 5, 6).

## File responsibilities

- `composer/urlParams.ts`: tolerant ordered URL/query conversion.
- `RequestBuilder.tsx`: controlled URL/method, transient Params draft projection,
  request assembly, and request bar.
- `composer/RequestTabs.tsx`: accessible tab/panel relationships.
- `composer/KeyValueEditor.tsx`: labeled row controls and bounded resizing.
- `composer/BodyEditor.tsx`, `composer/AuthEditor.tsx`: consistent selectors/fields.
- `ResponseViewer.tsx`, `HistorySidebar.tsx`: truthful response/history states.
- `ApiTab.tsx`, `api.css` (new): pane layout and scoped responsive styling.
- `shell/SplitContent.tsx`: include API among tools owning their pane layout.
- Existing adjacent `*.test.ts(x)` files: behavioral regression coverage.
- `scripts/api-composer-stub.js` (new): development-only synthetic IPC fixture.

All component paths above are under `apps/devbench/src/components`; script paths
are under `apps/devbench`. Keep public component props unchanged except the
additive accessible `rowKind?: "param" | "header"` on KeyValueEditor.

## Preflight after plan approval

Resolve collaborative-preview authorization before the first UI edit. Prepare
Task 6's development-only synthetic IPC fixture and record the existing desktop
and narrow-pane render before executing Task 1. This is verification setup, not
an additional feature task. If authorization remains unavailable, report the
visual baseline as blocked; do not claim a rendered comparison.

---

### Task 1: Repair Params editing and query conversion

**Files:** Modify `api/composer/urlParams.ts`, its tests, `api/RequestBuilder.tsx`,
and `api/RequestBuilder.test.tsx` under the component root.

**Interfaces:** `splitUrlAndParams(url: string): { base: string;
params: UrlParam[]; fragment: string }`; fragment includes its leading `#` or
is empty. `joinUrlAndParams(base: string, params: UrlParam[], fragment = ""): string`.
Keep `UrlParam` unchanged. RequestBuilder owns an optional local snapshot
`{ url: string; rows: KeyValueRow[] }`; it projects snapshot rows only when the
snapshot URL matches the controlled URL, otherwise parses the controlled URL.

- [x] Write failing helper tests with literal expectations: `/orders?q=a=b?c#frag`
  yields base `/orders`, value `a=b?c`, fragment `#frag`; `a=1&a=2` keeps both rows;
  `q=a+b&literal=%2B` yields `a b` and `+`; `q=%` remains raw `%` without throwing;
  `/orders#frag?text` has no query. Update old object assertions for `fragment`.
- [x] Write a controlled RequestBuilder regression: Add param → value first →
  key `status` must retain the row/value, persist `/orders?status=pending`, and
  send it. A second blank-key row remains visible but is absent from payload.
  Clearing a key must retain focus and its draft value. Typing a different URL
  must replace old rows, including when returning to a previously used URL.
- [x] Run `bun run test src/components/api/composer/urlParams.test.ts src/components/api/RequestBuilder.test.tsx`
  from `apps/devbench`; confirm failures describe the current defects.
- [x] Implement tolerant decoding and first-delimiter parsing; row edits patch
  the URL with its fragment and store draft rows. Direct URL input invalidates
  the draft explicitly. Keep actual URL text untouched until a row edit.
- [x] Run those tests green and retain the existing payload/auth/header tests.
  Verify drafts are absent from IPC and tab-state patches.
- [x] Commit: `fix(devbench): keep params drafts editable and parse queries safely`.

### Task 2: Finish request tabs and key/value interaction

**Files:** Modify `api/composer/RequestTabs.tsx`, `KeyValueEditor.tsx`, their tests,
and affected role queries in `RequestBuilder.test.tsx`.

**Interfaces:** RequestTabs keeps its controlled props/ReqTab values. Consume
`ui/Tabs.tsx` for Root/List/Tab/Panel. KeyValueEditor adds `rowKind` (default
derived from `showEnabled`), with labels such as `Param 1 key`, `Header 2 value`,
`Remove header 2`, and `Include header 2 when sending`.

- [x] Add tests using a stateful wrapper: request tablist is named `Request`,
  ArrowRight/Home/End navigation selects/focuses the correct tab and displays
  its associated panel; two composers produce distinct ARIA relationships.
- [x] Add tests for row-specific accessible names and retained values after
  tab switches. Header toggles continue filtering only at request assembly.
- [x] Add tests for separator ARIA min/current/max, ArrowDown 168→184,
  ArrowUp 184→168, Home→64, End→420, bounded pointer drag, pointer cancellation,
  and unmount mid-drag. A later pointermove must not resize after cancellation.
- [x] Run `bun run test src/components/api/composer/RequestTabs.test.tsx src/components/api/composer/KeyValueEditor.test.tsx src/components/api/RequestBuilder.test.tsx`
  and observe the new cases fail before implementation.
- [x] Use existing Tabs; add labels, SVG removal, SecondaryButton add actions,
  visible focus, Pointer Events/capture cleanup, and keyboard separator behavior.
  Preserve the mockup's row density, underline, scroll box, and centered grip.
- [x] Run focused tests green; adjust old mouse-only tests to exercise Pointer
  Events. Use test-only PointerEvent support if required by jsdom.
- [x] Commit: `feat(devbench): finish keyboard and pointer composer controls`.

### Task 3: Align Body/Auth controls and safe previews

**Files:** Modify `api/composer/BodyEditor.tsx`, `AuthEditor.tsx`, their tests,
and affected RequestBuilder interaction tests.

**Interfaces:** Keep BodyType/AuthState and all editor callback signatures.
Consume `Menu`/`ChevronIcon` from `ui/Menu.tsx`; picker labels remain `Body type`,
`Auth type`, and `Add to`. Keep actual resolveAuthHeader/resolveAuthQueryParam
results unchanged. Basic preview becomes exactly
`Adds header  Authorization: Basic ••••`.

- [x] Add controlled-menu tests selecting Text/JSON, Bearer/Basic/API Key, and
  Query param through menuitemradio interactions; Escape returns focus to the
  picker. Replace native-select change events in existing tests.
- [x] Add tests locating every field by label, preserving body text across
  JSON→None→Text, and preserving auth field values across auth-type changes.
- [x] Add a short Basic credential case `u:p`: preview must not include `dTpw`
  or the raw password, while actual resolution remains `Basic dTpw`. Retain
  short bearer/API-key masking checks.
- [x] Run `bun run test src/components/api/composer/BodyEditor.test.tsx src/components/api/composer/AuthEditor.test.tsx src/components/api/RequestBuilder.test.tsx`
  red, then implement Menu pickers, associated labels, consistent control
  geometry/focus, wrapping previews, and a fully masked Basic preview.
- [x] Run the focused tests green. Verify auth modes still compile into flat
  headers/query entries and None still sends no body.
- [x] Commit: `fix(devbench): align body and auth controls with the shared menu`.

### Task 4: Finish response and history feedback

**Files:** Modify `api/ResponseViewer.tsx`, `HistorySidebar.tsx`, their tests;
retain integration coverage in `api/ApiTab.test.tsx`.

**Interfaces:** Keep existing ResponseViewer/SentRequest/HistorySidebar props.
Use independent Base UI response tabs named `Response format`. Body size is
`new TextEncoder().encode(sentRequest.body).length`. Keep history's loading,
failure, selection, consumed focus, and cancellation state ownership.

- [x] Add tests for keyboard Body/Headers selection, two separate viewer IDs,
  repeated Set-Cookie rows, and an empty response body placeholder.
- [x] Add a history body `é🙂`: the summary must show `6B body`, not `3B`.
  Verify live responses never show Sent. Verify 201/302/404/500 retain explicit
  status numbers; inspect their semantic colors in the visual gate.
- [x] With a deferred invokeListHistory promise, assert `Loading history…`
  appears and empty/failure copy does not; resolve [] to genuine empty, reject
  to existing failure copy. Retain missing-target and session-switch tests.
- [x] Run `bun run test src/components/api/ResponseViewer.test.tsx src/components/api/HistorySidebar.test.tsx src/components/api/ApiTab.test.tsx`
  red, then implement the response heading/tabs, byte count, empty body copy,
  status treatment, wrapping full header values, and distinct history loading.
- [x] Run focused tests green; keep history disclosure native/read-only and
  preserve Email deep-link selection and correlation callbacks.
- [x] Commit: `fix(devbench): finish response and history display states`.

### Task 5: Make the API pane fit the desktop shell and split views

**Files:** Modify `api/ApiTab.tsx`, `RequestBuilder.tsx`, `HistorySidebar.tsx`,
`ResponseViewer.tsx`, `shell/SplitContent.tsx`, and relevant ApiTab/SplitContent
tests. Create `api/api.css`, imported only by ApiTab.

**Interfaces:** Component props and shell callbacks remain unchanged. API joins
DB/Query in `paneOwnsItsLayout`. Add a named inline-size API root container with
an inner layout wrapper; only descendants respond to container queries.

- [x] Add an integration test with two mounted API instances: give each a
  different URL/header draft and active request panel, switch active tabs,
  and verify their state remains independent. Keep specific-instance history
  focus assertions. Assert behavior, not container CSS strings.
- [x] Run `bun run test src/components/api/ApiTab.test.tsx src/components/shell/SplitContent.test.tsx`
  and verify the state/selection contract before changing layout. This can
  already pass; preserve it rather than manufacture an unrelated failure.
- [x] Replace API's negative margins with explicit ownership of shell padding
  and overflow. Implement the spec's 220px rail, 720px main maximum, 24/12px
  padding, 16px groups, 640px stacked history, and 480px full-width Send row.
  Use min-width:0 at shrinking boundaries, 30px row inputs, and existing
  tokens/radii. Keep primary controls in DOM/focus order and full data readable.
- [x] Keep scoped CSS out of global tokens. Wrap long URLs/previews, and use
  local data overflow where necessary; the pane itself must not widen.
- [x] Run focused tests green. Geometry, contrast, zoom, and popup clipping are
  evaluated in Task 6; jsdom must not be used to claim layout correctness.
- [x] Commit: `fix(devbench): fit the api composer to narrow workspace panes`.

### Task 6: Verify the whole path against the mockup

**Files:** Create `apps/devbench/scripts/api-composer-stub.js`; create
`docs/superpowers/reports/2026-10-23-devbench-api-ui-polish.md` with evidence.

**Interfaces:** Follow `scripts/fk-stub.js` only for existing Tauri IPC fixture
shape. Supply synthetic API tabs, connections, widened history entries,
CorrelationResult including history_id, and collection-window results. Unknown
commands must throw clearly rather than silently return null. Never load the
stub in production or persist test data into a user's real database.

- [ ] Confirm preflight captured baseline desktop/narrow screenshots with
  authorization. The previous automatic preview rejection is a prerequisite
  to resolve, not permission to use another browser or export private content
  elsewhere.
- [x] Build the fixture alongside the feature's verification; cover no
  connection, sending, success, request failure, empty/history loading/failure,
  a 2,000-character URL/header, 20 headers, Unicode Sent bodies, and two panes.
- [ ] Run one batched visual/interaction inspection at 1440×900 and 1024×768,
  dark/light, pane widths 640/420/320px, and 200% zoom. Check keyboard tabs,
  menus/Escape, labels/focus, resizing/cancel, Send, response, history, Email
  focus, and rollup. Compare to mockup excluding Saved and layout-toggle UI.
- [x] Measure pane scrollWidth/clientWidth and control bounding boxes, inspect
  computed contrast and console errors. Fix all observed defects together;
  allow one confirming pass. Do not add speculative polish loops.
- [x] Run the required detector once, passing every changed UI source target:
  `node /Users/mk/.agents/skills/impeccable/scripts/detect.mjs --json <targets>`.
  Interpret findings against the existing design rather than blindly restyling.
- [x] From `apps/devbench`, run `bun run test` and `bun run build`, capturing
  separate full logs and real exit codes. The old 650 count is a baseline,
  not the expected final total. Run `git diff --check` from the worktree root.
- [x] Run `PGPORT=5432 cargo test --manifest-path apps/devbench/src-tauri/Cargo.toml`
  from the root with the existing verified DevBench test Postgres (5432 was
  available during execution; no new container was necessary). Do not stop Openstem. Remove only test resources created for this run.
- [x] Check migration numeric prefixes are unique and migration files unchanged
  from `7286a13`. Record exact commands, exit codes, totals, ignored tests,
  screenshots, remaining limitations, and whether the visual gate was completed.
- [x] Commit fixture/report locally. Report results and ask how to land; no push
  or PR until instructed. If preview remains blocked, say visual QA is incomplete.

## Execution order and review

Execute Tasks 1–6 in order. Recommend native execution in this thread because
these changes share composer state and interaction tests, and delegated review
does not have disclosure authorization. Review source/test diffs locally; do not
claim an independent review occurred. A new externally delegated reviewer requires
explicit destination authorization before dispatch.

Draft self-review checked scope, public interfaces, Params draft reconciliation,
fragment/plus handling, labels, keyboard/pointer behavior, migration safety, and
the visual-approval prerequisite. Implementation and automated/DOM verification are recorded in the matching report. The rendered screenshot gate remains open due tool failures.
