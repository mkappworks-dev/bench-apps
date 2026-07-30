# DevBench v1 — Design Spec

Date: 2026-07-30
Status: Approved for planning

## Context

DevBench is the first app built in the `bench-apps` monorepo. It shares a common UI layer (navigation, AI chat box, settings panel) designed for reuse across a broader family of developer-focused apps, and runs on Tauri — a lightweight choice suited to DevBench's own needs (forms, tables, network/DB connections, no heavy GPU rendering requirement).

The shared UI layer (`packages/ui-shared`, `packages/core-shared`, `packages/config`) will be extracted from DevBench's actual needs rather than designed generically upfront. Only `apps/devbench` is in scope for this spec; the shared packages exist as consumption targets, not as a designed-in-advance API.

## Licensing and distribution model

- All desktop apps in the suite, including DevBench, are MIT-licensed and local-first.
- AI features (the shared chat component) are bring-your-own-key (BYOK) by default: the user supplies their own provider API key, stored in OS-native secure storage (Keychain/Credential Manager/Secret Service), and the app calls the provider directly.
- A proprietary web frontend + backend (cloud sync, hosted AI keys, team features) is planned but out of scope for v1 — DevBench v1 requires no backend at all.
- Consequence for `core-shared`: the auth/secrets module needs two modes from the start — BYOK (default) and cloud account (optional, deferred implementation) — so the chat component's design isn't reworked later when the cloud layer arrives.

## Product summary

DevBench is a local-first workbench that unifies API testing, database browsing, log tailing, and email capture around one core action: fire a request, see everything it did. The differentiator is a request-correlated "what happened" rollup — not any single tool in isolation, all of which have established competitors (Postman, TablePlus, Mailhog-class SMTP catchers).

## V1 scope

| In scope | Deferred |
|---|---|
| API tab: request builder, response viewer, basic history | Collections/environments polish, request mocking |
| DB tab: PostgreSQL only, schema browser, query editor, data grid | Other DB engines (MySQL, SQLite, ...) |
| Log tab: tail a file or stdout; JSON-lines parsed into fields, plain text shown raw | Structured multi-source log aggregation |
| Email tab: local SMTP catcher (default port 1025, configurable), inbox view | Sending mail, not just catching |
| "What happened" rollup on fired requests, time-window correlated, with deep-links into DB/Log/Email tabs | AI narration of the rollup (v1.1 — layers on top once the raw view is validated) |
| BYOK AI chat (shared component), key in OS keychain | Cloud account, hosted AI keys, sync, teams |
| Settings screen: General (theme, correlation window, SMTP port), Provider (BYOK key, model), MCP (server list, connected/error status), Archive (restore removed sessions) | Settings sync across devices (part of the deferred cloud layer) |

AI narration is deferred deliberately: it's a layer on top of a working rollup, not a prerequisite. Shipping the raw correlated view first validates whether the underlying data is useful before investing in narration.

### Explicitly rejected for v1 (not just deferred — reconsidered and cut)

- **Fully separate tabs with no automatic correlation** and **a single fully-merged timeline replacing per-tool tabs** were both considered as the app's information architecture and rejected in favor of a hybrid (see below): the former makes the differentiator easy to ignore (a 5th tab nobody checks), the latter weakens each tool as a standalone deep-dive surface.
- **OpenTelemetry trace-based correlation** and **DB query-log tailing** were considered as the correlation mechanism and rejected in favor of before/after table snapshots: both require backend cooperation (existing tracing instrumentation, or elevated/managed DB log access) that most early-stage target users won't have. Before/after diffing works immediately against any Postgres connection with zero backend changes.
- **Additional tool categories** (cache/Redis inspector, background jobs, outbound HTTP/webhook inspector, AI/LLM call inspector, message queues, object storage, feature flags, container/infra stats) were evaluated as candidates for the DB/API/Log/Email lineup and deliberately excluded from v1 to keep scope shippable. See Roadmap below — this is not a rejection of the ideas, just a sequencing decision.
- **Scoped sessions** (a session's type restricts which tool is visible, chosen at creation) and a **command-palette-driven variant** of the same restriction were both considered for the session/history model and rejected in favor of a pure organizational layer: debugging is exploratory, and forcing a type commitment before a user knows what they'll need works against the correlation rollup being reliably available mid-investigation.

## Information architecture

Hybrid: each of the four tools (API, DB, Log, Email) has a full, independent tab for its browse/manage mode — this is the familiar, power-user-friendly surface matching what TablePlus/Postman/Mailpit users already expect, and it keeps each tool useful on its own, not just as a satellite of the correlation feature.

The correlation feature is not a fifth tab. It's a "What happened" rollup attached directly to the fired request in the API tab (below/beside the response): a condensed summary (e.g. "3 DB writes, 12 log lines, 1 email") with jump-links that deep-link into the relevant tab, pre-filtered/scrolled to the relevant rows. This mirrors how Chrome DevTools links Network entries to Console/Application panels rather than merging everything into one view — it keeps each tool's depth intact while making the correlation impossible to miss, since it appears exactly where the triggering action happened.

### Shell and sessions

Three-column shell: sessions sidebar → main content (the four-tab hybrid above) → chat dock. Sessions are a pure organizational/history layer — never a view restriction; a session's type badge is auto-inferred for scanning/search, not a gate on which tools are visible. This was chosen over two alternatives explored and rejected (see below): scoping a session to a single tool type, and a command-palette-driven variant of the same restriction. The chat dock is collapsible and resizes the content column when toggled, never overlays it.

**Split view:** within the main content area, a "Split" control divides it into two independently-tabbed panes — any of the four tools in either pane — following VS Code's split-editor pattern. Answers the case where more than one tool needs to be visible at once (e.g. watching the DB update live while firing requests) without a fixed, hardcoded pairing.

## Architecture

- **Shell:** Tauri. Rust commands handle: Postgres connection + snapshot/diff, the SMTP server (email catcher), file/stdout tailing, and request execution.
- **Frontend:** React, consuming `packages/ui-shared` for nav/chat/settings.
- **State:** connections (DB + log source + SMTP port), watched-table selections, and request history are stored locally (SQLite or flat files in the app data directory) — no backend dependency in v1.
- **Correlation engine:** on request fire — snapshot watched tables (transaction-scoped read) → send the request → wait for the response → re-snapshot watched tables → collect log lines timestamped within the correlation window (default 5s post-response, configurable in Settings) → collect any SMTP messages received in that window → diff and bundle into the rollup.

## Components

- **Sessions sidebar:** history/organization layer for named investigations; auto-inferred type tags for scanning, never a view restriction. A "Settings" button pinned to its bottom is the only entry point into Settings — not a topbar icon, to avoid two ways in.
- **Settings:** a full navigation destination (swaps out the sessions/tools/chat body entirely), not an overlay — a 4-section surface doesn't fit a compact modal, and app-wide config isn't scoped to any session the way the four tools are. Uses the same list-nav-plus-detail pattern as everything else: General (theme, correlation window, SMTP port), Provider (BYOK key + model), MCP (configured server list with connection status), Archive (restore removed sessions).

All four tools follow the same internal pattern for consistency: a list sidebar on the left, detail on the right — this wasn't a day-one decision, it emerged once DB (table tree) and Email (inbox) were built and API/Log were noticed as inconsistent with them.

- **API tab:** a request-history sidebar (method, path, status, relative time) alongside the request builder, response pane, and inline "What happened" rollup with deep-links.
- **DB tab:** connection tree, schema browser, query editor, data grid. Also where watched tables are toggled on/off.
- **Log tab:** a sources sidebar listing configured log sources (file paths or stdout pipes), each independently browsable — not a single active source with an inline picker. Live tail, search/filter apply to whichever source is selected.
- **Email tab:** inbox list, message viewer (headers/body/raw).
- **Settings** (shared): AI key (BYOK), correlation window duration, SMTP port.

## Error handling

- DB snapshot fails mid-diff (e.g. connection drop) → the rollup shows "DB: unable to verify," never a false "0 writes." A failure must never read as "nothing happened."
- Log source becomes unreadable or rotates mid-tail → a visible warning appears in the Log tab; lines are never silently dropped without indication.
- SMTP port already bound (e.g. Mailhog also running locally) → DevBench fails fast at startup with a clear "port 1025 in use" message and a shortcut into Settings to change the port, rather than silently running a non-functional catcher.

## Testing

- Unit tests around the diff/correlation logic — the most valuable and most bug-prone piece — run against a real local Postgres in CI, not a mock, consistent with treating integration-shaped logic as needing a real dependency.
- Component tests for each of the four tabs.
- One end-to-end smoke test: fire a request against a seeded local Postgres + SMTP catcher, assert the rollup shows the expected diff.

## Post-v1 roadmap (not committed, sequencing only)

Evaluated by fit with the correlation engine (does it plug into "before/after diff" or "observed in window" with near-zero new architecture) and instrumentation cost:

1. **Outbound HTTP / webhook inspector** (top pick for the tool added after v1) — captures calls DevBench's target backend makes to third parties; reuses most of the API tab's response-viewer UI, no new protocol diversity.
2. **Background jobs / worker queue visibility** (Sidekiq/BullMQ/Celery-class) — high value (surfaces the async side effects that are often the actual debugging mystery) but more integration surface, since job systems don't share an introspection API.
3. **Cache inspector (Redis)** — same before/after diff shape as the DB tab, applied to keys instead of rows.
4. **AI/LLM call inspector** — captures prompts/completions/token cost per request if the target backend calls an LLM API. Thematically strong given the rest of the suite is AI-tooling-focused, but narrower applicability than jobs/webhooks.
5. Lower priority: message queue inspector (Kafka/RabbitMQ — protocol-diverse), object storage inspector (narrow, upload-only use case), JWT/session inspector (cheap, but belongs as an API-tab feature rather than a new tool), GraphQL-aware API mode (depends on target ICP).
6. Rejected direction: feature-flag inspector and env/secrets diff viewer (don't reinforce the correlation differentiator), container/infra observability (scope creep into an already-crowded, different category served by Docker Desktop/Datadog-class tools).

## Visual direction

See `DESIGN.md` at the repo root — written from the built mockups (interactive HTML prototypes of the app shell, API tab, and session sidebar variants), superseding this section's earlier provisional brief. Summary: monochrome (no accent hue — inversion only), dark-primary with fully independent light support, ghosty persistent chrome with glass reserved for transient overlays only, OS-native system sans + Commit Mono target, an original mark encoding the correlation mechanic. The provisional blue-accent, Geist-based direction originally drafted here was iterated away after review against real screens — both choices read as generic/templated once actually rendered, which text-only description hadn't surfaced.

## Open questions for implementation planning

- Confirm "Log" means tailing the target backend's own log output (file/stdout), not DevBench's internal request history — this was an explicit assumption during design, not yet independently confirmed against a real target backend.
- Exact local storage format for request history/connections (SQLite vs flat files) is unresolved — pick during planning based on query needs (e.g. searching history) versus simplicity.
