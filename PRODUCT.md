# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Inferred: DevBench is a Tauri desktop app, but its interface is a standard web-tech webview (React + CSS), so it follows web design conventions, not native iOS/Android ones. -->

## Stack

React + Vite frontend, Tauri (Rust) shell. Bun (package manager/workspaces) + Turborepo (task orchestration) for the monorepo. Zustand for state, TanStack Table/Virtual for the DB grid and Log stream, Tailwind CSS v4 for styling (configured against `DESIGN.md`'s tokens, not Tailwind's defaults), Base UI for headless interactive primitives (tabs, toggle groups, selects — fully reskinned, not their default look). Rust side: sqlx for both the user's Postgres connections and DevBench's own local SQLite storage (sessions, archive, request history, connection configs); Rust commands also handle the SMTP catcher, file/stdout tailing, and request execution. Full reasoning for each pick is in the v1 design spec's Tech Stack section. Frontend consumes a shared `packages/ui-shared` component library (nav, AI chat box, settings panel) intended for reuse across a broader family of developer-focused apps; DevBench is the first app built, with the shared layer extracted from its actual needs rather than designed upfront.

## Users

<!-- Inferred from the design conversation, not independently confirmed — please correct if this doesn't match. -->
Primary user: a backend or full-stack developer, working solo or on a small team, debugging their own application locally or against a staging environment. Situation: they've just fired an action (an API request) against their backend and need to understand what it actually did — which database rows changed, what got logged, what emails went out — without manually cross-referencing a separate API client, DB client, log tail, and email catcher. Job: get from "I fired this request" to "here's everything it caused" in one place, fast.

## Product Purpose

DevBench unifies API testing, database browsing, log tailing, and email capture into one local-first workbench, built around a single core action: fire a request, see everything it did. It exists because today that requires stitching together several separate tools (Postman/Insomnia + TablePlus/DBeaver + a log tail + Mailhog/Mailpit) with no connective tissue between them. Success is a developer trusting the "what happened" rollup enough to reach for it first when debugging, instead of manually checking each tool.

## Positioning

The differentiator is not any single tool (API client, DB browser, log viewer, and email catcher each have established, better-resourced competitors on their own). It's the request-correlated "what happened" rollup: firing a request produces a bundled view of the DB writes, log lines, and emails it caused, via time-window correlation requiring zero backend instrumentation (no tracing setup, no code changes beyond pointing SMTP at a local port). A neighboring point tool could not truthfully claim this without becoming a workbench itself.

## Operating Context

- Runs entirely locally; v1 has no backend/cloud dependency.
- Connects to a local or remote PostgreSQL database (v1: Postgres only).
- Tails a log file or stdout pipe from the user's own backend process.
- Runs a local SMTP server (default port 1025) that the user's backend is pointed at to catch outgoing mail, the same integration pattern as Mailhog/Mailpit.
- AI chat feature is bring-your-own-key (BYOK): the user supplies their own Anthropic/OpenAI/etc. API key, stored in OS-native secure storage. No AI narration of the rollup in v1 — that's deferred to v1.1.

## Capabilities and Constraints

- v1 scope: API tab (request builder, response viewer, history sidebar), DB tab (Postgres, schema browser, query editor, data grid, watched-table toggles), Log tab (sources sidebar, live tail, search/filter), Email tab (SMTP catcher, inbox, message viewer), the "What happened" rollup attached to fired requests with deep-links into the other three tabs, and Settings (General, Provider, MCP, Archive) as a dedicated screen.
- MCP support: the AI assistant can call configured MCP servers during a chat — a v1 capability, not deferred, even though it's the least load-bearing of the four settings areas relative to the core correlation differentiator.
- Session archiving: sessions removed from the active sidebar list are recoverable from Settings > Archive (restore), not permanently deleted — sessions need an archive/restore lifecycle in v1, not just create-and-list.
- Explicitly deferred: other DB engines, request mocking, collections/environments polish, AI narration of the rollup, cloud sync, hosted AI keys, team features (all live in a separate, proprietary cloud layer — not part of DevBench itself).
- Correlation window is time-based (default 5s post-response, configurable), not trace-based — this is a deliberate v1 trade-off for zero-instrumentation setup, not a technical limitation to hide from the design.
- Failure states must never read as false negatives: an unverifiable DB snapshot must show "unable to verify," never "0 writes."
- Sessions (a sidebar history/organization layer for named investigations) never restrict which tools are visible — a session's type is an auto-inferred tag for scanning, not a gate. Split view lets any two tools be open side by side within one session.

## Brand Commitments

Product name: DevBench. Part of a broader toolset sharing common UI components (navigation, AI chat, settings) across a small family of developer-focused apps. MIT-licensed and local-first; a separate proprietary cloud layer (sync, hosted AI keys, teams) is planned but out of scope for v1.

## Evidence on Hand

None yet — no real users, testimonials, screenshots, or brand assets exist at this stage. Future work must not fabricate customer quotes, logos, or usage metrics.

## Product Principles

1. The correlation feature is the product — every design decision should make "what happened" easier to trust and act on, not just easier to notice.
2. Zero-instrumentation first — v1 must work against a real backend the user hasn't modified (beyond one SMTP config line), never require adopting a new tracing/logging convention.
3. Each tool (API/DB/Log/Email) must remain fully useful standalone, not just as a satellite of the rollup — this is a workbench, not a single-purpose correlation viewer.
4. A failure to observe is never displayed as "nothing happened" — silent false negatives break trust in the core mechanism faster than any missing feature would.
5. Local-first and MIT by default; nothing in DevBench itself should assume or require a network connection or an account.

## Accessibility & Inclusion

No product-specific requirement established yet.
