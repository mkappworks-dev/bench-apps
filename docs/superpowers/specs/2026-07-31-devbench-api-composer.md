# DevBench — API Request Composer Design Spec

Date: 2026-07-31
Status: Draft — pending review

Reference mockup: `docs/mockups/devbench-api-composer.html` (interactive — switch
request tabs, add/remove headers and params, drag-resize the rows box, load a
saved request, send, browse history, toggle the sidebar layout). Built on the
same chrome as `devbench-v2-chrome`'s `docs/mockups/devbench-v2-shell.html`.

## Context

The API tab can only express method + URL:

- `src-tauri/src/commands/request.rs:5-10` — `FireRequestInput` is
  `{method, url, body: Option<String>}`. No headers field exists in Rust at all.
- `request.rs:32-34` — whenever `body` is `Some`, `content-type:
  application/json` is force-set. It is the only header ever sent and cannot
  be overridden.
- `request.rs:12-17` — `FireRequestOutput` is `{status_code, body,
  duration_ms}`. Response headers are discarded entirely.
- `src/components/api/RequestBuilder.tsx` — body is hardcoded `undefined`
  (line 27); no headers, no query params, no auth. The API tab always goes
  through `run_correlated_request` (`commands/correlation.rs:325+`), never
  `fire_request` directly, so widening the request type touches both.
- `migrations/0001_init.sql` — `request_history` is `(id, method, url,
  status_code, response_body, duration_ms, fired_at)`. It stores no request
  body and no headers, so history cannot replay a POST today.

This is a full-stack change: Rust's request/response types, the SQLite schema,
and the composer UI all widen together.

This spec assumes `devbench-v2-chrome`'s shell work has landed: the shared
`Menu` primitive at `src/components/ui/Menu.tsx`, PATCH added to the method
list, and — load-bearing for this spec — tab state persisted per instance via
the `tabs.state` JSON column (an `api` tab's state today is `{ method, url }`).
That work is not respecified here.

## Scope

| In scope | Out of scope |
|---|---|
| Composer: Params / Headers / Body / Auth tabs | Folders, environments, or variables for saved requests |
| Response viewer: Body / Headers sub-tabs | OAuth2 or other advanced auth flows beyond Bearer / Basic / API Key |
| Saved requests: session-scoped, flat list, explicit Save | Multipart / binary / form-data bodies (raw text only: JSON, Text, or None) |
| History widened to store what was actually sent, shown read-only | Import/export (e.g. Postman collections) |
| `saved_requests` table + widened `request_history` columns | Editing or "replaying" directly from History — build it in the composer and save it instead |
| Rename / delete for saved requests | OS-keychain storage for saved-request secrets (see Secrets) |
| | Shipping a user-facing Stacked/Segmented sidebar toggle (ship Stacked only — see Frontend) |

## Data model

### Migration `0004_request_composer.sql`

```sql
ALTER TABLE request_history ADD COLUMN request_headers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request_history ADD COLUMN request_body TEXT;
ALTER TABLE request_history ADD COLUMN response_headers TEXT NOT NULL DEFAULT '[]';

CREATE TABLE saved_requests (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  method      TEXT NOT NULL,
  url         TEXT NOT NULL,
  headers     TEXT NOT NULL DEFAULT '[]',
  body        TEXT,
  body_type   TEXT NOT NULL DEFAULT 'none',
  auth        TEXT NOT NULL DEFAULT '{"type":"none"}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_saved_requests_session_updated
  ON saved_requests (session_id, updated_at DESC);
```

- **`session_id` is nullable with `ON DELETE SET NULL`**, mirroring
  `request_history`'s existing precedent exactly (`0003_session_scoped_history.sql`):
  deleting a session must not destroy saved requests, only unlabel them into
  the unscoped view. This was confirmed during brainstorming — saved requests
  are scoped "like History," including this survival behavior.
- **No `params` column.** Query params fold into `url` at the wire level (see
  Frontend); persisting a separate structured list would create a second
  source of truth for what a saved request actually sends.
- **`headers`, `auth` are JSON text**, matching the existing `mcp_servers.args`
  idiom (`TEXT NOT NULL DEFAULT '[]'`) rather than new tables — a header row
  or an auth config isn't independently queried, only read/written whole.
- **The index is composite and ordered** for the same reason
  `idx_request_history_session_fired_at` is: the scoped read is
  `WHERE session_id = ? ORDER BY updated_at DESC`, and a bare `(session_id)`
  index would filter but still force a sort.
- Existing `request_history` rows land with `request_headers = '[]'`,
  `request_body = NULL`, `response_headers = '[]'` automatically — no
  backfill, same pattern proven for migration 0003.

### Rust wire types (`request.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderPair {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct FireRequestInput {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FireRequestOutput {
    pub status_code: u16,
    pub headers: Vec<HeaderPair>,
    pub body: String,
    pub duration_ms: u64,
}
```

- **`Vec<HeaderPair>`, not a map.** HTTP allows repeated header names (e.g.
  multiple `Set-Cookie`); a map would silently drop duplicates.
- **`#[serde(default)]`** keeps the existing Rust tests that construct
  `FireRequestInput` without a `headers` field (`request.rs:76-99`) compiling
  unchanged.
- **Rust never learns "auth type" or "this header is disabled."** By the time
  a request reaches `fire_request_impl`, the frontend has already folded
  Params into `url`, resolved Auth into a `HeaderPair` (or a query entry), and
  dropped disabled header rows. Rust's job stays "send exactly this."

### `fire_request_impl` changes

- Apply every entry in `input.headers` via `.header(key, value)`, in the
  order given.
- The `content-type: application/json` default (currently unconditional,
  `request.rs:32-34`) becomes conditional: only added when `body.is_some()`
  **and** no header case-insensitively named `content-type` is already
  present in `input.headers`.
- Populate `FireRequestOutput.headers` from `resp.headers()`. A response
  header whose value isn't valid UTF-8 (`HeaderValue::to_str()` can fail) is
  skipped rather than failing the whole request — one odd header shouldn't
  turn a real 200 into an error.

### `run_correlated_request` / history threading

- `CorrelationResult.response` already carries the widened `FireRequestOutput`
  with no further change needed there.
- `HistoryEntryInput` (`history.rs:8-18`) and `save_correlation_history`
  (`correlation.rs:187-205`) both gain `request_headers: Vec<HeaderPair>`,
  `request_body: Option<String>`, `response_headers: Vec<HeaderPair>`,
  serialized to the new JSON columns. The first two come from
  `run_correlated_request`'s existing `request: FireRequestInput` parameter
  (already cloned there for `method`/`url`); the third from
  `result.response.headers`.
- `HistoryEntry` (the read-side struct) gains the same three fields,
  deserialized back out of their JSON columns for the frontend.

### New `saved_requests` commands (new file: `commands/saved_requests.rs`)

```rust
list_saved_requests(session_id: Option<String>) -> Vec<SavedRequest>
create_saved_request(input: SavedRequestInput) -> SavedRequest
update_saved_request(id: String, input: SavedRequestInput) -> SavedRequest
rename_saved_request(id: String, name: String) -> SavedRequest
delete_saved_request(id: String) -> ()
```

`SavedRequestInput` carries the full composer snapshot: `name, session_id,
method, url, headers: Vec<SavedHeaderRow>, body, body_type, auth: SavedAuth`.
`SavedHeaderRow` differs from the wire `HeaderPair` by one field —
`enabled: bool` — since a saved request remembers which rows were checked,
not just which were actually sent. `SavedAuth` is a JSON object shaped exactly
like the composer's Auth tab: `{type, token?, username?, password?, key_name?,
key_value?, key_in?}`.

`rename_saved_request` is a separate command (mirroring the existing
`rename_session(id, name)`) so renaming never touches the other fields.

## Secrets

Saved-request Auth values (bearer tokens, API keys, Basic-auth passwords) are
stored as **plain text** in `saved_requests.auth` — the same posture as
`DbConnectInput.password` today, not the OS-native secure storage the AI
provider key gets (`ProviderStatus.has_key`; the key itself is never sent to
the frontend). This is a deliberate v1 trade-off, confirmed with the user
during brainstorming, not an oversight: these are realistically staging/dev
tokens for a local-first tool, and per-saved-request keychain entries
(created/updated/deleted in lockstep with each SQLite row, plus handling for
keychain-unavailable environments) are meaningfully more plumbing than this
feature otherwise needs.

## Frontend

### Composer state shape (per API tab)

Threads through the `tabs.state` JSON column from the shell work: an `api`
tab's persisted state widens from `{ method, url }` to:

```ts
{
  method: string; url: string;
  params: { key: string; value: string }[];      // folded into `url` at send time, never sent separately
  headers: { key: string; value: string; enabled: boolean }[];
  body: string; bodyType: 'none' | 'json' | 'text';
  auth: { type: 'none'|'bearer'|'basic'|'apikey'; token?: string; username?: string;
          password?: string; keyName?: string; keyValue?: string; keyIn?: 'header'|'query' };
  activeReqTab: 'params'|'headers'|'body'|'auth';
  loadedSavedId: string | null;
  dirty: boolean;
}
```

Persisted debounced at 300ms — same rule the shell spec already applies to URL
keystrokes — since this is the tool's *identifying selection/draft*. **Not**
persisted: the fetched response, and the rows-box resize height (below); both
are ephemeral, matching the shell spec's rule that only a tool's selection is
restored across a restart, never its fetched data or transient UI sizing.

**Reading an old-shaped state is a default-fill, not a migration.** A tab
persisted before this work has `state = {method, url}` only. There is no
migration script for this JSON blob (unlike the SQLite schema, which does get
one) — the frontend's read path fills in every new field's default
(`params: []`, `headers: []`, `body: ''`, `bodyType: 'none'`, `auth: {type:
'none'}`, `activeReqTab: 'headers'`, `loadedSavedId: null`, `dirty: false`)
whenever it's absent, the same way `#[serde(default)]` does on the Rust side.

### Params: the URL is the single source of truth

No `params` field crosses into `FireRequestInput` or any storage. The Params
tab is a structured view over the URL's query string: editing a row rewrites
`url`'s query string; editing the URL field directly re-parses it back into
rows. Chosen over a first-class `query_params` field specifically to avoid a
second source of truth for what a request actually sends — the URL (already
including its query string) is the one thing that's ever sent or stored.

### Headers: enable-checkbox rows in a fixed-height, drag-resizable box

Each row: checkbox + key + value + delete. Unchecked rows stay in the
composer/saved request but are excluded from what's actually sent — useful
for temporarily disabling e.g. an `Authorization` header without retyping it.

The row list sits in a fixed-height box (168px default, scrollable) rather
than growing and pushing the rest of the composer down as headers accumulate.
Height is adjusted via a centered drag handle directly below the box — not a
browser-native corner resize handle, which only appears bottom-right and was
explicitly rejected in favor of a bottom-center grip. The same box applies to
the Params tab's row list.

### Body: type selector + raw textarea

`None | JSON | Text`. `None` disables the textarea (grayed, sends no body).
No dedicated JSON syntax highlighting or validation in v1 — a raw
`<textarea>`, matching `ResponseViewer`'s existing raw `<pre>` and the
codebase's current "no code-editor dependency" posture.

### Auth: compiles into a header or query param, never a separate wire concept

`None | Bearer Token | Basic Auth | API Key` (API Key targets either a header
or a query param). A preview line under the fields states exactly what gets
added — e.g. `Adds header Authorization: Bearer sk_••••27` — masking all but
a few characters of the secret. At send time this resolves into a
`HeaderPair` (or a query param, for API Key configured that way), merged with
the Headers tab's enabled rows. Auth is UI sugar over the same Headers/Params
mechanism the rest of the composer uses, never a third wire-level concept —
Rust has no notion of "auth type."

### Response viewer: Body / Headers sub-tabs

`ResponseViewer` gains a small tab switch next to the status pill/duration;
Headers renders `response.headers` as a key-value table. When displaying a
History entry (not a live send), a read-only disclosure — native `<details>`,
"Sent: POST /orders · 2 headers · 118B body" — sits above the response,
expandable to show exactly what was sent. History now stores that, so
surfacing it costs nothing and answers "what did I actually send that time"
without making History itself editable.

### Saved requests: session-scoped, flat, explicit save

- The sidebar (extends `HistorySidebar.tsx`) gets a "Saved" section above
  "History," both scoped to `activeSessionId` exactly like History already is
  (`Some(id)` / `None`-unscoped semantics, unchanged).
- **Flat list, no folders**, sorted by `updated_at DESC`. Each row shows name
  + method/url subtitle; hovering reveals a "⋯" button (shared `Menu`
  primitive) with Rename / Delete. Delete confirms via a plain
  `window.confirm()` — there is no themed confirm dialog anywhere else in this
  codebase yet, so this isn't a step down in polish.
- Clicking a Saved row loads its full snapshot into the composer
  (`loadedSavedId` set, `dirty` false). Editing any field sets `dirty = true`
  and shows a small "● unsaved changes" pill next to an "Editing saved
  request *Name*" label.
- **Sending never saves.** Save is an explicit button next to Send. The first
  save on a tab with no `loadedSavedId` prompts for a name and creates a row;
  a later Save on the same tab overwrites that row in place. This was chosen
  specifically so a quick exploratory edit (e.g. temporarily changing an id
  to test something) can be sent without silently overwriting the saved
  definition.
- Clicking a History row is unrelated to Saved: it only changes what the
  Response viewer shows (today's behavior, unchanged) — History stays
  read-only. There is no "promote history entry to saved request" shortcut;
  to reuse a past request, rebuild it in the composer and Save it.
- **Sidebar layout: ship "Stacked" only** (Saved section, then History
  section, both always visible) — the same rail Postman and Insomnia both
  use for this exact pairing. A "Segmented" single-list-at-a-time variant was
  built and compared live in the mockup but isn't shipped: it's a bigger UI
  surface (a persisted layout preference) for a case the stacked view already
  handles by simply scrolling.

### Component changes

| Component | Change |
|---|---|
| `RequestBuilder.tsx` | Grows from method+url+send into method+url+Save+Send, the four-tab panel, and the resizable row editors. Natural to split into `RequestBar.tsx`, `RequestTabs.tsx`, a shared `KeyValueEditor.tsx` (Params/Headers row list + resize box), `BodyEditor.tsx`, `AuthEditor.tsx` — exact file boundaries are a plan-level call |
| `HistorySidebar.tsx` | Extended with a "Saved" section (or a sibling `SavedRequestsList.tsx` composed alongside it) |
| `ResponseViewer.tsx` | Body/Headers sub-tabs; read-only "Sent" disclosure when displaying a History entry |
| `ApiTab.tsx` | Wires the widened composer state, the Save flow, and a Saved-list refresh key (mirrors the existing `historyRefreshKey`) |
| `lib/tauri.ts` | New types (`HeaderPair`, `SavedRequest`, `SavedRequestInput`); widened `FireRequestInput`/`FireRequestOutput`/`HistoryEntry`; new `invoke*SavedRequest*` functions |

## Testing

Rust:
- `fire_request_impl` sends every provided header; a user-supplied
  `content-type` overrides the JSON default; no default content-type is added
  when there's no body; response headers are captured; a non-UTF8 response
  header is skipped, not fatal.
- `saved_requests` CRUD round-trips through SQLite; deleting a session
  `SET NULL`s its saved requests' `session_id` without deleting the rows
  (mirrors the existing history test proving the same guarantee for
  `request_history`).
- `save_correlation_history` persists request/response headers and request
  body; a database migrated without 0004 (headers/body columns absent) reads
  existing rows back as `[]`/`NULL` — the same pre-migration-database test
  pattern already proven for migration 0003.

Frontend:
- Params rows and the URL field stay in sync in both directions (editing a
  row updates the URL; editing the URL reparses it into rows).
- An unchecked header is present in composer state but absent from the actual
  `invoke` payload.
- Auth preview text matches the selected type and masks the secret.
- Loading a saved request, editing it, and sending does **not** overwrite the
  saved row; pressing Save does.
- A first Save with no `loadedSavedId` prompts for a name and creates a row;
  a later Save on the same tab updates that row instead of creating another.
- Deleting a saved request removes it from the list; renaming updates the
  displayed name without touching its other fields.
- `ResponseViewer` renders the Headers tab from `response.headers`; the
  "Sent" disclosure appears only for a History-sourced response, never a live
  one.

## Suggested split into plans

This is large enough for two implementation plans, in this order — the same
reasoning `devbench-v2-shell-design.md` used to split its own scope:

1. **Real requests** — the Rust wire types (`HeaderPair`, widened
   `FireRequestInput`/`FireRequestOutput`), `fire_request_impl`'s
   conditional content-type, the `request_history` column widening plus its
   threading through `run_correlated_request`/`save_correlation_history`, and
   the composer UI itself: Params/Headers/Body/Auth tabs, the resizable rows
   box, and the Response viewer's Body/Headers split plus the History "Sent"
   disclosure. This alone turns the API tab into a real request tool and is
   useful shipped on its own.
2. **Saved requests** — the `saved_requests` table and commands, the
   sidebar's Saved section, and the load/edit/dirty/Save workflow. Depends on
   plan 1's composer fields already existing to load a snapshot into.

Plan 1 must land first: plan 2's "load a saved snapshot into the composer" has
nothing to load into until Params/Headers/Body/Auth exist.

## Out of scope (recap)

Folders/environments/variables for saved requests, OAuth2 and other advanced
auth flows, multipart/binary bodies, collection import/export, replaying
directly from History, OS-keychain-backed saved-request secrets, and shipping
a user-facing Stacked/Segmented layout toggle (Stacked only).
