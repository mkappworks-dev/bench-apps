# DevBench API Request Composer — Implementation Plan (Plan 1: Real Requests)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the DevBench API tab express a real HTTP request — headers,
query params, a body, and auth — instead of just method + URL, end to end
from the composer UI through `fire_request`/`run_correlated_request` to a
widened `request_history` table and a Body/Headers response viewer.

**Architecture:** Rust widens to a flat wire format (`method, url,
Vec<HeaderPair>, body`) that never knows about "auth type" or a disabled
header row — the frontend composer resolves all of that (Params folded into
the URL, Auth resolved into a header or query entry, disabled headers
dropped) before calling `invoke`. The composer itself splits into small,
independently-testable pieces (`KeyValueEditor`, `BodyEditor`, `AuthEditor`,
`RequestTabs`) composed inside `RequestBuilder`.

**Tech Stack:** React 18 + TypeScript + Tailwind v4 (frontend), Rust + sqlx +
reqwest + Tauri v2 (backend), vitest + @testing-library/react, cargo test +
mockito.

Based on the approved spec: `docs/superpowers/specs/2026-07-31-devbench-api-composer.md`.

## Global Constraints

- Tailwind v4 CSS-first — use existing tokens from `src/styles/tokens.css`
  (`--border`, `--surface`, `--surface-2`, `--bg`, `--text`, `--text-faint`,
  `--text-muted`, `--accent`, `--accent-on`, `--success`/`--success-bg`,
  `--danger`/`--danger-bg`, `--radius-sm`, `--radius-lg`); never introduce new
  ad-hoc colors.
- No native `<select>` changes needed beyond adding `PATCH` to the method
  list (already planned) — Base UI's `Menu` primitive from the
  `devbench-v2-chrome` shell work is **not** in this codebase yet; do not
  reference or depend on it in this plan.
- Comments stay sparse: no multi-paragraph doc blocks, no comments restating
  what the code already says. Only comment non-obvious "why."
- Frontend tests: vitest + @testing-library/react, run via `bun run test`
  from `apps/devbench`. Rust tests: `cargo test`, run from
  `apps/devbench/src-tauri`, using `mockito` for HTTP mocking (the existing
  pattern in `request.rs`/`correlation.rs`).
- The app uses zero Tauri events — everything is `setInterval` + `invoke`
  polling. Nothing in this plan changes that.
- **The URL is the single source of truth for query params.** No `params`
  field ever crosses into `FireRequestInput`, storage, or any Tauri command —
  params are a view over the URL's query string, folded in before sending.
- **Rust never learns "auth type" or "this header is disabled."** By the
  time a request reaches `fire_request_impl`, the frontend has already
  resolved Auth into a `HeaderPair` (or query entry) and filtered out
  disabled header rows.
- **`Vec<HeaderPair>`, never a map**, for headers on the wire — HTTP allows
  repeated header names.
- Per-tab persistence (the `tabs.state` JSON column from the
  `devbench-v2-chrome` shell work) is **out of scope for this plan** — that
  work has not landed in this worktree. Composer state is plain component
  `useState`, exactly like `RequestBuilder.tsx`'s existing `method`/`url`
  state today. Threading it through persisted tab state is integration work
  for later, not this plan.
- Saved requests (the `saved_requests` table, the Save/load/dirty workflow)
  are **out of scope for this plan** — see Follow-on at the end. The spec
  grouped `request_history`'s new columns and the `saved_requests` table into
  one migration (`0004_request_composer.sql`); this plan splits that in two —
  `0004_request_history_headers.sql` here (Task 2), a `0005_saved_requests.sql`
  left for Plan 2 — since shipping an unused table with no consumer until
  Plan 2 serves no purpose in a plan that must stand alone as working,
  testable software.

---

## File Structure

Backend (`apps/devbench/src-tauri/src/commands/`):

| File | Change |
|---|---|
| `request.rs` | New `HeaderPair` struct; widen `FireRequestInput`/`FireRequestOutput`; rewrite `fire_request_impl` to apply headers, conditionally default content-type, and capture response headers |
| `history.rs` | Widen `HistoryEntryInput`/`HistoryEntry` with `request_headers`, `request_body`, `response_headers`; update `save_history_entry_impl`/`list_history_impl` to serialize/deserialize the new JSON columns |
| `correlation.rs` | Widen `save_correlation_history`'s signature; thread the fired request's headers/body and the response's headers through from `run_correlated_request` |
| `../migrations/0004_request_history_headers.sql` (new) | Adds `request_headers`, `request_body`, `response_headers` to `request_history` |

Frontend (`apps/devbench/src/`):

| File | Change |
|---|---|
| `lib/tauri.ts` | New `HeaderPair` interface; widen `FireRequestInput`, `FireRequestOutput`, `HistoryEntry` |
| `components/api/composer/urlParams.ts` (new) | Pure `splitUrlAndParams`/`joinUrlAndParams` — the URL/Params sync logic |
| `components/api/composer/KeyValueEditor.tsx` (new) | Shared Params/Headers row editor: add/remove rows, optional enable-checkbox, fixed-height box with a centered drag-to-resize handle |
| `components/api/composer/BodyEditor.tsx` (new) | Body type select (None/JSON/Text) + textarea |
| `components/api/composer/AuthEditor.tsx` (new) | Auth type select + conditional fields + masked preview line; exports pure `resolveAuthHeader`/`resolveAuthQueryParam`/`authPreview` helpers |
| `components/api/composer/RequestTabs.tsx` (new) | Params/Headers/Body/Auth tab strip, dispatches to the above |
| `components/api/RequestBuilder.tsx` | Rewritten: owns full composer state, builds the final wire request (resolved headers + auth + params-in-url), renders the bar + `RequestTabs` |
| `components/api/ResponseViewer.tsx` | Body/Headers sub-tabs; a read-only "Sent" `<details>` disclosure when showing a History-restored response |
| `components/api/ApiTab.tsx` | `DisplayResult` gains `sentRequest`; `handleHistorySelect` populates it and the widened response; `handleResult` (live send) leaves it `null` |

---

### Task 1: `HeaderPair` + widened request/response types + `fire_request_impl` (Rust)

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/request.rs`

**Interfaces:**
- Produces: `pub struct HeaderPair { pub key: String, pub value: String }` (derives `Debug, Clone, Serialize, Deserialize`); `FireRequestInput { method: String, url: String, headers: Vec<HeaderPair>, body: Option<String> }`; `FireRequestOutput { status_code: u16, headers: Vec<HeaderPair>, body: String, duration_ms: u64 }`. Both later consumed by `history.rs` and `correlation.rs`.

- [ ] **Step 1: Write the failing tests**

Add these to the existing `#[cfg(test)] mod tests { use super::*; ... }` block
at the bottom of `request.rs` (after the existing `rejects_an_invalid_method`
test):

```rust
    #[tokio::test]
    async fn sends_every_provided_header() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .match_header("x-debug", "true")
            .match_header("authorization", "Bearer abc123")
            .with_status(200)
            .with_body("pong")
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            headers: vec![
                HeaderPair { key: "X-Debug".to_string(), value: "true".to_string() },
                HeaderPair { key: "Authorization".to_string(), value: "Bearer abc123".to_string() },
            ],
            body: None,
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.body, "pong");
    }

    #[tokio::test]
    async fn a_user_supplied_content_type_overrides_the_default() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/echo")
            .match_header("content-type", "text/plain")
            .with_status(200)
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/echo", server.url()),
            headers: vec![HeaderPair { key: "Content-Type".to_string(), value: "text/plain".to_string() }],
            body: Some("hello".to_string()),
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.status_code, 200);
    }

    #[tokio::test]
    async fn default_content_type_is_applied_when_body_is_present_and_not_overridden() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/orders")
            .match_header("content-type", "application/json")
            .with_status(201)
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/orders", server.url()),
            headers: vec![],
            body: Some("{}".to_string()),
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.status_code, 201);
    }

    #[tokio::test]
    async fn no_content_type_is_added_when_there_is_no_body() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .match_header("content-type", mockito::Matcher::Missing)
            .with_status(200)
            .with_body("pong")
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            headers: vec![],
            body: None,
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.body, "pong");
    }

    #[tokio::test]
    async fn captures_response_headers() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .with_status(200)
            .with_header("x-request-id", "req_123")
            .with_body("pong")
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            headers: vec![],
            body: None,
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert!(result
            .headers
            .iter()
            .any(|h| h.key.eq_ignore_ascii_case("x-request-id") && h.value == "req_123"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail to compile**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::request`
Expected: compile errors — `HeaderPair` doesn't exist yet, and
`FireRequestInput`/`FireRequestOutput` have no `headers` field.

- [ ] **Step 3: Widen the types and rewrite `fire_request_impl`**

Replace the entire contents of `request.rs` above the `#[cfg(test)]` line
with:

```rust
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use futures::stream::StreamExt;

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

const MAX_BODY_SIZE: usize = 10 * 1024 * 1024; // 10 MiB

pub async fn fire_request_impl(input: FireRequestInput) -> Result<FireRequestOutput, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;
    let method: reqwest::Method = input
        .method
        .parse()
        .map_err(|e| format!("invalid method '{}': {e}", input.method))?;
    let mut req = client.request(method, &input.url);

    let has_content_type = input.headers.iter().any(|h| h.key.eq_ignore_ascii_case("content-type"));
    for h in &input.headers {
        req = req.header(&h.key, &h.value);
    }
    if let Some(body) = &input.body {
        if !has_content_type {
            req = req.header("content-type", "application/json");
        }
        req = req.body(body.clone());
    }

    let started = Instant::now();
    let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status_code = resp.status().as_u16();
    // A response header whose value isn't valid UTF-8 is skipped rather than
    // failing the whole request — one odd header shouldn't turn a real 200
    // into an error.
    let headers = resp
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| HeaderPair { key: name.as_str().to_string(), value: v.to_string() })
        })
        .collect();

    // Read response body with size limit
    let mut body_bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("failed to read response body: {e}"))?;
        body_bytes.extend_from_slice(&chunk);
        if body_bytes.len() > MAX_BODY_SIZE {
            return Err(format!("response body exceeds maximum size of {} bytes", MAX_BODY_SIZE));
        }
    }
    let body = String::from_utf8(body_bytes)
        .map_err(|e| format!("response body is not valid utf8: {e}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    Ok(FireRequestOutput { status_code, headers, body, duration_ms })
}

#[tauri::command]
pub async fn fire_request(input: FireRequestInput) -> Result<FireRequestOutput, String> {
    fire_request_impl(input).await
}
```

- [ ] **Step 4: Fix the two existing tests' struct literals**

The existing `fires_a_get_request_and_reports_status` and
`rejects_an_invalid_method` tests construct `FireRequestInput { method, url,
body }` without `headers`. Run this from `apps/devbench/src-tauri`:

```bash
sed -i '' 's/body: None,$/headers: vec![],\n            body: None,/' src/commands/request.rs
```

If your `sed` isn't BSD (`-i ''` is macOS-specific), use
`sed -i 's/body: None,$/headers: vec![],\n            body: None,/'`
instead. Open the file afterward and confirm both literals now read:

```rust
        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            headers: vec![],
            body: None,
        })
```

and

```rust
        let result = fire_request_impl(FireRequestInput {
            method: "NOT-A-METHOD lol".to_string(),
            url: "http://localhost".to_string(),
            headers: vec![],
            body: None,
        })
        .await;
```

(indentation may not perfectly match after the sed — fix by hand if so; the
compiler will catch any remaining literal missing the field.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::request`
Expected: all 7 tests in `commands::request` pass (2 existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/request.rs
git commit -m "feat(devbench): widen fire_request to carry headers and capture response headers"
```

---

### Task 2: Widen `request_history` + `HistoryEntryInput`/`HistoryEntry` (Rust)

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0004_request_history_headers.sql`
- Modify: `apps/devbench/src-tauri/src/commands/history.rs`

**Interfaces:**
- Consumes: `HeaderPair` from `super::request::HeaderPair` (Task 1).
- Produces: `HistoryEntryInput` and `HistoryEntry` each gain `request_headers:
  Vec<HeaderPair>`, `request_body: Option<String>`, `response_headers:
  Vec<HeaderPair>`. Consumed by `correlation.rs` in Task 3.

- [ ] **Step 1: Write the migration**

Create `apps/devbench/src-tauri/migrations/0004_request_history_headers.sql`:

```sql
-- Widens request_history so it stores what was actually sent, not just the
-- response. JSON text columns match the existing `mcp_servers.args` idiom —
-- a header list isn't independently queried, only read/written whole.
ALTER TABLE request_history ADD COLUMN request_headers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request_history ADD COLUMN request_body TEXT;
ALTER TABLE request_history ADD COLUMN response_headers TEXT NOT NULL DEFAULT '[]';
```

- [ ] **Step 2: Write the failing tests**

Add to `history.rs`'s existing `#[cfg(test)] mod tests { ... }` block, after
the last existing test (`archiving_and_restoring_a_session_preserves_its_scoped_history`):

```rust
    #[tokio::test]
    async fn round_trips_request_and_response_headers_and_body() {
        let (_dir, db) = db().await;

        save_history_entry_impl(
            &db.pool,
            HistoryEntryInput {
                method: "POST".to_string(),
                url: "/api/orders".to_string(),
                status_code: 201,
                response_body: "{\"id\":1}".to_string(),
                duration_ms: 12,
                session_id: None,
                request_headers: vec![HeaderPair { key: "Content-Type".to_string(), value: "application/json".to_string() }],
                request_body: Some("{\"sku\":\"WIDGET-1\"}".to_string()),
                response_headers: vec![HeaderPair { key: "content-type".to_string(), value: "application/json".to_string() }],
            },
        )
        .await
        .unwrap();

        let entries = list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].request_headers,
            vec![HeaderPair { key: "Content-Type".to_string(), value: "application/json".to_string() }]
        );
        assert_eq!(entries[0].request_body.as_deref(), Some("{\"sku\":\"WIDGET-1\"}"));
        assert_eq!(
            entries[0].response_headers,
            vec![HeaderPair { key: "content-type".to_string(), value: "application/json".to_string() }]
        );
    }

    #[tokio::test]
    async fn a_row_with_no_request_body_reads_back_as_none() {
        let (_dir, db) = db().await;

        save_history_entry_impl(
            &db.pool,
            HistoryEntryInput {
                method: "GET".to_string(),
                url: "/api/users/8".to_string(),
                status_code: 200,
                response_body: "{}".to_string(),
                duration_ms: 5,
                session_id: None,
                request_headers: vec![],
                request_body: None,
                response_headers: vec![],
            },
        )
        .await
        .unwrap();

        let entries = list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(entries[0].request_body, None);
        assert_eq!(entries[0].request_headers, vec![]);
        assert_eq!(entries[0].response_headers, vec![]);
    }

    // Mirrors the existing pre-0003 migration test: builds a real database
    // migrated only through 0003, writes a row the way the pre-0004 app did,
    // then opens it through the full migrator (which runs 0004) and confirms
    // the new columns default sensibly rather than the migration failing or
    // losing the row.
    #[tokio::test]
    async fn a_row_written_before_migration_0004_reads_back_with_empty_defaults() {
        use sqlx::migrate::Migration;
        use sqlx::sqlite::SqlitePoolOptions;
        use std::borrow::Cow;

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("devbench.db");
        let url = format!("sqlite://{}?mode=rwc", db_path.display());

        let legacy_pool = SqlitePoolOptions::new().max_connections(1).connect(&url).await.unwrap();

        let mut pre_headers = sqlx::migrate!("./migrations");
        let earlier: Vec<Migration> = pre_headers.migrations.iter().filter(|m| m.version < 4).cloned().collect();
        assert_eq!(earlier.len(), 3, "expected 0001, 0002, and 0003 to precede 0004");
        pre_headers.migrations = Cow::Owned(earlier);
        pre_headers.run(&legacy_pool).await.unwrap();

        let columns: Vec<String> = sqlx::query("PRAGMA table_info(request_history)")
            .fetch_all(&legacy_pool)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        assert!(!columns.iter().any(|c| c == "request_headers"), "this database is not pre-0004: {columns:?}");

        sqlx::query(
            "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("legacy-1")
        .bind("GET")
        .bind("/legacy")
        .bind(200_i64)
        .bind("{}")
        .bind(7_i64)
        .bind("2026-01-01T00:00:00Z")
        .execute(&legacy_pool)
        .await
        .unwrap();
        legacy_pool.close().await;

        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let all = list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(all.len(), 1, "the migration must not drop existing history");
        assert_eq!(all[0].url, "/legacy");
        assert_eq!(all[0].request_headers, vec![]);
        assert_eq!(all[0].request_body, None);
        assert_eq!(all[0].response_headers, vec![]);
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::history`
Expected: compile errors (`HistoryEntryInput`/`HistoryEntry` have no
`request_headers`/`request_body`/`response_headers` fields yet; the migration
file didn't exist when `LocalDb::connect` last compiled against it, but
`cargo` will fail on the Rust struct fields first).

- [ ] **Step 4: Widen the types and update the read/write impls**

In `history.rs`, add the import and widen both structs:

```rust
use crate::local_db::LocalDb;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;
use uuid::Uuid;

use super::request::HeaderPair;

#[derive(Debug, Deserialize)]
pub struct HistoryEntryInput {
    pub method: String,
    pub url: String,
    pub status_code: u16,
    pub response_body: String,
    pub duration_ms: u64,
    /// `None` = unattributed (no active session, or predates session scoping).
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub request_headers: Vec<HeaderPair>,
    #[serde(default)]
    pub request_body: Option<String>,
    #[serde(default)]
    pub response_headers: Vec<HeaderPair>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HistoryEntry {
    pub id: String,
    pub method: String,
    pub url: String,
    pub status_code: i64,
    pub response_body: String,
    pub duration_ms: i64,
    pub fired_at: String,
    pub session_id: Option<String>,
    pub request_headers: Vec<HeaderPair>,
    pub request_body: Option<String>,
    pub response_headers: Vec<HeaderPair>,
}
```

Replace `save_history_entry_impl` with:

```rust
pub async fn save_history_entry_impl(
    pool: &sqlx::SqlitePool,
    entry: HistoryEntryInput,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let fired_at = Utc::now().to_rfc3339();
    let request_headers = serde_json::to_string(&entry.request_headers).unwrap_or_else(|_| "[]".to_string());
    let response_headers = serde_json::to_string(&entry.response_headers).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at, session_id, request_headers, request_body, response_headers) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&entry.method)
    .bind(&entry.url)
    .bind(entry.status_code as i64)
    .bind(&entry.response_body)
    .bind(entry.duration_ms as i64)
    .bind(&fired_at)
    .bind(&entry.session_id)
    .bind(&request_headers)
    .bind(&entry.request_body)
    .bind(&response_headers)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to save history entry: {e}"))?;

    Ok(())
}
```

Replace `list_history_impl` with:

```rust
pub async fn list_history_impl(
    pool: &sqlx::SqlitePool,
    session_id: Option<&str>,
) -> Result<Vec<HistoryEntry>, String> {
    const COLUMNS: &str =
        "SELECT id, method, url, status_code, response_body, duration_ms, fired_at, session_id, \
         request_headers, request_body, response_headers \
         FROM request_history";

    let rows = match session_id {
        Some(id) => {
            sqlx::query(&format!("{COLUMNS} WHERE session_id = ? ORDER BY fired_at DESC LIMIT 50"))
                .bind(id)
                .fetch_all(pool)
                .await
        }
        None => {
            sqlx::query(&format!("{COLUMNS} ORDER BY fired_at DESC LIMIT 50"))
                .fetch_all(pool)
                .await
        }
    }
    .map_err(|e| format!("failed to list history: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| HistoryEntry {
            id: r.get("id"),
            method: r.get("method"),
            url: r.get("url"),
            status_code: r.get("status_code"),
            response_body: r.get("response_body"),
            duration_ms: r.get("duration_ms"),
            fired_at: r.get("fired_at"),
            session_id: r.get("session_id"),
            request_headers: serde_json::from_str(&r.get::<String, _>("request_headers")).unwrap_or_default(),
            request_body: r.get("request_body"),
            response_headers: serde_json::from_str(&r.get::<String, _>("response_headers")).unwrap_or_default(),
        })
        .collect())
}
```

Update the existing `save()` test helper (currently at the top of `mod
tests`, right after `db()`) to:

```rust
    async fn save(pool: &sqlx::SqlitePool, url: &str, session_id: Option<String>) {
        save_history_entry_impl(
            pool,
            HistoryEntryInput {
                method: "POST".to_string(),
                url: url.to_string(),
                status_code: 201,
                response_body: "{}".to_string(),
                duration_ms: 12,
                session_id,
                request_headers: vec![],
                request_body: None,
                response_headers: vec![],
            },
        )
        .await
        .unwrap();
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::history`
Expected: all tests in `commands::history` pass, including the 3 new ones.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src-tauri/migrations/0004_request_history_headers.sql apps/devbench/src-tauri/src/commands/history.rs
git commit -m "feat(devbench): store request/response headers and request body in history"
```

---

### Task 3: Thread headers/body through `run_correlated_request` (Rust)

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`

**Interfaces:**
- Consumes: `HeaderPair` (Task 1), widened `HistoryEntryInput` (Task 2).
- Produces: `save_correlation_history(pool, method, url, request_headers:
  &[HeaderPair], request_body: Option<&str>, response, session_id)` — the new
  signature every caller (including tests) must use.

- [ ] **Step 1: Write the failing test**

Add to `correlation.rs`'s `#[cfg(test)] mod tests { ... }` block, after
`full_correlated_request_flow_persists_a_history_entry`:

```rust
    #[tokio::test]
    async fn a_correlated_request_persists_its_headers_and_body_in_history() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        let conn = test_connection();

        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/orders")
            .with_status(201)
            .with_header("x-request-id", "req_1")
            .with_body("{\"id\":1}")
            .create_async()
            .await;

        let url = format!("{}/orders", server.url());
        let request = FireRequestInput {
            method: "POST".to_string(),
            url: url.clone(),
            headers: vec![HeaderPair { key: "Content-Type".to_string(), value: "application/json".to_string() }],
            body: Some("{\"sku\":\"WIDGET-1\"}".to_string()),
        };
        let method = request.method.clone();
        let request_headers = request.headers.clone();
        let request_body = request.body.clone();

        let result = run_correlated_request_impl(request, conn, vec![], &crate::log_state::LogState::new())
            .await
            .unwrap();
        save_correlation_history(
            &db.pool,
            &method,
            &url,
            &request_headers,
            request_body.as_deref(),
            &result.response,
            None,
        )
        .await;

        mock.assert_async().await;

        let entries = crate::commands::history::list_history_impl(&db.pool, None).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].request_headers,
            vec![HeaderPair { key: "Content-Type".to_string(), value: "application/json".to_string() }]
        );
        assert_eq!(entries[0].request_body.as_deref(), Some("{\"sku\":\"WIDGET-1\"}"));
        assert!(entries[0].response_headers.iter().any(|h| h.key.eq_ignore_ascii_case("x-request-id")));
    }
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run: `cd apps/devbench/src-tauri && cargo test --lib commands::correlation`
Expected: compile error — `save_correlation_history` doesn't accept
`request_headers`/`request_body` arguments yet.

- [ ] **Step 3: Widen `save_correlation_history` and its one production call site**

Replace the function (currently just above `use crate::correlation_state::...`)
with:

```rust
/// Persists a request-history entry for a correlated request that already
/// succeeded. Takes the raw SQLite pool (not a Tauri `State`) so it stays
/// directly unit-testable, matching this codebase's `_impl` convention.
///
/// A failure here is intentionally non-fatal to the caller: the user's actual
/// HTTP request already completed by the time this runs, so we don't want a
/// local SQLite hiccup to fail the whole command. It's not swallowed silently
/// either — it's logged so an empty history sidebar is debuggable.
async fn save_correlation_history(
    pool: &sqlx::SqlitePool,
    method: &str,
    url: &str,
    request_headers: &[HeaderPair],
    request_body: Option<&str>,
    response: &FireRequestOutput,
    session_id: Option<&str>,
) {
    let entry = HistoryEntryInput {
        method: method.to_string(),
        url: url.to_string(),
        status_code: response.status_code,
        response_body: response.body.clone(),
        duration_ms: response.duration_ms,
        session_id: session_id.map(str::to_string),
        request_headers: request_headers.to_vec(),
        request_body: request_body.map(str::to_string),
        response_headers: response.headers.clone(),
    };
    if let Err(e) = save_history_entry_impl(pool, entry).await {
        eprintln!("failed to save request history entry after a successful correlated request: {e}");
    }
}
```

Update the import line at the top of the file:

```rust
use super::request::{fire_request_impl, FireRequestInput, FireRequestOutput, HeaderPair};
```

Update the `run_correlated_request` command's body (clone the headers/body
before `request` is moved into `run_correlated_request_impl_with_registry`,
same reason `method`/`url` are already cloned there):

```rust
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_correlated_request(
    db: State<'_, LocalDb>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    registry: State<'_, Arc<CorrelationRegistry>>,
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
    session_id: Option<String>,
) -> Result<CorrelationResult, String> {
    let method = request.method.clone();
    let url = request.url.clone();
    let request_headers = request.headers.clone();
    let request_body = request.body.clone();
    let window_ms = crate::commands::settings::get_settings_impl(&db.pool)
        .await
        .map(|s| s.correlation_window_ms)
        .unwrap_or(DEFAULT_CORRELATION_WINDOW_MS);
    let result = run_correlated_request_impl_with_registry(
        request,
        connection,
        watched_tables,
        &logs,
        &emails,
        &registry,
        chrono::Utc::now().timestamp_millis(),
        window_ms,
    )
    .await?;
    save_correlation_history(
        &db.pool,
        &method,
        &url,
        &request_headers,
        request_body.as_deref(),
        &result.response,
        session_id.as_deref(),
    )
    .await;
    Ok(result)
}
```

- [ ] **Step 4: Fix every existing `FireRequestInput`/`FireRequestOutput` literal and `save_correlation_history` call in this file**

Every existing `FireRequestInput { ... }` literal in this file (11 of them)
already ends in `body: None`. Every existing `FireRequestOutput { ... }`
literal (3 of them) is written as `status_code: N, body: "...", duration_ms:
N`. Run from `apps/devbench/src-tauri`:

```bash
sed -i '' 's/body: None/headers: vec![], body: None/g' src/commands/correlation.rs
sed -i '' -E 's/(status_code: [0-9]+,) body:/\1 headers: vec![], body:/g' src/commands/correlation.rs
```

(Drop the `''` after `-i` if your `sed` isn't BSD/macOS.)

That fixes every struct literal — Rust's exhaustive field-checking will fail
the build if either sed missed a spot, which the next step catches. It does
**not** fix the 4 existing `save_correlation_history(...)` call sites (they
need 2 new positional arguments inserted, not a field added — sed isn't a
good fit for that, do these by hand):

At line ~359 (inside the `run_correlated_request` command — already rewritten
in Step 3 above, skip).

In `save_correlation_history_writes_a_row_list_history_can_read`, change:

```rust
        save_correlation_history(
            &db.pool,
            "POST",
            "/orders",
            &FireRequestOutput { status_code: 201, headers: vec![], body: "{\"id\":1}".to_string(), duration_ms: 42 },
            None,
        )
        .await;
```

to:

```rust
        save_correlation_history(
            &db.pool,
            "POST",
            "/orders",
            &[],
            None,
            &FireRequestOutput { status_code: 201, headers: vec![], body: "{\"id\":1}".to_string(), duration_ms: 42 },
            None,
        )
        .await;
```

In `full_correlated_request_flow_persists_a_history_entry`, change:

```rust
        save_correlation_history(&db.pool, &method, &url, &result.response, None).await;
```

to:

```rust
        save_correlation_history(&db.pool, &method, &url, &[], None, &result.response, None).await;
```

In `save_correlation_history_attributes_the_row_to_the_active_session`, change:

```rust
        save_correlation_history(
            &db.pool,
            "POST",
            "/orders",
            &FireRequestOutput { status_code: 201, headers: vec![], body: "{}".to_string(), duration_ms: 42 },
            Some(&session.id),
        )
        .await;
```

to:

```rust
        save_correlation_history(
            &db.pool,
            "POST",
            "/orders",
            &[],
            None,
            &FireRequestOutput { status_code: 201, headers: vec![], body: "{}".to_string(), duration_ms: 42 },
            Some(&session.id),
        )
        .await;
```

In `a_request_fired_with_no_active_session_is_saved_unattributed`, change:

```rust
        save_correlation_history(
            &db.pool,
            "GET",
            "/ping",
            &FireRequestOutput { status_code: 200, headers: vec![], body: "pong".to_string(), duration_ms: 3 },
            None,
        )
        .await;
```

to:

```rust
        save_correlation_history(
            &db.pool,
            "GET",
            "/ping",
            &[],
            None,
            &FireRequestOutput { status_code: 200, headers: vec![], body: "pong".to_string(), duration_ms: 3 },
            None,
        )
        .await;
```

- [ ] **Step 5: Run the full backend test suite to verify everything passes**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: every test in the crate passes, including all of `commands::correlation`
and the new `a_correlated_request_persists_its_headers_and_body_in_history`.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/correlation.rs
git commit -m "feat(devbench): persist a correlated request's headers and body in history"
```

---

### Task 4: Widen frontend wire types (`lib/tauri.ts`)

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts:1-49` (the `FireRequestInput`,
  `FireRequestOutput`, `HistoryEntry` interfaces and their surrounding block)

**Interfaces:**
- Produces: `export interface HeaderPair { key: string; value: string }`;
  widened `FireRequestInput { method: string; url: string; headers:
  HeaderPair[]; body?: string }`; widened `FireRequestOutput { status_code:
  number; headers: HeaderPair[]; body: string; duration_ms: number }`;
  widened `HistoryEntry` with `request_headers: HeaderPair[]; request_body:
  string | null; response_headers: HeaderPair[]`.

This file has no dedicated test suite (it's types + thin `invoke` wrappers).
Correctness here is verified by the type checker, not vitest — `vitest run`
does not typecheck, so this task's gate is `bun run build`, not
`bun run test` (this exact caveat bit the session-scoped-history feature
before; don't repeat it).

- [ ] **Step 1: Widen the interfaces**

In `apps/devbench/src/lib/tauri.ts`, replace lines 1-17 with:

```ts
import { invoke } from "@tauri-apps/api/core";

export interface HeaderPair {
  key: string;
  value: string;
}

export interface FireRequestInput {
  method: string;
  url: string;
  headers: HeaderPair[];
  body?: string;
}

export interface FireRequestOutput {
  status_code: number;
  headers: HeaderPair[];
  body: string;
  duration_ms: number;
}

export function invokeFireRequest(input: FireRequestInput): Promise<FireRequestOutput> {
  return invoke("fire_request", { input });
}
```

Replace the `HistoryEntry` interface (currently lines 19-29) with:

```ts
export interface HistoryEntry {
  id: string;
  method: string;
  url: string;
  status_code: number;
  response_body: string;
  duration_ms: number;
  fired_at: string;
  /** `null` = unattributed: fired with no active session, or predating session scoping. */
  session_id: string | null;
  request_headers: HeaderPair[];
  /** `null` = no body was sent. */
  request_body: string | null;
  response_headers: HeaderPair[];
}
```

- [ ] **Step 2: Typecheck and fix every literal it breaks**

Run: `cd apps/devbench && bun run build`

This will fail wherever a `FireRequestInput`/`FireRequestOutput`/`HistoryEntry`
object literal is missing a now-required field. Expect failures in:
`src/components/api/RequestBuilder.tsx` (will be rewritten in Task 10 — leave
it broken for now, it's about to change anyway),
`src/components/api/ApiTab.tsx` (its `handleHistorySelect` builds a
`FireRequestOutput`-shaped literal missing `headers` — left broken until
Task 12 rewrites that function),
`src/components/api/RequestBuilder.test.tsx`,
`src/components/api/ResponseViewer.test.tsx`,
`src/components/api/ApiTab.test.tsx`. Fix only the **test** files now (leave
`RequestBuilder.tsx` and `ApiTab.tsx` themselves — Tasks 10 and 12 rewrite
them):

In `RequestBuilder.test.tsx`, every `response: { status_code, body,
duration_ms }` literal (3 of them, inside the `invokeRunCorrelatedRequest`
mocks) needs `headers: []` added, e.g.:

```ts
    response: { status_code: 201, headers: [], body: '{"id":8841}', duration_ms: 142 },
```

And the one exact-payload assertion:

```ts
    expect(tauriLib.invokeRunCorrelatedRequest).toHaveBeenCalledWith({
      request: { method: "GET", url: "/api/orders", headers: [], body: undefined },
      connection,
      watchedTables: ["orders"],
      sessionId: null,
    }),
```

In `ResponseViewer.test.tsx`, the one `result={{ status_code: 200, body:
'{"id":8841}', duration_ms: 142 }}` literal needs `headers: []` added.

In `ApiTab.test.tsx`, the `sendResult()` helper's `response: { status_code:
201, body, duration_ms: 142 }` needs `headers: []` added, and the
`invokeListHistory` mock's one `HistoryEntry` literal needs `request_headers:
[], request_body: null, response_headers: []` added.

**`bun run build` will still fail after this step, and that's expected.**
`RequestBuilder.tsx` itself still constructs a `FireRequestInput` literal
missing `headers` — deliberately left broken here since Task 10 replaces the
whole file. `bun run test` still passes in the meantime because vitest
transpiles without typechecking; the build only goes green again once Task
10 lands.

- [ ] **Step 3: Run the existing test suite to confirm nothing else broke**

Run: `cd apps/devbench && bun run test`
Expected: all currently-passing tests still pass (vitest doesn't typecheck,
so this alone wouldn't have caught Step 2's breakage — that's exactly why
Step 2's `bun run build` came first).

- [ ] **Step 4: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/components/api/RequestBuilder.test.tsx apps/devbench/src/components/api/ResponseViewer.test.tsx apps/devbench/src/components/api/ApiTab.test.tsx
git commit -m "feat(devbench): widen frontend request/response/history types with headers"
```

---

### Task 5: URL ⇄ Params sync (`urlParams.ts`)

**Files:**
- Create: `apps/devbench/src/components/api/composer/urlParams.ts`
- Test: `apps/devbench/src/components/api/composer/urlParams.test.ts`

**Interfaces:**
- Produces: `splitUrlAndParams(url: string): { base: string; params: {
  key: string; value: string }[] }`; `joinUrlAndParams(base: string, params:
  { key: string; value: string }[]): string`. Consumed by `RequestBuilder.tsx`
  (Task 10).

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/api/composer/urlParams.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitUrlAndParams, joinUrlAndParams } from "./urlParams";

describe("splitUrlAndParams", () => {
  it("splits a url with no query string", () => {
    expect(splitUrlAndParams("/api/orders")).toEqual({ base: "/api/orders", params: [] });
  });

  it("splits a url with a query string into rows", () => {
    expect(splitUrlAndParams("/api/orders?status=pending&limit=20")).toEqual({
      base: "/api/orders",
      params: [
        { key: "status", value: "pending" },
        { key: "limit", value: "20" },
      ],
    });
  });

  it("decodes percent-encoded keys and values", () => {
    expect(splitUrlAndParams("/api/search?q=a%20b")).toEqual({
      base: "/api/search",
      params: [{ key: "q", value: "a b" }],
    });
  });
});

describe("joinUrlAndParams", () => {
  it("returns the base url when there are no params", () => {
    expect(joinUrlAndParams("/api/orders", [])).toBe("/api/orders");
  });

  it("appends encoded params as a query string", () => {
    expect(joinUrlAndParams("/api/orders", [{ key: "status", value: "pending" }])).toBe("/api/orders?status=pending");
  });

  it("percent-encodes keys and values", () => {
    expect(joinUrlAndParams("/api/search", [{ key: "q", value: "a b" }])).toBe("/api/search?q=a%20b");
  });

  it("skips rows with an empty key", () => {
    expect(
      joinUrlAndParams("/api/orders", [
        { key: "", value: "x" },
        { key: "limit", value: "20" },
      ]),
    ).toBe("/api/orders?limit=20");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test urlParams`
Expected: FAIL — `./urlParams` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/devbench/src/components/api/composer/urlParams.ts`:

```ts
export interface UrlParam {
  key: string;
  value: string;
}

export function splitUrlAndParams(url: string): { base: string; params: UrlParam[] } {
  const [base, qs = ""] = url.split("?");
  const params = qs
    ? qs
        .split("&")
        .filter(Boolean)
        .map((pair) => {
          const [k, v = ""] = pair.split("=");
          return { key: decodeURIComponent(k), value: decodeURIComponent(v) };
        })
    : [];
  return { base, params };
}

export function joinUrlAndParams(base: string, params: UrlParam[]): string {
  const qs = params
    .filter((p) => p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test urlParams`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/api/composer/urlParams.ts apps/devbench/src/components/api/composer/urlParams.test.ts
git commit -m "feat(devbench): add pure url/query-param sync helpers for the composer"
```

---

### Task 6: `KeyValueEditor` (shared Params/Headers row editor)

**Files:**
- Create: `apps/devbench/src/components/api/composer/KeyValueEditor.tsx`
- Test: `apps/devbench/src/components/api/composer/KeyValueEditor.test.tsx`

**Interfaces:**
- Produces: `export interface KeyValueRow { key: string; value: string;
  enabled?: boolean }`; `KeyValueEditor({ rows, onChange, showEnabled?,
  addLabel, emptyLabel }: { rows: KeyValueRow[]; onChange: (rows:
  KeyValueRow[]) => void; showEnabled?: boolean; addLabel: string; emptyLabel:
  string })`. Consumed by `RequestTabs.tsx` (Task 9).

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/api/composer/KeyValueEditor.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeyValueEditor } from "./KeyValueEditor";

describe("KeyValueEditor", () => {
  it("shows the empty-state label when there are no rows", () => {
    render(<KeyValueEditor rows={[]} onChange={() => {}} addLabel="Add header" emptyLabel="No headers set." />);
    expect(screen.getByText("No headers set.")).toBeInTheDocument();
  });

  it("adds a row when Add is clicked", () => {
    const onChange = vi.fn();
    render(<KeyValueEditor rows={[]} onChange={onChange} addLabel="Add header" emptyLabel="No headers set." />);
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    expect(onChange).toHaveBeenCalledWith([{ key: "", value: "", enabled: true }]);
  });

  it("removes a row when its remove button is clicked", () => {
    const onChange = vi.fn();
    render(
      <KeyValueEditor
        rows={[
          { key: "a", value: "1", enabled: true },
          { key: "b", value: "2", enabled: true },
        ]}
        onChange={onChange}
        addLabel="Add header"
        emptyLabel="No headers set."
      />,
    );
    fireEvent.click(screen.getAllByLabelText("Remove")[0]);
    expect(onChange).toHaveBeenCalledWith([{ key: "b", value: "2", enabled: true }]);
  });

  it("updates a row's key on input", () => {
    const onChange = vi.fn();
    render(
      <KeyValueEditor
        rows={[{ key: "", value: "", enabled: true }]}
        onChange={onChange}
        addLabel="Add param"
        emptyLabel="No params."
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("key"), { target: { value: "status" } });
    expect(onChange).toHaveBeenCalledWith([{ key: "status", value: "", enabled: true }]);
  });

  it("hides the enabled checkbox when showEnabled is false", () => {
    render(<KeyValueEditor rows={[{ key: "a", value: "1" }]} onChange={() => {}} addLabel="Add param" emptyLabel="No params." />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("toggles a row's enabled flag via its checkbox", () => {
    const onChange = vi.fn();
    render(
      <KeyValueEditor
        rows={[{ key: "a", value: "1", enabled: true }]}
        onChange={onChange}
        showEnabled
        addLabel="Add header"
        emptyLabel="No headers set."
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith([{ key: "a", value: "1", enabled: false }]);
  });

  it("resizes the rows box by dragging its handle", () => {
    render(
      <KeyValueEditor
        rows={[{ key: "a", value: "1", enabled: true }]}
        onChange={() => {}}
        addLabel="Add header"
        emptyLabel="No headers set."
      />,
    );
    const handle = screen.getByTestId("rows-resize-handle");
    const box = screen.getByTestId("rows-box");
    expect(box).toHaveStyle({ height: "168px" });
    fireEvent.mouseDown(handle, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 200 });
    fireEvent.mouseUp(window);
    expect(box).toHaveStyle({ height: "268px" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test KeyValueEditor`
Expected: FAIL — the component doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/devbench/src/components/api/composer/KeyValueEditor.tsx`:

```tsx
import { useRef, useState } from "react";

export interface KeyValueRow {
  key: string;
  value: string;
  enabled?: boolean;
}

const DEFAULT_HEIGHT = 168;
const MIN_HEIGHT = 64;
const MAX_HEIGHT = 420;

export function KeyValueEditor({
  rows,
  onChange,
  showEnabled = false,
  addLabel,
  emptyLabel,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  showEnabled?: boolean;
  addLabel: string;
  emptyLabel: string;
}) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const dragStart = useRef<{ y: number; height: number } | null>(null);

  function updateRow(index: number, patch: Partial<KeyValueRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function addRow() {
    onChange([...rows, { key: "", value: "", enabled: true }]);
  }

  function onHandleMouseDown(e: React.MouseEvent) {
    dragStart.current = { y: e.clientY, height };
    function onMouseMove(ev: MouseEvent) {
      if (!dragStart.current) return;
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragStart.current.height + (ev.clientY - dragStart.current.y)));
      setHeight(next);
    }
    function onMouseUp() {
      dragStart.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div>
      <div style={{ height }} className="overflow-y-auto rounded-lg border border-border p-2" data-testid="rows-box">
        {rows.length === 0 ? (
          <div className="p-1 text-sm text-text-faint">{emptyLabel}</div>
        ) : (
          rows.map((row, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5">
              {showEnabled ? (
                <input
                  type="checkbox"
                  checked={row.enabled ?? true}
                  onChange={(e) => updateRow(i, { enabled: e.target.checked })}
                  aria-label="Include this header when sending"
                />
              ) : null}
              <input
                className="flex-1 rounded-sm border border-border bg-surface px-2 py-1 font-mono text-sm text-text"
                placeholder="key"
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
              />
              <input
                className="flex-1 rounded-sm border border-border bg-surface px-2 py-1 font-mono text-sm text-text"
                placeholder="value"
                value={row.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
              />
              <button type="button" onClick={() => removeRow(i)} aria-label="Remove" className="text-text-faint hover:text-text">
                ✕
              </button>
            </div>
          ))
        )}
      </div>
      <div
        onMouseDown={onHandleMouseDown}
        className="flex h-2.5 cursor-ns-resize items-center justify-center"
        data-testid="rows-resize-handle"
      >
        <span className="h-1 w-9 rounded-full bg-border" />
      </div>
      <button type="button" onClick={addRow} className="mt-1.5 rounded-sm border border-border px-2.5 py-1 text-sm text-text">
        {addLabel}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test KeyValueEditor`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/api/composer/KeyValueEditor.tsx apps/devbench/src/components/api/composer/KeyValueEditor.test.tsx
git commit -m "feat(devbench): add shared key-value row editor for params and headers"
```

---

### Task 7: `BodyEditor`

**Files:**
- Create: `apps/devbench/src/components/api/composer/BodyEditor.tsx`
- Test: `apps/devbench/src/components/api/composer/BodyEditor.test.tsx`

**Interfaces:**
- Produces: `export type BodyType = "none" | "json" | "text"`;
  `BodyEditor({ bodyType, body, onBodyTypeChange, onBodyChange })`. Consumed
  by `RequestTabs.tsx` (Task 9).

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/api/composer/BodyEditor.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BodyEditor } from "./BodyEditor";

describe("BodyEditor", () => {
  it("disables the textarea when body type is none", () => {
    render(<BodyEditor bodyType="none" body="" onBodyTypeChange={() => {}} onBodyChange={() => {}} />);
    expect(screen.getByPlaceholderText("No body for this request")).toBeDisabled();
  });

  it("enables the textarea and shows the body when type is json", () => {
    render(<BodyEditor bodyType="json" body='{"a":1}' onBodyTypeChange={() => {}} onBodyChange={() => {}} />);
    const textarea = screen.getByPlaceholderText("Raw request body") as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    expect(textarea.value).toBe('{"a":1}');
  });

  it("calls onBodyTypeChange when the select changes", () => {
    const onBodyTypeChange = vi.fn();
    render(<BodyEditor bodyType="none" body="" onBodyTypeChange={onBodyTypeChange} onBodyChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Body type"), { target: { value: "text" } });
    expect(onBodyTypeChange).toHaveBeenCalledWith("text");
  });

  it("calls onBodyChange as the textarea is edited", () => {
    const onBodyChange = vi.fn();
    render(<BodyEditor bodyType="text" body="" onBodyTypeChange={() => {}} onBodyChange={onBodyChange} />);
    fireEvent.change(screen.getByPlaceholderText("Raw request body"), { target: { value: "hello" } });
    expect(onBodyChange).toHaveBeenCalledWith("hello");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test BodyEditor`
Expected: FAIL — the component doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/devbench/src/components/api/composer/BodyEditor.tsx`:

```tsx
export type BodyType = "none" | "json" | "text";

export function BodyEditor({
  bodyType,
  body,
  onBodyTypeChange,
  onBodyChange,
}: {
  bodyType: BodyType;
  body: string;
  onBodyTypeChange: (type: BodyType) => void;
  onBodyChange: (body: string) => void;
}) {
  const disabled = bodyType === "none";
  return (
    <div>
      <select
        value={bodyType}
        onChange={(e) => onBodyTypeChange(e.target.value as BodyType)}
        aria-label="Body type"
        className="mb-2.5 rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-bold text-text"
      >
        <option value="none">None</option>
        <option value="json">JSON</option>
        <option value="text">Text</option>
      </select>
      <textarea
        value={disabled ? "" : body}
        onChange={(e) => onBodyChange(e.target.value)}
        disabled={disabled}
        placeholder={disabled ? "No body for this request" : "Raw request body"}
        className="min-h-35 w-full rounded-lg border border-border bg-surface p-2.5 font-mono text-sm text-text disabled:bg-bg disabled:text-text-faint"
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test BodyEditor`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/api/composer/BodyEditor.tsx apps/devbench/src/components/api/composer/BodyEditor.test.tsx
git commit -m "feat(devbench): add request body type selector and editor"
```

---

### Task 8: `AuthEditor`

**Files:**
- Create: `apps/devbench/src/components/api/composer/AuthEditor.tsx`
- Test: `apps/devbench/src/components/api/composer/AuthEditor.test.tsx`

**Interfaces:**
- Produces: `AuthType`, `AuthKeyIn`, `AuthState`, `DEFAULT_AUTH`,
  `authPreview(auth: AuthState): string`, `resolveAuthHeader(auth:
  AuthState): { key: string; value: string } | null`,
  `resolveAuthQueryParam(auth: AuthState): { key: string; value: string } |
  null`, `AuthEditor({ auth, onChange })`. `resolveAuthHeader`/
  `resolveAuthQueryParam` are consumed directly by `RequestBuilder.tsx`
  (Task 10); the rest by `RequestTabs.tsx` (Task 9).

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/api/composer/AuthEditor.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthEditor, DEFAULT_AUTH, authPreview, resolveAuthHeader, resolveAuthQueryParam } from "./AuthEditor";

describe("authPreview", () => {
  it("says no auth is added for type none", () => {
    expect(authPreview(DEFAULT_AUTH)).toBe("No Authorization added — request goes out with only the headers above.");
  });

  it("masks a bearer token", () => {
    expect(authPreview({ ...DEFAULT_AUTH, type: "bearer", token: "sk_live_9fa27dP" })).toBe(
      "Adds header  Authorization: Bearer sk_••••dP",
    );
  });

  it("describes an api key added to a header", () => {
    expect(
      authPreview({ ...DEFAULT_AUTH, type: "apikey", keyName: "X-Api-Key", keyValue: "ak_test_2201", keyIn: "header" }),
    ).toBe("Adds header  X-Api-Key: ak_••••01");
  });

  it("describes an api key added to a query param", () => {
    expect(authPreview({ ...DEFAULT_AUTH, type: "apikey", keyName: "key", keyValue: "abc123456", keyIn: "query" })).toBe(
      "Adds query param  key: abc••••56",
    );
  });

  it("previews basic auth without exposing the raw password", () => {
    const preview = authPreview({ ...DEFAULT_AUTH, type: "basic", username: "admin", password: "hunter2" });
    expect(preview).toContain("Adds header  Authorization: Basic ");
    expect(preview).not.toContain("hunter2");
  });
});

describe("resolveAuthHeader", () => {
  it("returns null for no auth", () => {
    expect(resolveAuthHeader(DEFAULT_AUTH)).toBeNull();
  });

  it("resolves a bearer token to an Authorization header", () => {
    expect(resolveAuthHeader({ ...DEFAULT_AUTH, type: "bearer", token: "abc" })).toEqual({
      key: "Authorization",
      value: "Bearer abc",
    });
  });

  it("resolves basic auth to a Basic Authorization header", () => {
    const result = resolveAuthHeader({ ...DEFAULT_AUTH, type: "basic", username: "u", password: "p" });
    expect(result?.key).toBe("Authorization");
    expect(result?.value).toMatch(/^Basic /);
  });

  it("resolves an api key configured for a header", () => {
    expect(resolveAuthHeader({ ...DEFAULT_AUTH, type: "apikey", keyName: "X-Key", keyValue: "v", keyIn: "header" })).toEqual({
      key: "X-Key",
      value: "v",
    });
  });

  it("returns null for an api key configured for a query param", () => {
    expect(resolveAuthHeader({ ...DEFAULT_AUTH, type: "apikey", keyValue: "v", keyIn: "query" })).toBeNull();
  });
});

describe("resolveAuthQueryParam", () => {
  it("resolves an api key configured for a query param", () => {
    expect(resolveAuthQueryParam({ ...DEFAULT_AUTH, type: "apikey", keyName: "key", keyValue: "v", keyIn: "query" })).toEqual({
      key: "key",
      value: "v",
    });
  });

  it("returns null for an api key configured for a header", () => {
    expect(resolveAuthQueryParam({ ...DEFAULT_AUTH, type: "apikey", keyValue: "v", keyIn: "header" })).toBeNull();
  });
});

describe("AuthEditor", () => {
  it("shows the token field only for bearer auth", () => {
    render(<AuthEditor auth={{ ...DEFAULT_AUTH, type: "bearer" }} onChange={() => {}} />);
    expect(screen.getByPlaceholderText("Bearer token")).toBeInTheDocument();
  });

  it("calls onChange with the new type when the type select changes", () => {
    const onChange = vi.fn();
    render(<AuthEditor auth={DEFAULT_AUTH} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Auth type"), { target: { value: "bearer" } });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_AUTH, type: "bearer" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test AuthEditor`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/devbench/src/components/api/composer/AuthEditor.tsx`:

```tsx
export type AuthType = "none" | "bearer" | "basic" | "apikey";
export type AuthKeyIn = "header" | "query";

export interface AuthState {
  type: AuthType;
  token: string;
  username: string;
  password: string;
  keyName: string;
  keyValue: string;
  keyIn: AuthKeyIn;
}

export const DEFAULT_AUTH: AuthState = {
  type: "none",
  token: "",
  username: "",
  password: "",
  keyName: "X-Api-Key",
  keyValue: "",
  keyIn: "header",
};

function maskSecret(value: string): string {
  if (!value) return "(empty)";
  return value.length <= 6 ? value : `${value.slice(0, 3)}••••${value.slice(-2)}`;
}

export function authPreview(auth: AuthState): string {
  switch (auth.type) {
    case "none":
      return "No Authorization added — request goes out with only the headers above.";
    case "bearer":
      return `Adds header  Authorization: Bearer ${maskSecret(auth.token)}`;
    case "basic":
      return `Adds header  Authorization: Basic ${btoa(unescape(encodeURIComponent(`${auth.username}:${auth.password}`))).slice(0, 16)}…`;
    case "apikey":
      return `Adds ${auth.keyIn === "query" ? "query param" : "header"}  ${auth.keyName || "X-Api-Key"}: ${maskSecret(auth.keyValue)}`;
  }
}

export function resolveAuthHeader(auth: AuthState): { key: string; value: string } | null {
  switch (auth.type) {
    case "none":
      return null;
    case "bearer":
      return auth.token ? { key: "Authorization", value: `Bearer ${auth.token}` } : null;
    case "basic":
      return { key: "Authorization", value: `Basic ${btoa(unescape(encodeURIComponent(`${auth.username}:${auth.password}`)))}` };
    case "apikey":
      return auth.keyIn === "header" && auth.keyValue ? { key: auth.keyName || "X-Api-Key", value: auth.keyValue } : null;
  }
}

export function resolveAuthQueryParam(auth: AuthState): { key: string; value: string } | null {
  if (auth.type === "apikey" && auth.keyIn === "query" && auth.keyValue) {
    return { key: auth.keyName || "X-Api-Key", value: auth.keyValue };
  }
  return null;
}

export function AuthEditor({ auth, onChange }: { auth: AuthState; onChange: (auth: AuthState) => void }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="w-23 text-sm text-text-faint">Type</span>
        <select
          value={auth.type}
          onChange={(e) => onChange({ ...auth, type: e.target.value as AuthType })}
          aria-label="Auth type"
          className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-bold text-text"
        >
          <option value="none">No Auth</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
          <option value="apikey">API Key</option>
        </select>
      </div>
      {auth.type === "bearer" ? (
        <div className="mb-3 flex items-center gap-2">
          <span className="w-23 text-sm text-text-faint">Token</span>
          <input
            className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
            value={auth.token}
            onChange={(e) => onChange({ ...auth, token: e.target.value })}
            placeholder="Bearer token"
          />
        </div>
      ) : null}
      {auth.type === "basic" ? (
        <>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Username</span>
            <input
              className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
              value={auth.username}
              onChange={(e) => onChange({ ...auth, username: e.target.value })}
            />
          </div>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Password</span>
            <input
              type="password"
              className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
              value={auth.password}
              onChange={(e) => onChange({ ...auth, password: e.target.value })}
            />
          </div>
        </>
      ) : null}
      {auth.type === "apikey" ? (
        <>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Key name</span>
            <input
              className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
              value={auth.keyName}
              onChange={(e) => onChange({ ...auth, keyName: e.target.value })}
            />
          </div>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Key value</span>
            <input
              className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
              value={auth.keyValue}
              onChange={(e) => onChange({ ...auth, keyValue: e.target.value })}
            />
          </div>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Add to</span>
            <select
              value={auth.keyIn}
              onChange={(e) => onChange({ ...auth, keyIn: e.target.value as AuthKeyIn })}
              aria-label="Add to"
              className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-bold text-text"
            >
              <option value="header">Header</option>
              <option value="query">Query param</option>
            </select>
          </div>
        </>
      ) : null}
      <div className="rounded-md border border-dashed border-border bg-surface p-2.5 font-mono text-xs text-text-faint">
        {authPreview(auth)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test AuthEditor`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/api/composer/AuthEditor.tsx apps/devbench/src/components/api/composer/AuthEditor.test.tsx
git commit -m "feat(devbench): add auth editor that compiles into a header or query param"
```

---

### Task 9: `RequestTabs` (Params/Headers/Body/Auth tab strip)

**Files:**
- Create: `apps/devbench/src/components/api/composer/RequestTabs.tsx`
- Test: `apps/devbench/src/components/api/composer/RequestTabs.test.tsx`

**Interfaces:**
- Consumes: `KeyValueEditor`/`KeyValueRow` (Task 6), `BodyEditor`/`BodyType`
  (Task 7), `AuthEditor`/`AuthState` (Task 8).
- Produces: `export type ReqTab = "params" | "headers" | "body" | "auth"`;
  `RequestTabs({ activeTab, onTabChange, params, onParamsChange, headers,
  onHeadersChange, body, bodyType, onBodyChange, onBodyTypeChange, auth,
  onAuthChange })`. Consumed by `RequestBuilder.tsx` (Task 10).

- [ ] **Step 1: Write the failing tests**

Create `apps/devbench/src/components/api/composer/RequestTabs.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequestTabs } from "./RequestTabs";
import { DEFAULT_AUTH } from "./AuthEditor";

const baseProps = {
  activeTab: "headers" as const,
  onTabChange: vi.fn(),
  params: [],
  onParamsChange: vi.fn(),
  headers: [],
  onHeadersChange: vi.fn(),
  body: "",
  bodyType: "none" as const,
  onBodyChange: vi.fn(),
  onBodyTypeChange: vi.fn(),
  auth: DEFAULT_AUTH,
  onAuthChange: vi.fn(),
};

describe("RequestTabs", () => {
  it("shows the Headers panel when activeTab is headers", () => {
    render(<RequestTabs {...baseProps} />);
    expect(screen.getByText("No headers set.")).toBeInTheDocument();
  });

  it("shows the Params panel when activeTab is params", () => {
    render(<RequestTabs {...baseProps} activeTab="params" />);
    expect(screen.getByText(/No query params/)).toBeInTheDocument();
  });

  it("shows the Body panel when activeTab is body", () => {
    render(<RequestTabs {...baseProps} activeTab="body" />);
    expect(screen.getByLabelText("Body type")).toBeInTheDocument();
  });

  it("shows the Auth panel when activeTab is auth", () => {
    render(<RequestTabs {...baseProps} activeTab="auth" />);
    expect(screen.getByLabelText("Auth type")).toBeInTheDocument();
  });

  it("calls onTabChange when a tab is clicked", () => {
    const onTabChange = vi.fn();
    render(<RequestTabs {...baseProps} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText("Body"));
    expect(onTabChange).toHaveBeenCalledWith("body");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test RequestTabs`
Expected: FAIL — the component doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/devbench/src/components/api/composer/RequestTabs.tsx`:

```tsx
import { KeyValueEditor, type KeyValueRow } from "./KeyValueEditor";
import { BodyEditor, type BodyType } from "./BodyEditor";
import { AuthEditor, type AuthState } from "./AuthEditor";

export type ReqTab = "params" | "headers" | "body" | "auth";

const TABS: { id: ReqTab; label: string }[] = [
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "auth", label: "Auth" },
];

export function RequestTabs({
  activeTab,
  onTabChange,
  params,
  onParamsChange,
  headers,
  onHeadersChange,
  body,
  bodyType,
  onBodyChange,
  onBodyTypeChange,
  auth,
  onAuthChange,
}: {
  activeTab: ReqTab;
  onTabChange: (tab: ReqTab) => void;
  params: KeyValueRow[];
  onParamsChange: (rows: KeyValueRow[]) => void;
  headers: KeyValueRow[];
  onHeadersChange: (rows: KeyValueRow[]) => void;
  body: string;
  bodyType: BodyType;
  onBodyChange: (body: string) => void;
  onBodyTypeChange: (type: BodyType) => void;
  auth: AuthState;
  onAuthChange: (auth: AuthState) => void;
}) {
  return (
    <div>
      <div className="flex gap-4.5 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            aria-selected={activeTab === tab.id}
            className={`border-b-2 px-0.5 py-2 text-sm font-semibold ${
              activeTab === tab.id ? "border-accent text-text" : "border-transparent text-text-faint"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pt-3">
        {activeTab === "params" ? (
          <KeyValueEditor
            rows={params}
            onChange={onParamsChange}
            addLabel="Add param"
            emptyLabel="No query params. Add one, or type them straight into the URL above."
          />
        ) : null}
        {activeTab === "headers" ? (
          <KeyValueEditor rows={headers} onChange={onHeadersChange} showEnabled addLabel="Add header" emptyLabel="No headers set." />
        ) : null}
        {activeTab === "body" ? (
          <BodyEditor bodyType={bodyType} body={body} onBodyTypeChange={onBodyTypeChange} onBodyChange={onBodyChange} />
        ) : null}
        {activeTab === "auth" ? <AuthEditor auth={auth} onChange={onAuthChange} /> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test RequestTabs`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/api/composer/RequestTabs.tsx apps/devbench/src/components/api/composer/RequestTabs.test.tsx
git commit -m "feat(devbench): add the params/headers/body/auth request tab strip"
```

---

### Task 10: Rewrite `RequestBuilder` to own the full composer

**Files:**
- Modify: `apps/devbench/src/components/api/RequestBuilder.tsx` (full rewrite)
- Modify: `apps/devbench/src/components/api/RequestBuilder.test.tsx` (add
  cases; Task 4 already fixed the pre-existing literal breakage)

**Interfaces:**
- Consumes: `HeaderPair`, `invokeRunCorrelatedRequest` (`lib/tauri.ts`, Task
  4); `splitUrlAndParams`/`joinUrlAndParams` (Task 5); `RequestTabs` (Task 9);
  `DEFAULT_AUTH`, `resolveAuthHeader`, `resolveAuthQueryParam` (Task 8).
- Produces: no prop changes — `RequestBuilder`'s external interface
  (`connection`, `watchedTables`, `sessionId`, `onResult`, `onSendStart`,
  `onError`) is unchanged, so `ApiTab.tsx`'s existing usage keeps compiling
  untouched.

- [ ] **Step 1: Write the failing tests**

Add these to `RequestBuilder.test.tsx` (after the existing 3 tests, inside
the same `describe` block):

```tsx
  it("assembles headers, resolved auth, and url params into the actual request payload", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-9",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });

    render(<RequestBuilder connection={connection} watchedTables={new Set()} onResult={onResult} />);

    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders?status=pending" } });

    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    const [keyInput] = screen.getAllByPlaceholderText("key");
    const [valueInput] = screen.getAllByPlaceholderText("value");
    fireEvent.change(keyInput, { target: { value: "X-Debug" } });
    fireEvent.change(valueInput, { target: { value: "true" } });

    fireEvent.click(screen.getByText("Auth"));
    fireEvent.change(screen.getByLabelText("Auth type"), { target: { value: "bearer" } });
    fireEvent.change(screen.getByPlaceholderText("Bearer token"), { target: { value: "abc123" } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.url).toBe("/api/orders?status=pending");
    expect(call.request.headers).toEqual(
      expect.arrayContaining([
        { key: "X-Debug", value: "true" },
        { key: "Authorization", value: "Bearer abc123" },
      ]),
    );
  });

  it("excludes an unchecked header from the sent request", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-10",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });

    render(<RequestBuilder connection={connection} watchedTables={new Set()} onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getAllByPlaceholderText("key")[0], { target: { value: "X-Debug" } });
    fireEvent.change(screen.getAllByPlaceholderText("value")[0], { target: { value: "true" } });
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.headers).toEqual([]);
  });

  it("sends undefined body when bodyType is none", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-11",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });
    render(<RequestBuilder connection={connection} watchedTables={new Set()} onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.body).toBeUndefined();
  });

  it("sends the body text when bodyType is json", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-12",
      response: { status_code: 201, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });
    render(<RequestBuilder connection={connection} watchedTables={new Set()} onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByText("Body"));
    fireEvent.change(screen.getByLabelText("Body type"), { target: { value: "json" } });
    fireEvent.change(screen.getByPlaceholderText("Raw request body"), { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.body).toBe('{"a":1}');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test RequestBuilder`
Expected: FAIL — `RequestBuilder` doesn't render an "Add header" button, an
"Auth"/"Body" tab, or a checkbox yet.

- [ ] **Step 3: Rewrite `RequestBuilder.tsx`**

Replace the entire file with:

```tsx
import { useState } from "react";
import { invokeRunCorrelatedRequest, type CorrelationResult, type DbConnectInput, type HeaderPair } from "../../lib/tauri";
import { RequestTabs, type ReqTab } from "./composer/RequestTabs";
import type { KeyValueRow } from "./composer/KeyValueEditor";
import type { BodyType } from "./composer/BodyEditor";
import { DEFAULT_AUTH, resolveAuthHeader, resolveAuthQueryParam, type AuthState } from "./composer/AuthEditor";
import { splitUrlAndParams, joinUrlAndParams } from "./composer/urlParams";

export function RequestBuilder({
  connection,
  watchedTables,
  // `lib/tauri.ts` already normalises to `null`; this default only satisfies
  // the exact-payload assertion in RequestBuilder.test.tsx.
  sessionId = null,
  onResult,
  onSendStart,
  onError,
}: {
  connection: DbConnectInput;
  watchedTables: Set<string>;
  /** Attributes the fired request's history entry to this session. `null` = unattributed. */
  sessionId?: string | null;
  onResult: (result: CorrelationResult) => void;
  onSendStart?: () => void;
  onError?: (message: string) => void;
}) {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<KeyValueRow[]>([]);
  const [body, setBody] = useState("");
  const [bodyType, setBodyType] = useState<BodyType>("none");
  const [auth, setAuth] = useState<AuthState>(DEFAULT_AUTH);
  const [activeReqTab, setActiveReqTab] = useState<ReqTab>("headers");
  const [sending, setSending] = useState(false);

  const { base, params } = splitUrlAndParams(url);

  function handleParamsChange(rows: KeyValueRow[]) {
    setUrl(joinUrlAndParams(base, rows));
  }

  function buildHeaders(): HeaderPair[] {
    const resolved: HeaderPair[] = headers
      .filter((h) => h.enabled !== false && h.key)
      .map((h) => ({ key: h.key, value: h.value }));
    const authHeader = resolveAuthHeader(auth);
    if (authHeader) resolved.push(authHeader);
    return resolved;
  }

  function buildUrl(): string {
    const authParam = resolveAuthQueryParam(auth);
    if (!authParam) return url;
    const { base: b, params: p } = splitUrlAndParams(url);
    return joinUrlAndParams(b, [...p, { key: authParam.key, value: authParam.value }]);
  }

  async function handleSend() {
    setSending(true);
    onSendStart?.();
    try {
      const result = await invokeRunCorrelatedRequest({
        request: {
          method,
          url: buildUrl(),
          headers: buildHeaders(),
          body: bodyType === "none" ? undefined : body,
        },
        connection,
        watchedTables: Array.from(watchedTables),
        sessionId,
      });
      onResult(result);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-t-lg border border-b-0 border-border bg-surface p-3">
      <div className="flex gap-2">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="rounded-sm border border-border bg-surface-2 px-2.5 py-2 font-bold text-text"
        >
          <option>GET</option>
          <option>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
          <option>DELETE</option>
        </select>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="/api/orders"
          className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-text"
        />
        <button
          onClick={handleSend}
          disabled={sending}
          className="min-w-21 rounded-sm bg-accent px-4 font-bold text-accent-on disabled:opacity-60"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <RequestTabs
        activeTab={activeReqTab}
        onTabChange={setActiveReqTab}
        params={params}
        onParamsChange={handleParamsChange}
        headers={headers}
        onHeadersChange={setHeaders}
        body={body}
        bodyType={bodyType}
        onBodyChange={setBody}
        onBodyTypeChange={setBodyType}
        auth={auth}
        onAuthChange={setAuth}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test RequestBuilder`
Expected: all tests pass (3 existing + 4 new).

- [ ] **Step 5: Run the frontend test suite**

Run: `cd apps/devbench && bun run test`
Expected: everything passes, including `ApiTab.test.tsx` — proving
`ApiTab.tsx`'s usage of `RequestBuilder` (unchanged props) still works.
`bun run build` is **not** expected to pass yet: `ApiTab.tsx`'s
`handleHistorySelect` still builds a `FireRequestOutput` literal missing
`headers` (see Task 4, Step 2) until Task 12 rewrites it.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/components/api/RequestBuilder.tsx apps/devbench/src/components/api/RequestBuilder.test.tsx
git commit -m "feat(devbench): let the request composer express headers, params, body, and auth"
```

---

### Task 11: `ResponseViewer` — Body/Headers sub-tabs + "Sent" disclosure

**Files:**
- Modify: `apps/devbench/src/components/api/ResponseViewer.tsx` (full rewrite)
- Modify: `apps/devbench/src/components/api/ResponseViewer.test.tsx`

**Interfaces:**
- Consumes: `FireRequestOutput`, `HeaderPair` (`lib/tauri.ts`, Task 4).
- Produces: `export interface SentRequest { method: string; url: string;
  headers: HeaderPair[]; body: string | null }`; `ResponseViewer({ result,
  sentRequest? })` — `sentRequest` is a new optional prop, so existing call
  sites that omit it keep compiling. Consumed by `ApiTab.tsx` (Task 12).

- [ ] **Step 1: Write the failing tests**

Replace `ResponseViewer.test.tsx` with:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResponseViewer } from "./ResponseViewer";

describe("ResponseViewer", () => {
  it("shows nothing before a request has been sent", () => {
    render(<ResponseViewer result={null} />);
    expect(screen.queryByText(/status/i)).not.toBeInTheDocument();
  });

  it("shows status code, duration, and body after a response", () => {
    render(<ResponseViewer result={{ status_code: 200, headers: [], body: '{"id":8841}', duration_ms: 142 }} />);
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("142ms")).toBeInTheDocument();
    expect(screen.getByText('{"id":8841}')).toBeInTheDocument();
  });

  it("shows response headers on the Headers tab", () => {
    render(
      <ResponseViewer
        result={{ status_code: 200, headers: [{ key: "content-type", value: "application/json" }], body: "{}", duration_ms: 5 }}
      />,
    );
    fireEvent.click(screen.getByText("Headers"));
    expect(screen.getByText("content-type")).toBeInTheDocument();
    expect(screen.getByText("application/json")).toBeInTheDocument();
  });

  it("shows a read-only Sent disclosure only when sentRequest is provided", () => {
    render(
      <ResponseViewer
        result={{ status_code: 201, headers: [], body: "{}", duration_ms: 5 }}
        sentRequest={{ method: "POST", url: "/api/orders", headers: [{ key: "Content-Type", value: "application/json" }], body: "{\"a\":1}" }}
      />,
    );
    expect(screen.getByText(/Sent: POST \/api\/orders/)).toBeInTheDocument();
  });

  it("shows no Sent disclosure for a live response with no sentRequest", () => {
    render(<ResponseViewer result={{ status_code: 200, headers: [], body: "{}", duration_ms: 5 }} />);
    expect(screen.queryByText(/^Sent:/)).not.toBeInTheDocument();
  });
});
```

Add `fireEvent` to the existing import line at the top:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test ResponseViewer`
Expected: FAIL — no Headers tab, no Sent disclosure, and the existing body
test's literal is missing `headers`.

- [ ] **Step 3: Rewrite `ResponseViewer.tsx`**

```tsx
import { useState } from "react";
import type { FireRequestOutput, HeaderPair } from "../../lib/tauri";

export interface SentRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string | null;
}

export function ResponseViewer({
  result,
  sentRequest = null,
}: {
  result: FireRequestOutput | null;
  /** Set only when `result` was restored from History — shows what was actually sent, read-only. */
  sentRequest?: SentRequest | null;
}) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  if (!result) return null;
  const isSuccess = result.status_code >= 200 && result.status_code < 300;

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 p-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-bold ${
            isSuccess ? "bg-success-bg text-success" : "bg-danger-bg text-danger"
          }`}
        >
          {result.status_code}
        </span>
        <span className="text-xs font-semibold text-text-muted">{result.duration_ms}ms</span>
        <div className="ml-auto flex gap-3">
          <button
            type="button"
            onClick={() => setTab("body")}
            aria-selected={tab === "body"}
            className={`text-xs font-bold uppercase ${tab === "body" ? "text-text" : "text-text-faint"}`}
          >
            Body
          </button>
          <button
            type="button"
            onClick={() => setTab("headers")}
            aria-selected={tab === "headers"}
            className={`text-xs font-bold uppercase ${tab === "headers" ? "text-text" : "text-text-faint"}`}
          >
            Headers
          </button>
        </div>
      </div>
      {sentRequest ? (
        <details className="border-t border-border p-3 text-sm text-text-faint">
          <summary className="cursor-pointer">
            Sent: {sentRequest.method} {sentRequest.url} · {sentRequest.headers.length} header
            {sentRequest.headers.length === 1 ? "" : "s"}
            {sentRequest.body ? ` · ${sentRequest.body.length}B body` : " · no body"}
          </summary>
          {sentRequest.headers.length > 0 ? (
            <table className="mt-2 w-full font-mono text-xs">
              <tbody>
                {sentRequest.headers.map((h, i) => (
                  <tr key={i}>
                    <td className="pr-3 text-text-faint">{h.key}</td>
                    <td className="text-text-muted">{h.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {sentRequest.body ? <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-text-muted">{sentRequest.body}</pre> : null}
        </details>
      ) : null}
      {tab === "body" ? (
        <pre className="whitespace-pre-wrap rounded-b-lg border-t border-border bg-surface-2 p-3 font-mono text-sm text-text">
          {result.body}
        </pre>
      ) : (
        <table className="w-full rounded-b-lg border-t border-border bg-surface-2 font-mono text-sm">
          <tbody>
            {result.headers.length === 0 ? (
              <tr>
                <td className="p-3 text-text-faint">No headers.</td>
              </tr>
            ) : (
              result.headers.map((h, i) => (
                <tr key={i} className="border-t border-border first:border-t-0">
                  <td className="p-3 pr-4 text-text-faint">{h.key}</td>
                  <td className="p-3 text-text">{h.value}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test ResponseViewer`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/api/ResponseViewer.tsx apps/devbench/src/components/api/ResponseViewer.test.tsx
git commit -m "feat(devbench): show response headers and a read-only sent-request disclosure"
```

---

### Task 12: Wire `ApiTab` to the widened response and `sentRequest`

**Files:**
- Modify: `apps/devbench/src/components/api/ApiTab.tsx:23-28,76-96,139-157,169-207`
- Modify: `apps/devbench/src/components/api/ApiTab.test.tsx` (Task 4 already
  fixed the pre-existing literal breakage)

**Interfaces:**
- Consumes: `SentRequest` (`ResponseViewer.tsx`, Task 11); widened
  `HistoryEntry` (`lib/tauri.ts`, Task 4).

- [ ] **Step 1: Write the failing tests**

Add these to `ApiTab.test.tsx` (after the existing tests, inside the
`describe` block):

```tsx
  it("shows a read-only Sent disclosure only when a response was restored from history", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([
      {
        id: "1",
        method: "POST",
        url: "/api/orders",
        status_code: 201,
        response_body: '{"id":8841}',
        duration_ms: 142,
        fired_at: "2026-07-30T14:02:11Z",
        session_id: null,
        request_headers: [{ key: "Content-Type", value: "application/json" }],
        request_body: '{"sku":"WIDGET-1"}',
        response_headers: [{ key: "content-type", value: "application/json" }],
      },
    ]);

    render(<ApiTab onOpenTableInDb={() => {}} onOpenEmail={() => {}} />);
    const historyButton = await screen.findByRole("button", { name: /\/api\/orders/ });
    fireEvent.click(historyButton);

    await waitFor(() => expect(screen.getByText(/Sent: POST \/api\/orders/)).toBeInTheDocument());
  });

  it("does not show a Sent disclosure for a live send", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue(sendResult('{"id":1}'));
    vi.spyOn(tauriLib, "invokeCollectCorrelationWindow").mockReturnValue(new Promise(() => {}));

    render(<ApiTab onOpenTableInDb={() => {}} onOpenEmail={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText('{"id":1}')).toBeInTheDocument());
    expect(screen.queryByText(/^Sent:/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/devbench && bun run test ApiTab`
Expected: FAIL — `ResponseViewer` never receives a `sentRequest`, so no
"Sent:" text renders for the history case.

- [ ] **Step 3: Wire `sentRequest` through `ApiTab.tsx`**

Add the import (alongside the existing `lib/tauri` import):

```tsx
import type { SentRequest } from "./ResponseViewer";
```

Widen the `DisplayResult` interface:

```tsx
interface DisplayResult {
  /** Which send this pane shows. `null` when restored from history. */
  correlationId: string | null;
  response: FireRequestOutput;
  rollup: RollupData;
  /** Only set when restored from History — shows what was actually sent, read-only. */
  sentRequest: SentRequest | null;
}
```

In `handleResult` (the live-send path), add `sentRequest: null,` to the
`setResult({...})` call — a live send already shows what's being sent in the
composer above, so there's nothing to repeat.

Replace `handleHistorySelect` with:

```tsx
  function handleHistorySelect(entry: HistoryEntry) {
    setSending(false);
    setError(null);
    setResult({
      // Matches no live id, so an outstanding send cannot fill in a history view.
      correlationId: null,
      response: {
        status_code: entry.status_code,
        headers: entry.response_headers,
        body: entry.response_body,
        duration_ms: entry.duration_ms,
      },
      rollup: {
        tableDiffs: null,
        watchedTableCount: watchedTables.size,
        logLines: null,
        logLinesTruncated: false,
        emails: null,
        emailsTruncated: false,
        dbError: null,
        windowOpen: false,
      },
      sentRequest: {
        method: entry.method,
        url: entry.url,
        headers: entry.request_headers,
        body: entry.request_body,
      },
    });
  }
```

Update the `ResponseViewer` usage in the JSX:

```tsx
        <ResponseViewer result={result?.response ?? null} sentRequest={result?.sentRequest ?? null} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test ApiTab`
Expected: all tests pass, including the 2 new ones.

- [ ] **Step 5: Run the entire frontend suite and typecheck one more time**

Run: `cd apps/devbench && bun run test && bun run build`
Expected: everything passes. This is the final gate for Plan 1.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/components/api/ApiTab.tsx apps/devbench/src/components/api/ApiTab.test.tsx
git commit -m "feat(devbench): show what a history entry actually sent alongside its response"
```

---

## Follow-on (not in this plan)

**Plan 2: Saved requests** — the `saved_requests` table and its
create/list/update/rename/delete commands, the sidebar's "Saved" section
above "History," and the load-into-composer / edit / dirty / explicit-Save
workflow described in the spec. This depends on Plan 1's composer fields
(headers, body, bodyType, auth) already existing to load a snapshot into, so
it must be planned and executed after this one lands. Not detailed here,
matching how the spec itself deferred it.

Also out of scope for both plans, per the spec: folders/environments for
saved requests, OAuth2 and other advanced auth flows, multipart/binary
bodies, collection import/export, and OS-keychain-backed secrets.
