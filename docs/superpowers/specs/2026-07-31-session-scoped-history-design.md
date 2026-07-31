# DevBench v1.1 — Session-Scoped Request History Design Spec

Date: 2026-07-31
Status: Approved for planning

## Context

v1 shipped Sessions as an organization-only layer. There is no `session_id` anywhere in the schema: `request_history` (`0001_init.sql`) has no session column, `HistorySidebar.tsx` calls `invokeListHistory()` with no filter and shows every request ever fired, and `activeSessionId` in the Zustand store does nothing but highlight a row in `SessionsSidebar.tsx`. Selecting a session changes which row looks selected and nothing else.

This spec makes a session actually scope what you see: switching sessions shows a different request history.

### Relationship to v1's "Decision 6"

`docs/superpowers/plans/2026-07-30-devbench-v1-shell.md` Decision 6 states "sessions organize, they never restrict... a session's type badge is auto-inferred for scanning, never a gate on which tools are visible."

**That decision is not reopened here.** It is about *tool visibility* — all four tabs (API/DB/Log/Email) remain available in every session, and a session's `kind` remains an auto-inferred scanning tag, never a gate. Scoping request history is orthogonal: it changes which rows a tool lists, not which tools exist. The v1 design spec's own rejection of "scoped sessions" was likewise about restricting *which tool is visible*, chosen at session creation — not about history.

Decision 6's Task 3 rationale *did* separately rule on watched tables ("a watched table belongs to a database, not to an investigation"). That ruling is **reaffirmed**, not overturned — see Non-Goals.

## Scope

| In scope | Out of scope |
|---|---|
| `request_history` gains a nullable `session_id` | Scoping `watched_tables` (reaffirms Decision 6 Task 3) |
| History list filtered by the active session | An "All / this session" toggle while a session is active |
| Correlated + direct save paths tag rows with the active session | Auto-inferring session `kind` from fired requests |
| Active session persists across restarts | Backfilling existing rows into any session |
| Distinct empty-state copy in the History sidebar | Multi-connection support (still absent; see below) |

**Multi-connection is confirmed absent.** `DEV_CONNECTION` is a literal object duplicated in `App.tsx`, `ApiTab.tsx`, and `DbTab.tsx`; there is no connections table and no UI to edit host/port/database. `watched_tables.connection_key` therefore only ever holds one value in practice. The "two sessions share a DB connection and see different watched sets" scenario has no UI able to trigger it, which is part of why watched-table scoping stays out.

## Data model

```sql
-- 0003_session_scoped_history.sql
ALTER TABLE request_history
  ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX idx_request_history_session_fired_at
  ON request_history (session_id, fired_at DESC);
```

Three properties of this statement were verified empirically against real SQLite, not assumed:

1. **The `ALTER TABLE` is legal.** SQLite permits a `REFERENCES` clause on an added column only when its default is NULL. A nullable column with no default qualifies.
2. **Existing rows land as NULL** automatically, which is exactly the intended "unattributed" state — no backfill step, no synthetic session.
3. **`ON DELETE SET NULL` actually fires.** This depends on `PRAGMA foreign_keys`, which SQLite defaults to **OFF**. sqlx-sqlite 0.8.6 turns it ON in its default pragma set (`options/mod.rs:185`), and `local_db.rs` connects via a URL string that inherits those defaults. Had this gone the other way, the FK would have been decorative and the hard-delete behaviour below silently unimplemented — rows would keep dangling ids pointing at a deleted session.

The index is composite and ordered rather than a bare `(session_id)`, because the scoped query is `WHERE session_id = ? ORDER BY fired_at DESC LIMIT 50` — a single-column index would filter but still force a sort. It costs nothing to get right at creation time.

`watched_tables` is unchanged.

### What NULL means

`NULL` = **unattributed**. Such a row appears in the unscoped view and in no named session.

Rows are NULL in exactly two cases: they predate this migration, or they were fired while no session was active. Both are the same thing conceptually — a request not filed under any investigation — so they get the same treatment rather than being distinguished.

The rejected alternatives, recorded so they are not re-proposed:

- *NULL shows in every session* — every session's history would be polluted with every unfiled request, undermining the point of scoping.
- *Synthetic default session* — forces a fabricated session the user never created into the sidebar, and requires deciding what a no-session request attaches to.

## Behaviour

### Reading history

`list_history_impl(pool, session_id: Option<&str>)`:

- `None` → today's query unchanged: newest 50 rows, no filter. This is the unscoped "All" view.
- `Some(id)` → the same, plus `WHERE session_id = ?`.

No active session means the unscoped view, which is byte-for-byte today's behaviour. Selecting a session filters; deselecting returns to All. There is deliberately no toggle to view All while a session is selected — selection is the only control, matching how the sidebar already behaves.

### Switching sessions clears the response pane

`ApiTab` holds the current response and its "what happened" rollup in local state that is reset only when a new request is fired (`ApiTab.tsx:44`, inside `handleSendStart`). Nothing resets it when the session changes.

Left alone, switching from session A to session B would refresh the History sidebar to B's requests while the main pane — the largest, most prominent region — still showed A's response and A's rollup. The rollup would then be narrating "what happened" for a request that does not appear anywhere in the visible history. That is a false attribution of effects to the wrong investigation, which matters more here than ordinary staleness because the rollup is the product's core claim.

Switching the active session therefore clears `result` and `error` in `ApiTab`, returning the pane to its initial empty state. Selecting an entry from the (now scoped) history repopulates it as usual.

### Writing history

`HistoryEntryInput` gains `session_id: Option<String>`, threaded through `save_correlation_history` and the `run_correlated_request(…, session_id: Option<String>)` command from the frontend's currently-active session. The standalone `save_history_entry` command picks the field up automatically, since it already takes a `HistoryEntryInput`.

The Tauri read command becomes `list_history(session_id: Option<String>)`, delegating to `list_history_impl` per the codebase's established thin-wrapper split.

Firing a request with **no active session works exactly as it does today** — it is not an error, does not force session creation, and does not auto-create one. The row simply lands as NULL and is visible in the unscoped view.

### Deleting a session

Permanent delete (Settings > Archive) uses `ON DELETE SET NULL`: the session's history rows survive and fall back into the unscoped view, exactly like pre-migration rows.

The user deleted a label, not a request log. Cascade-deleting was rejected because it would make a button whose stated job is removing a session silently destroy request data, with no warning in the current Archive UI.

### Archiving and restoring

**This requires no new code, and is specified so the existing behaviour is not mistaken for a gap.**

Archiving sets `archived_at` and touches no history rows. `SessionsSidebar.tsx:44` already clears `activeSessionId` when the active session is archived, so the view falls back to unscoped — where that session's rows remain visible, since nothing was hidden at the data layer.

Restoring returns the session to the sidebar; selecting it shows precisely the history it had. Nothing needs "bringing back" because nothing was ever removed. A round-trip test locks this in.

### Persisting the active session

The active session id is stored under the key `active_session_id` in the existing `settings` key/value table — no migration, since that table already accepts arbitrary keys. `AppSettings` gains `active_session_id: Option<String>`, so it is read through the existing `invokeGetSettings()` rather than a new command, and written with the existing `invokeSetSetting("active_session_id", id)`. It is written from `SessionsSidebar` on every path that changes the selection: selecting a session, creating one (which auto-selects), and archiving the active one (which clears it).

Without this, every restart drops the user into the unscoped view, which reads as "my session's history vanished" — the exact confusion this feature exists to remove.

**Reconciliation on launch:** the stored id may point at a session that has since been archived or hard-deleted. `SessionsSidebar` already owns the active-session list, so it reconciles there: select the stored id if it appears in that list; otherwise clear both the store value and the stored setting. This keeps `settings.rs` from having to know about sessions.

Two ordering constraints make this correct rather than racy:

- Reconciliation must run **after the active-sessions list has resolved**, not in a parallel effect. The stored id can only be validated against a list that exists; checking it against an empty in-flight list would clear a perfectly good selection on every launch.
- It must run **once**. `refresh()` is also called after create and archive, and re-reconciling then would overwrite the user's current selection with the launch-time stored value. A one-shot guard (a ref, not state, so it cannot itself trigger a render) gates it.

Because reconciliation calls the same `setActiveSessionId` the user's clicks do, persistence stays in the explicit handlers rather than a blanket effect watching `activeSessionId` — otherwise launch reconciliation would immediately rewrite the value it just read.

## Components

Frontend data flow follows the existing pattern in `ApiTab.tsx`: the container reads the store once and passes values down as props, keeping leaf components pure and testable (as `watchedTables` and `connection` already do).

| Component | Change |
|---|---|
| `ApiTab.tsx` | Reads `activeSessionId`; passes it to `RequestBuilder` and `HistorySidebar`; clears `result`/`error` when it changes |
| `RequestBuilder.tsx` | Accepts `sessionId`, forwards it to `invokeRunCorrelatedRequest` |
| `HistorySidebar.tsx` | Accepts `sessionId`; adds it to the fetch effect's deps so switching sessions refetches; distinct empty-state copy |
| `SessionsSidebar.tsx` | Persists the active session; reconciles the stored id against the active list on first load |
| `lib/tauri.ts` | `invokeListHistory(sessionId)`, `sessionId` on `invokeRunCorrelatedRequest` |

### Empty state

The sidebar currently renders nothing when the list is empty. Since creating a session auto-selects it (`SessionsSidebar.tsx:34`), the user would land on a blank panel with no explanation — indistinguishable from a broken fetch.

Two distinct messages: in a session, "No requests fired in this session yet."; unscoped, "No requests yet." This is PRODUCT.md principle 4 ("a failure to observe is never displayed as 'nothing happened'") applied to a UI absence rather than a correlation result.

## Error handling

- A failed history fetch keeps today's behaviour: an empty list, rejection handled, no crash.
- Reconciliation failures (settings read fails, sessions list fails) degrade to "no active session" — the unscoped view — never to a broken selection pointing at a session that isn't there.
- Persisting the active session is best-effort; a failed write must not block the selection itself, since the in-memory selection is what the current view depends on.

## Testing

Rust:
- `list_history_impl` with `Some(id)` returns only that session's rows; with `None` returns all rows including NULL ones.
- A NULL row never appears in a named session's view.
- Deleting a session leaves its history rows **present with `session_id IS NULL`**. This is the sharpest test in the plan: asserting only "no rows have a dangling id" would pass even with FK enforcement off, since the rows would be gone or dangling either way. It must assert both survival and nulling.
- Archive → restore round trip preserves the session's scoped history.
- The correlated save path persists the `session_id` it was given, and persists NULL when given none.

Frontend:
- `HistorySidebar` refetches when `sessionId` changes.
- Empty-state copy differs inside a session vs unscoped.
- `RequestBuilder` forwards `sessionId` to the invoke.
- `SessionsSidebar` clears a stored id that names an archived/absent session, and does not re-reconcile after a later refresh.
- `ApiTab` clears a displayed response when the active session changes.

### Existing tests this ripples into

Widening the `AppSettings` TypeScript interface breaks every test that builds one as an object literal: `App.test.tsx:9`, `GeneralPane.test.tsx:9`, `SettingsScreen.test.tsx:8`. Each needs the new field.

`vitest run` will **not** catch this — it does not typecheck. The gate is `tsc`, which runs only under `bun run build`. Verification therefore requires `bun run build` (or `tsc --noEmit`) in addition to the two test suites, or the break ships silently green.

Existing `SessionsSidebar` tests do not mock `invokeGetSettings`, but `src/test-setup.ts` mocks Tauri's `invoke` globally to resolve `[]`, so the new settings read degrades to "no stored id" and those tests keep passing unchanged.

## Non-goals

**Watched tables stay connection-scoped.** Decision 6 Task 3's reasoning holds: a watched table is a property of the database, not of an investigation. Two sessions pointed at the same database should observe the same tables — the correlation rollup's meaning depends on what is being watched in that database, not on which named investigation happens to be selected. Scoping it would also require defining cross-session semantics for a multi-connection world that does not exist yet.
