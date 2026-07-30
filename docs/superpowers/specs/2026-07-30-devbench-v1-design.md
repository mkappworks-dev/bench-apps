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

AI narration is deferred deliberately: it's a layer on top of a working rollup, not a prerequisite. Shipping the raw correlated view first validates whether the underlying data is useful before investing in narration.

### Explicitly rejected for v1 (not just deferred — reconsidered and cut)

- **Fully separate tabs with no automatic correlation** and **a single fully-merged timeline replacing per-tool tabs** were both considered as the app's information architecture and rejected in favor of a hybrid (see below): the former makes the differentiator easy to ignore (a 5th tab nobody checks), the latter weakens each tool as a standalone deep-dive surface.
- **OpenTelemetry trace-based correlation** and **DB query-log tailing** were considered as the correlation mechanism and rejected in favor of before/after table snapshots: both require backend cooperation (existing tracing instrumentation, or elevated/managed DB log access) that most early-stage target users won't have. Before/after diffing works immediately against any Postgres connection with zero backend changes.
- **Additional tool categories** (cache/Redis inspector, background jobs, outbound HTTP/webhook inspector, AI/LLM call inspector, message queues, object storage, feature flags, container/infra stats) were evaluated as candidates for the DB/API/Log/Email lineup and deliberately excluded from v1 to keep scope shippable. See Roadmap below — this is not a rejection of the ideas, just a sequencing decision.

## Information architecture

Hybrid: each of the four tools (API, DB, Log, Email) has a full, independent tab for its browse/manage mode — this is the familiar, power-user-friendly surface matching what TablePlus/Postman/Mailpit users already expect, and it keeps each tool useful on its own, not just as a satellite of the correlation feature.

The correlation feature is not a fifth tab. It's a "What happened" rollup attached directly to the fired request in the API tab (below/beside the response): a condensed summary (e.g. "3 DB writes, 12 log lines, 1 email") with jump-links that deep-link into the relevant tab, pre-filtered/scrolled to the relevant rows. This mirrors how Chrome DevTools links Network entries to Console/Application panels rather than merging everything into one view — it keeps each tool's depth intact while making the correlation impossible to miss, since it appears exactly where the triggering action happened.

## Architecture

- **Shell:** Tauri. Rust commands handle: Postgres connection + snapshot/diff, the SMTP server (email catcher), file/stdout tailing, and request execution.
- **Frontend:** React, consuming `packages/ui-shared` for nav/chat/settings.
- **State:** connections (DB + log source + SMTP port), watched-table selections, and request history are stored locally (SQLite or flat files in the app data directory) — no backend dependency in v1.
- **Correlation engine:** on request fire — snapshot watched tables (transaction-scoped read) → send the request → wait for the response → re-snapshot watched tables → collect log lines timestamped within the correlation window (default 5s post-response, configurable in Settings) → collect any SMTP messages received in that window → diff and bundle into the rollup.

## Components

- **Nav** (shared): switches between API / DB / Log / Email tabs and Settings.
- **API tab:** request builder, response pane, inline "What happened" rollup with deep-links.
- **DB tab:** connection tree, schema browser, query editor, data grid. Also where watched tables are toggled on/off.
- **Log tab:** source picker (file path or stdout pipe), live tail, search/filter.
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

## Visual direction (provisional)

Captured ahead of any screens existing, per impeccable's Operate-mode guidance (`operate.md`) and the color-strategy framework in `new-work.md`. This is deliberately provisional — impeccable's own process writes the durable `DESIGN.md` from the built UI, not before it, so this section should be treated as a brief, not a rulebook, and is expected to be superseded once real screens exist.

- **Color strategy:** Restrained (neutral scale + one accent) — the default `new-work.md` prescribes for a visitor who "came to operate," and matches the chosen direction below.
- **Direction:** Neutral minimal, Linear/Vercel-style — chosen over a dark-first hacker/terminal identity and a per-tool color-coded identity (see rejected alternatives in the scope section above). Supports both light and dark, following OS preference; neither is the "identity," unlike the dark-first alternative that was passed over.
- **Type:** One family carries headings, labels, body, and UI per `operate.md` ("Product UIs don't need display/body pairing"). Geist + Geist Mono — not Inter (the discouraged default), and a natural fit given "Vercel-style" was the named reference and Geist is Vercel's own typeface. Fixed rem scale (not fluid), tighter step ratio (~1.125–1.2) than a marketing surface would use.
- **Accent:** A single saturated blue, not violet/purple — deliberately avoiding the "AI-purple" default both installed design skills flag, and avoiding green/amber/red since those are reserved for semantic states (success/warning/error) and would collide with the accent if reused for primary actions or selection.
- **Density:** Moderate-dense, not airy — DevBench's content (request/response bodies, data grids, log lines) is data-heavy, and `operate.md` explicitly permits density ("tables with many rows... dense information when users need it") over a sparser marketing-surface feel.
- **Motion:** 150–250ms, state-conveying only (loading, feedback, reveal) — no orchestrated entrance sequences; per `operate.md`, "users are in flow; don't make them wait for choreography."
- **Corner radius:** one consistent scale across the app (exact value TBD when screens are built) rather than mixing sharp and soft — per the shape-consistency principle both installed skills independently flag as a common AI-generated-UI tell.

## Open questions for implementation planning

- Confirm "Log" means tailing the target backend's own log output (file/stdout), not DevBench's internal request history — this was an explicit assumption during design, not yet independently confirmed against a real target backend.
- Exact local storage format for request history/connections (SQLite vs flat files) is unresolved — pick during planning based on query needs (e.g. searching history) versus simplicity.
