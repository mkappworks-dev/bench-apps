# DevBench v1 — Shell: Sessions, Split View, Settings & Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shell that surrounds the four working tools — the three-column layout (sessions sidebar → main content → chat dock), split view, the Settings screen (General / Provider / MCP / Archive), and the BYOK AI chat dock — and close the persistence gaps Plans 1–3 deliberately left open, so that the hardcoded correlation window and SMTP port become real settings and watched tables survive a restart. After this plan, DevBench v1 is feature-complete against the spec.

**Architecture:** `App.tsx` today is a flat single-column shell (header + one `<main>`). This plan replaces it with the shell `DESIGN.md` describes: a topbar carrying only identity and app-wide actions, a ghosty sessions sidebar, a main column that owns the tool tab bar and can split into two independently-tabbed panes, and a collapsible chat dock that resizes the content column rather than overlaying it. Settings is a full navigated screen that swaps the body out, not an overlay. All new persistence lands in the existing local SQLite database via a second migration; the AI chat calls the user's chosen provider directly from Rust with a key held in OS-native secure storage.

**Tech Stack:** Unchanged, plus `@base-ui-components/react` (headless Tabs) on the frontend and `keyring` (OS-native secret storage) on the backend. No MCP crate — see Decision 2.

## Global Constraints

- **Local Postgres required for the backend suite:** `docker compose up -d` at the repo root. If tests fail with a connection timeout, run `docker compose down && docker compose up -d --force-recreate`.
- **`cmake` and a C compiler are already required** by Plan 3's `mailin-embedded`. `keyring` adds `security-framework` on macOS and zbus/Secret Service on Linux — no new toolchain, but see the next point.
- **No test in this plan may require a real OS keychain.** A headless CI box has no Secret Service provider at all, so a keychain-backed test would fail there for reasons unrelated to the code. Secret storage goes behind a `SecretStore` trait (Task 9) with an in-memory implementation for tests; the one test that exercises the real keychain is marked `#[ignore]` and documented as manual.
- MIT license on all code in `apps/devbench`. `@base-ui-components/react` is MIT; `keyring` is MIT OR Apache-2.0 — both compatible.
- Local-first: the only network calls DevBench makes are to the user's own target API, their own Postgres, and — when the user has entered a key — their chosen AI provider's API directly. No DevBench-operated server exists or is contacted anywhere in this plan.
- Every Tauri command follows the established split: a thin `#[tauri::command]` wrapper delegating to a plain `_impl` that takes references (`&SqlitePool`, `&dyn SecretStore`), never `tauri::State`.
- **The API key is never returned to the frontend.** `get_provider_settings` returns `has_key: bool`, never the key itself. The Rust side reads it from the keychain at call time. A key that round-trips through the webview is a key that can be read by any HTML DevBench renders — including a caught email (Plan 3 sandboxes those, but the principle stands).
- Visual system follows `DESIGN.md`. Two chrome techniques, not blended: **ghosty** (topbar, sessions sidebar, chat dock, tab bars — transparent, `1px solid var(--border)` hairline, no blur; buttons transparent until hover gains `var(--surface-2)`) and **glass** (`backdrop-filter: blur(20-28px) saturate(150-160%)` plus a `1px` inner top highlight, always with a solid `prefers-reduced-transparency` fallback) — used **only** for the New Session picker. Settings is a navigated screen and is therefore *not* glass. Motion 150–250ms, state-conveying only, respecting `prefers-reduced-motion`.
- Package manager is Bun exclusively.
- A failure to observe is never rendered as "nothing happened" (PRODUCT.md principle 4).

---

## Task Groups

This plan covers four subsystems the spec treats separately. They are ordered so each group leaves the app working, and a reviewer can stop after any group:

| Group | Tasks | Leaves the app at |
|---|---|---|
| **A — Persistence** | 1–3 | Same UI, but watched tables survive restart and the two hardcoded constants are stored settings |
| **B — Shell & Sessions** | 4–6 | The real three-column shell with named, archivable sessions |
| **C — Split view** | 7 | Any two tools side by side |
| **D — Settings & Chat** | 8–14 | Feature-complete v1 |

---

## Decisions Made In This Plan (read these before Task 1)

### Decision 1: Base UI is adopted here, for Tabs only

`PRODUCT.md` and the v1 spec both name Base UI, and the spec gives a concrete reason: "the session list, DB table tree, and email inbox are plain clickable `<div>`s today, not keyboard-navigable list/tab primitives." That is still true — `SchemaTree.tsx` renders a `<div onClick=…>` per table, which is unreachable by keyboard. Plans 1–3 correctly did not install it (two hand-written tab buttons do not justify a dependency). This plan adds a *third* and *fourth* tab bar (split-pane tabs, settings nav), which is where hand-rolled roving tabindex stops being cheap.

**Adopted:** `@base-ui-components/react` pinned to exactly `1.0.0-rc.0`, used only for `Tabs` (`Tabs.Root` / `Tabs.List` / `Tabs.Tab` / `Tabs.Panel`, with `orientation="vertical"` for the settings nav). API verified against the installed package: `Tabs.Root` takes `value` and `onValueChange: (value, eventDetails) => void`.

**Not adopted:** `ToggleGroup` for the theme segmented control. Its value type is `readonly any[]` with `onValueChange: (groupValue: any[]) => void` — it is a *multi*-select primitive, so a single-select segmented control would mean passing `[theme]` and reading `groupValue[0]`, fighting the component. The theme control is a three-button `role="radiogroup"` instead, which is both simpler and semantically correct.

**RC risk, recorded:** `1.0.0-rc.0` is a release candidate. It is pinned exactly (no `^`) so a patch release cannot change behaviour silently, and its use is confined to one wrapper component (`components/shell/ToolTabs.tsx`) so replacing it is a one-file change.

### Decision 2: the MCP client is hand-rolled over a generic transport; `rmcp` is not used

`rmcp` 3.0.1 is the official Rust MCP SDK. Measured against this project it loses on three counts: adding it with `client` + `transport-child-process` resolved to a **167-package** dependency tree (including the `windows-*` and `wasm-bindgen` families); it is Apache-2.0 only in an MIT repo; and DevBench needs exactly four methods — `initialize`, the `notifications/initialized` notification, `tools/list`, and `tools/call`.

That subset is newline-delimited JSON-RPC 2.0 over the child process's stdin/stdout, which `serde_json` and `tokio` (both already dependencies) cover in roughly 150 lines.

**The design that makes this worth it:** the client is generic over `AsyncRead + AsyncWrite` rather than hardwired to a child process. That means the unit tests drive it over an in-memory `tokio::io::duplex` pair with a hand-written fake server — no spawning, no fixture binary, no flakiness — and the real child-process path is a thin adapter. A crate-based client would have been *harder* to test, not easier.

### Decision 3: BYOK secrets go behind a `SecretStore` trait

`keyring` 4.1.5 (verified compiling: `Entry::new` / `set_password` / `get_password` / `delete_credential` / `Error::NoEntry`; its default `v1` feature wires the native stores with no explicit registration). But a keychain is an ambient OS resource: on a headless Linux CI box there is no Secret Service provider, so any test touching it fails for environmental reasons. Secrets therefore go behind `trait SecretStore`, with `KeyringSecretStore` in production and `InMemorySecretStore` in tests. One `#[ignore]`d test exercises the real keychain for manual verification.

### Decision 4: the chat calls the provider directly over raw HTTP from Rust

There is no official Anthropic SDK for Rust, so the chat command uses `reqwest` (already a dependency) against `POST https://api.anthropic.com/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`. Three API facts this plan's code depends on:

- Default model is **`claude-opus-5`**. `temperature`, `top_p`, and `top_k` are **removed** on this model — sending any of them returns a 400, so the request builder never includes them.
- Thinking is **on by default** on `claude-opus-5`, and `max_tokens` caps thinking *plus* response text. The request sets `max_tokens: 16000` and `output_config: {"effort": "medium"}` — low/medium effort are unusually strong on this model and a chat dock is latency-sensitive.
- A response can come back HTTP 200 with `stop_reason: "refusal"` and an empty `content` array. The parser checks `stop_reason` **before** indexing `content`, or a refusal panics the command.

### Decision 5: settings live in the existing SQLite database as a key/value table

The two constants Plans 2 and 3 flagged — `DEFAULT_CORRELATION_WINDOW_MS` (5,000) and `DEFAULT_SMTP_PORT` (1025) — become the *defaults* for stored values, not dead code. Task 1 adds the store and Task 8 wires the UI. The constants keep their names and stay the fallback when a row is absent, so nothing breaks if the settings table is empty.

**One thing that does not become live in this plan:** changing the SMTP port requires rebinding the listener. The catcher binds once at startup, so a port change takes effect on the next launch and Settings says so explicitly. Hot-rebinding a running SMTP server is a real feature, not a one-liner, and it is not what the spec asks for ("a shortcut into Settings to change the port"). Recorded so it is not mistaken for a bug.

### Decision 6: sessions organize, they never restrict

Straight from the spec and `DESIGN.md`: a session's type badge is auto-inferred for scanning and search, and is never a gate on which tools are visible. Selecting a session changes which named investigation you are in; all four tabs stay available in every session. Two alternatives (scoped sessions, command-palette-driven scoping) were explored during design and rejected — this plan does not reopen that.

### Decision 7: split-view and chat state are per-session and in-memory

Which tool is in which pane, whether the split is open, and the chat transcript are UI state, not investigation data. They live in Zustand and are lost on restart. Persisting them is not in the v1 spec's scope table, and doing it here would mean designing a schema for pane layout in a plan already adding four subsystems. Recorded as a scoping decision.

---

## File Structure

```
apps/devbench/
  package.json                                    # + @base-ui-components/react (exact pin)
  src/
    App.tsx                                       # REWRITTEN: three-column shell + Settings route
    store/
      useAppStore.ts                              # MODIFIED: panes, chat dock, sessions, settings route
      useAppStore.test.ts                         # MODIFIED
    lib/tauri.ts                                  # MODIFIED: session/settings/provider/mcp/chat wrappers
    components/
      shell/
        TopBar.tsx / TopBar.test.tsx              # NEW
        SessionsSidebar.tsx / .test.tsx           # NEW
        NewSessionDialog.tsx / .test.tsx          # NEW  (the only glass surface)
        ToolTabs.tsx                              # NEW  (the single Base UI wrapper)
        SplitContent.tsx / .test.tsx              # NEW
        ToolPane.tsx                              # NEW
        ChatDock.tsx / .test.tsx                  # NEW
      settings/
        SettingsScreen.tsx / .test.tsx            # NEW
        GeneralPane.tsx / .test.tsx               # NEW
        ProviderPane.tsx / .test.tsx              # NEW
        McpPane.tsx / .test.tsx                   # NEW
        ArchivePane.tsx / .test.tsx               # NEW
      db/SchemaTree.tsx                           # MODIFIED: clickable div -> button (a11y fix)
  src-tauri/
    Cargo.toml                                    # + keyring
    migrations/0002_shell.sql                     # NEW
    src/
      lib.rs                                      # MODIFIED
      main.rs                                     # MODIFIED
      secrets.rs                                  # NEW: SecretStore trait + keyring/in-memory impls
      mcp_client.rs                               # NEW: generic-transport JSON-RPC MCP client
      commands/
        mod.rs                                    # MODIFIED
        settings.rs                               # NEW
        sessions.rs                               # NEW
        watched.rs                                # NEW
        provider.rs                               # NEW
        mcp.rs                                    # NEW
        chat.rs                                   # NEW
```

---

## Group A — Persistence

### Task 1: Migration 0002 and the settings store

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0002_shell.sql`
- Create: `apps/devbench/src-tauri/src/commands/settings.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Test: inline `#[cfg(test)]` module in `settings.rs`

**Interfaces:**
- Produces:
  - `pub struct AppSettings { theme: String, correlation_window_ms: i64, smtp_port: u16, provider: String, model: String }`
  - `pub async fn get_settings_impl(pool: &SqlitePool) -> Result<AppSettings, String>` and `pub async fn set_setting_impl(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String>`
  - Tauri commands `get_settings() -> Result<AppSettings, String>` and `set_setting(key: String, value: String) -> Result<(), String>`.
  Task 8 renders these; Tasks 2–3 use the same migration.

Settings are a key/value table rather than a one-row typed table so that adding a setting later is an insert, not a migration. `get_settings_impl` is where the defaults live — a missing row falls back to the constant Plans 2 and 3 defined, which is what keeps an empty settings table from breaking anything.

- [ ] **Step 1: Write the migration**

`apps/devbench/src-tauri/migrations/0002_shell.sql`:
```sql
-- Named investigations. Sessions are a pure organizational/history layer:
-- `kind` is an auto-inferred tag for scanning and search, never a gate on
-- which tools are visible.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- NULL means active; a timestamp means archived and restorable from
  -- Settings > Archive. Sessions are never hard-deleted by the sidebar.
  archived_at TEXT
);

CREATE INDEX idx_sessions_archived_at ON sessions (archived_at);

-- App-wide configuration. Key/value so a new setting is an INSERT rather than
-- a migration. Absent keys fall back to the constants in Rust.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- MCP servers the AI assistant may call during a chat. `args` is a JSON array.
-- No credentials here: an MCP server that needs a secret gets it from the
-- environment of the process the user configures, never from this table.
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
```

Note: `watched_tables` already exists from `0001_init.sql` and needs no change — Task 3 simply starts using it.

- [ ] **Step 2: Write the failing tests**

`apps/devbench/src-tauri/src/commands/settings.rs`:
```rust
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::correlation_state::DEFAULT_CORRELATION_WINDOW_MS;
use crate::email_state::DEFAULT_SMTP_PORT;
use crate::local_db::LocalDb;

/// Default AI model. `claude-opus-5` is the current Opus; note that
/// `temperature`/`top_p`/`top_k` are removed on it (sending them is a 400) and
/// that thinking is on by default, so `max_tokens` must leave room for it.
pub const DEFAULT_MODEL: &str = "claude-opus-5";
pub const DEFAULT_PROVIDER: &str = "anthropic";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppSettings {
    pub theme: String,
    pub correlation_window_ms: i64,
    pub smtp_port: u16,
    pub provider: String,
    pub model: String,
}

async fn get_raw(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("failed to read setting {key}: {e}"))?;
    Ok(row.map(|r| r.get::<String, _>("value")))
}

/// Reads every setting, falling back to the constant default when a row is
/// absent or unparseable. A corrupt value must never make the app unusable —
/// it degrades to the default the app shipped with.
pub async fn get_settings_impl(pool: &SqlitePool) -> Result<AppSettings, String> {
    Ok(AppSettings {
        theme: get_raw(pool, "theme").await?.unwrap_or_else(|| "dark".to_string()),
        correlation_window_ms: get_raw(pool, "correlation_window_ms")
            .await?
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|ms| (1_000..=60_000).contains(ms))
            .unwrap_or(DEFAULT_CORRELATION_WINDOW_MS),
        smtp_port: get_raw(pool, "smtp_port")
            .await?
            .and_then(|v| v.parse::<u16>().ok())
            .filter(|p| *p >= 1)
            .unwrap_or(DEFAULT_SMTP_PORT),
        provider: get_raw(pool, "provider").await?.unwrap_or_else(|| DEFAULT_PROVIDER.to_string()),
        model: get_raw(pool, "model").await?.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
    })
}

pub async fn set_setting_impl(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to write setting {key}: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn get_settings(db: State<'_, LocalDb>) -> Result<AppSettings, String> {
    get_settings_impl(&db.pool).await
}

#[tauri::command]
pub async fn set_setting(db: State<'_, LocalDb>, key: String, value: String) -> Result<(), String> {
    set_setting_impl(&db.pool, &key, &value).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn an_empty_settings_table_yields_the_shipped_defaults() {
        let (_dir, db) = db().await;
        let settings = get_settings_impl(&db.pool).await.unwrap();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.correlation_window_ms, DEFAULT_CORRELATION_WINDOW_MS);
        assert_eq!(settings.smtp_port, DEFAULT_SMTP_PORT);
        assert_eq!(settings.model, DEFAULT_MODEL);
    }

    #[tokio::test]
    async fn a_stored_setting_overrides_the_default() {
        let (_dir, db) = db().await;
        set_setting_impl(&db.pool, "correlation_window_ms", "12000").await.unwrap();
        set_setting_impl(&db.pool, "theme", "light").await.unwrap();
        let settings = get_settings_impl(&db.pool).await.unwrap();
        assert_eq!(settings.correlation_window_ms, 12_000);
        assert_eq!(settings.theme, "light");
    }

    #[tokio::test]
    async fn writing_the_same_key_twice_updates_rather_than_erroring() {
        let (_dir, db) = db().await;
        set_setting_impl(&db.pool, "model", "claude-sonnet-5").await.unwrap();
        set_setting_impl(&db.pool, "model", "claude-opus-5").await.unwrap();
        assert_eq!(get_settings_impl(&db.pool).await.unwrap().model, "claude-opus-5");
    }

    // A hand-edited or corrupted DB must degrade to the shipped default, not
    // make the app unusable or silently correlate over a 0 ms window.
    #[tokio::test]
    async fn an_unparseable_or_out_of_range_value_falls_back_to_the_default() {
        let (_dir, db) = db().await;
        set_setting_impl(&db.pool, "correlation_window_ms", "not-a-number").await.unwrap();
        assert_eq!(
            get_settings_impl(&db.pool).await.unwrap().correlation_window_ms,
            DEFAULT_CORRELATION_WINDOW_MS
        );

        set_setting_impl(&db.pool, "correlation_window_ms", "999999").await.unwrap();
        assert_eq!(
            get_settings_impl(&db.pool).await.unwrap().correlation_window_ms,
            DEFAULT_CORRELATION_WINDOW_MS
        );
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test an_empty_settings_table_yields`
Expected: FAIL to compile — `commands::settings` is not declared.

- [ ] **Step 4: Register the module and commands**

`apps/devbench/src-tauri/src/commands/mod.rs` — add `pub mod settings;` (keep the list alphabetical).

Add to `generate_handler!` in `main.rs`:
```rust
            commands::settings::get_settings,
            commands::settings::set_setting,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib settings::`
Expected: PASS (four tests)

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src-tauri/migrations apps/devbench/src-tauri/src/commands
git commit -m "feat(devbench): add sessions/settings/mcp schema and a settings store"
```

---

### Task 2: Session CRUD, archive, and restore

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/sessions.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Test: inline `#[cfg(test)]` module in `sessions.rs`

**Interfaces:**
- Produces: `pub struct Session { id, name, kind, created_at, updated_at, archived_at }` and Tauri commands `create_session(name: String, kind: Option<String>) -> Result<Session, String>`, `list_sessions() -> Result<Vec<Session>, String>`, `list_archived_sessions() -> Result<Vec<Session>, String>`, `rename_session(id, name) -> Result<Session, String>`, `archive_session(id) -> Result<(), String>`, `restore_session(id) -> Result<(), String>`, `delete_session(id) -> Result<(), String>`. Task 5 renders the active list; Task 12 renders the archived list.

The spec is explicit that removing a session from the sidebar archives it rather than deleting it ("sessions need an archive/restore lifecycle in v1, not just create-and-list"). `delete_session` exists only for Settings > Archive's permanent delete, which is the one place the user has said so twice.

- [ ] **Step 1: Write the failing tests**

`apps/devbench/src-tauri/src/commands/sessions.rs`:
```rust
use chrono::Utc;
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;
use uuid::Uuid;

use crate::local_db::LocalDb;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Session {
    pub id: String,
    pub name: String,
    /// Auto-inferred tag for scanning and search — NEVER a restriction on
    /// which tools are visible (v1 spec, "Shell and sessions").
    pub kind: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// `None` = active. `Some(ts)` = archived and restorable from Settings.
    pub archived_at: Option<String>,
}

fn row_to_session(r: &sqlx::sqlite::SqliteRow) -> Session {
    Session {
        id: r.get("id"),
        name: r.get("name"),
        kind: r.get("kind"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
        archived_at: r.get("archived_at"),
    }
}

pub async fn create_session_impl(
    pool: &SqlitePool,
    name: &str,
    kind: Option<&str>,
) -> Result<Session, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a session needs a name".to_string());
    }
    let now = Utc::now().to_rfc3339();
    let session = Session {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        kind: kind.map(str::to_string),
        created_at: now.clone(),
        updated_at: now,
        archived_at: None,
    };
    sqlx::query(
        "INSERT INTO sessions (id, name, kind, created_at, updated_at, archived_at) \
         VALUES (?, ?, ?, ?, ?, NULL)",
    )
    .bind(&session.id)
    .bind(&session.name)
    .bind(&session.kind)
    .bind(&session.created_at)
    .bind(&session.updated_at)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to create session: {e}"))?;
    Ok(session)
}

pub async fn list_sessions_impl(pool: &SqlitePool, archived: bool) -> Result<Vec<Session>, String> {
    let sql = if archived {
        "SELECT id, name, kind, created_at, updated_at, archived_at FROM sessions \
         WHERE archived_at IS NOT NULL ORDER BY archived_at DESC"
    } else {
        "SELECT id, name, kind, created_at, updated_at, archived_at FROM sessions \
         WHERE archived_at IS NULL ORDER BY updated_at DESC"
    };
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to list sessions: {e}"))?;
    Ok(rows.iter().map(row_to_session).collect())
}

pub async fn rename_session_impl(pool: &SqlitePool, id: &str, name: &str) -> Result<Session, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a session needs a name".to_string());
    }
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?")
        .bind(name)
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to rename session: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no session with id {id}"));
    }
    let row = sqlx::query(
        "SELECT id, name, kind, created_at, updated_at, archived_at FROM sessions WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("failed to read renamed session: {e}"))?;
    Ok(row_to_session(&row))
}

/// Archives rather than deletes. Removing a session from the sidebar must be
/// recoverable from Settings > Archive (v1 spec, Capabilities).
pub async fn archive_session_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to archive session: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no active session with id {id}"));
    }
    Ok(())
}

pub async fn restore_session_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query(
        "UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("failed to restore session: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no archived session with id {id}"));
    }
    Ok(())
}

/// Permanent. Only reachable from Settings > Archive, where the user has
/// already said "remove" once and is confirming a second time.
pub async fn delete_session_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to delete session: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no session with id {id}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn create_session(
    db: State<'_, LocalDb>,
    name: String,
    kind: Option<String>,
) -> Result<Session, String> {
    create_session_impl(&db.pool, &name, kind.as_deref()).await
}

#[tauri::command]
pub async fn list_sessions(db: State<'_, LocalDb>) -> Result<Vec<Session>, String> {
    list_sessions_impl(&db.pool, false).await
}

#[tauri::command]
pub async fn list_archived_sessions(db: State<'_, LocalDb>) -> Result<Vec<Session>, String> {
    list_sessions_impl(&db.pool, true).await
}

#[tauri::command]
pub async fn rename_session(db: State<'_, LocalDb>, id: String, name: String) -> Result<Session, String> {
    rename_session_impl(&db.pool, &id, &name).await
}

#[tauri::command]
pub async fn archive_session(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    archive_session_impl(&db.pool, &id).await
}

#[tauri::command]
pub async fn restore_session(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    restore_session_impl(&db.pool, &id).await
}

#[tauri::command]
pub async fn delete_session(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    delete_session_impl(&db.pool, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn creates_and_lists_an_active_session() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Order flow debug", Some("api")).await.unwrap();
        assert_eq!(created.name, "Order flow debug");
        assert_eq!(created.archived_at, None);

        let listed = list_sessions_impl(&db.pool, false).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
    }

    #[tokio::test]
    async fn rejects_a_blank_name() {
        let (_dir, db) = db().await;
        assert!(create_session_impl(&db.pool, "   ", None).await.is_err());
    }

    #[tokio::test]
    async fn archiving_removes_from_the_active_list_but_keeps_the_session_recoverable() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Checkout API", None).await.unwrap();
        archive_session_impl(&db.pool, &created.id).await.unwrap();

        assert_eq!(list_sessions_impl(&db.pool, false).await.unwrap().len(), 0);
        let archived = list_sessions_impl(&db.pool, true).await.unwrap();
        assert_eq!(archived.len(), 1);
        assert!(archived[0].archived_at.is_some());
    }

    #[tokio::test]
    async fn restoring_returns_the_session_to_the_active_list() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Users query", None).await.unwrap();
        archive_session_impl(&db.pool, &created.id).await.unwrap();
        restore_session_impl(&db.pool, &created.id).await.unwrap();

        assert_eq!(list_sessions_impl(&db.pool, false).await.unwrap().len(), 1);
        assert_eq!(list_sessions_impl(&db.pool, true).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn archiving_an_already_archived_session_is_an_error_not_a_silent_no_op() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Twice", None).await.unwrap();
        archive_session_impl(&db.pool, &created.id).await.unwrap();
        assert!(archive_session_impl(&db.pool, &created.id).await.is_err());
    }

    #[tokio::test]
    async fn renaming_updates_the_name_and_the_timestamp() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Old name", None).await.unwrap();
        let renamed = rename_session_impl(&db.pool, &created.id, "New name").await.unwrap();
        assert_eq!(renamed.name, "New name");
        assert_eq!(renamed.id, created.id);
    }

    #[tokio::test]
    async fn deleting_is_permanent_and_reports_an_unknown_id() {
        let (_dir, db) = db().await;
        let created = create_session_impl(&db.pool, "Gone", None).await.unwrap();
        delete_session_impl(&db.pool, &created.id).await.unwrap();
        assert_eq!(list_sessions_impl(&db.pool, true).await.unwrap().len(), 0);
        assert!(delete_session_impl(&db.pool, &created.id).await.is_err());
    }
}
```

- [ ] **Step 2: Register and run**

Add `pub mod sessions;` to `commands/mod.rs` and the seven commands to `generate_handler!`.

Run: `cd apps/devbench/src-tauri && cargo test --lib sessions::`
Expected: PASS (seven tests)

- [ ] **Step 3: Commit**

```bash
git add apps/devbench/src-tauri/src
git commit -m "feat(devbench): add session create/list/rename/archive/restore commands"
```

---

### Task 3: Persist watched tables

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/watched.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Modify: `apps/devbench/src/lib/tauri.ts`
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Test: inline `#[cfg(test)]` module in `watched.rs`

**Interfaces:**
- Produces: `pub fn connection_key(input: &DbConnectInput) -> String` and Tauri commands `list_watched_tables(connection: DbConnectInput) -> Result<Vec<String>, String>`, `set_watched_table(connection: DbConnectInput, table: String, watched: bool) -> Result<(), String>`.

`0001_init.sql` created `watched_tables` and nothing has ever read or written it — all watch state has been Zustand-only and lost on restart. This closes that gap. Watch state is keyed by connection, **not** by session: sessions organize, they never scope (Decision 6), and a watched table belongs to a database, not to an investigation.

`connection_key` deliberately excludes the password — a key is a lookup handle, and putting a credential in a lookup column would put it in every `SELECT` and every debug log.

- [ ] **Step 1: Write the failing tests**

`apps/devbench/src-tauri/src/commands/watched.rs`:
```rust
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::commands::db::{validate_identifier, DbConnectInput};
use crate::local_db::LocalDb;

/// Stable handle for a connection. Deliberately excludes the password: this
/// value lands in a WHERE clause and in error messages, and a credential has
/// no business in either.
pub fn connection_key(input: &DbConnectInput) -> String {
    format!("{}@{}:{}/{}", input.username, input.host, input.port, input.database)
}

pub async fn list_watched_tables_impl(
    pool: &SqlitePool,
    connection: &DbConnectInput,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT table_name FROM watched_tables WHERE connection_key = ? ORDER BY table_name")
        .bind(connection_key(connection))
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to list watched tables: {e}"))?;
    Ok(rows.iter().map(|r| r.get::<String, _>("table_name")).collect())
}

pub async fn set_watched_table_impl(
    pool: &SqlitePool,
    connection: &DbConnectInput,
    table: &str,
    watched: bool,
) -> Result<(), String> {
    // The same validation the snapshot path uses. A stored table name is
    // interpolated into SQL later; rejecting it here means a bad value can
    // never be persisted in the first place.
    validate_identifier(table)?;
    let key = connection_key(connection);
    if watched {
        sqlx::query("INSERT OR IGNORE INTO watched_tables (connection_key, table_name) VALUES (?, ?)")
            .bind(&key)
            .bind(table)
            .execute(pool)
            .await
            .map_err(|e| format!("failed to watch {table}: {e}"))?;
    } else {
        sqlx::query("DELETE FROM watched_tables WHERE connection_key = ? AND table_name = ?")
            .bind(&key)
            .bind(table)
            .execute(pool)
            .await
            .map_err(|e| format!("failed to unwatch {table}: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_watched_tables(
    db: State<'_, LocalDb>,
    connection: DbConnectInput,
) -> Result<Vec<String>, String> {
    list_watched_tables_impl(&db.pool, &connection).await
}

#[tauri::command]
pub async fn set_watched_table(
    db: State<'_, LocalDb>,
    connection: DbConnectInput,
    table: String,
    watched: bool,
) -> Result<(), String> {
    set_watched_table_impl(&db.pool, &connection, &table, watched).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(database: &str) -> DbConnectInput {
        DbConnectInput {
            host: "localhost".into(),
            port: 5432,
            database: database.into(),
            username: "postgres".into(),
            password: "secret".into(),
        }
    }

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[test]
    fn the_connection_key_never_contains_the_password() {
        let key = connection_key(&conn("devbench_test"));
        assert!(!key.contains("secret"));
        assert!(key.contains("devbench_test"));
    }

    #[tokio::test]
    async fn watching_a_table_survives_a_reconnect() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, &conn("shop")).await.unwrap(), vec!["orders"]);
    }

    #[tokio::test]
    async fn unwatching_removes_the_row() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", false).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, &conn("shop")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn watching_the_same_table_twice_is_idempotent() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        assert_eq!(list_watched_tables_impl(&db.pool, &conn("shop")).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn watch_state_is_scoped_per_connection() {
        let (_dir, db) = db().await;
        set_watched_table_impl(&db.pool, &conn("shop"), "orders", true).await.unwrap();
        assert!(list_watched_tables_impl(&db.pool, &conn("staging")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_malicious_table_name_is_rejected_before_it_can_be_persisted() {
        let (_dir, db) = db().await;
        let result =
            set_watched_table_impl(&db.pool, &conn("shop"), "orders; DROP TABLE users; --", true).await;
        assert!(result.is_err());
        assert!(list_watched_tables_impl(&db.pool, &conn("shop")).await.unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Register and run**

Add `pub mod watched;` to `commands/mod.rs` and both commands to `generate_handler!`.

`validate_identifier` is currently `pub(crate)` in `commands/db.rs`, which is already sufficient for `commands::watched` — no visibility change needed.

Run: `cd apps/devbench/src-tauri && cargo test --lib watched::`
Expected: PASS (six tests)

- [ ] **Step 3: Load and persist watch state in the frontend**

Append to `apps/devbench/src/lib/tauri.ts`:
```ts
export function invokeListWatchedTables(connection: DbConnectInput): Promise<string[]> {
  return invoke("list_watched_tables", { connection });
}

export function invokeSetWatchedTable(
  connection: DbConnectInput,
  table: string,
  watched: boolean,
): Promise<void> {
  return invoke("set_watched_table", { connection, table, watched });
}
```

Modify `apps/devbench/src/store/useAppStore.ts` — add a hydration action beside the existing toggle:
```ts
  /** Replaces watch state wholesale, e.g. after loading it from SQLite. */
  setWatchedTables: (tables: string[]) => void;
```
```ts
  setWatchedTables: (tables) => set({ watchedTables: new Set(tables) }),
```

Modify `apps/devbench/src/components/db/DbTab.tsx` — hydrate on mount and write through on toggle:
```tsx
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  // Watch state lives in SQLite, keyed by connection. Hydrate on mount so a
  // restart does not silently reset what the user is watching — which would
  // make the next rollup report "no tables are being watched" for a session
  // the user believes is still configured.
  useEffect(() => {
    invokeListWatchedTables(DEV_CONNECTION)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [setWatchedTables]);

  async function handleToggleWatch(table: string) {
    const nextWatched = !watchedTables.has(table);
    onToggleWatch(table);
    try {
      await invokeSetWatchedTable(DEV_CONNECTION, table, nextWatched);
    } catch {
      // Roll the optimistic toggle back rather than leaving the UI claiming a
      // table is watched when the correlation engine will not see it.
      onToggleWatch(table);
    }
  }
```
and pass `handleToggleWatch` to `<SchemaTree onToggleWatch={...} />` in place of `onToggleWatch`.

- [ ] **Step 4: Run both suites**

Run: `cd apps/devbench/src-tauri && cargo test` then `cd apps/devbench && bun run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/src apps/devbench/src
git commit -m "feat(devbench): persist watched tables per connection in SQLite"
```

---

## Group B — Shell & Sessions

### Task 4: Base UI, `ToolTabs`, `TopBar`, and the three-column shell

**Files:**
- Modify: `apps/devbench/package.json`
- Create: `apps/devbench/src/components/shell/ToolTabs.tsx`
- Create: `apps/devbench/src/components/shell/TopBar.tsx`
- Create: `apps/devbench/src/components/shell/TopBar.test.tsx`
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/store/useAppStore.test.ts`
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/App.test.tsx`

**Interfaces:**
- Produces:
  - `<ToolTabs value={TabId} onValueChange={(t: TabId) => void} />` — **the only file in the app that imports Base UI.**
  - `<TopBar onToggleChat={() => void} chatOpen={boolean} theme={ThemePref} onCycleTheme={() => void} />`
  - Store additions: `chatOpen: boolean` / `setChatOpen`, `route: "workspace" | "settings"` / `setRoute`, `activeSessionId: string | null` / `setActiveSessionId`.
  Task 5 mounts the sessions sidebar into this shell; Task 6 replaces the single content pane with `SplitContent`.

`DESIGN.md` is specific about what goes where: "The global topbar carries only identity and app-wide actions (theme, chat toggle, settings) — the tool tabs live in the main column, not the topbar, since tabs are part of what a session shows, not global chrome that exists independent of any session." The rewrite below follows that exactly. Note the Settings entry point is the button pinned to the **bottom of the sessions sidebar**, not a topbar icon — the spec calls that out explicitly ("not a topbar icon, to avoid two ways in"), so `TopBar` carries theme and chat only.

- [ ] **Step 1: Add Base UI, pinned exactly**

Modify `apps/devbench/package.json`, under `dependencies`:
```json
    "@base-ui-components/react": "1.0.0-rc.0"
```

No caret. This is a release candidate (Decision 1); an automatic patch bump is not something we want to discover at runtime.

Run: `bun install`

- [ ] **Step 2: Write `ToolTabs`**

`apps/devbench/src/components/shell/ToolTabs.tsx`:
```tsx
import { Tabs } from "@base-ui-components/react/tabs";
import type { TabId } from "../../store/useAppStore";

/**
 * Single source of truth for the tool tabs. Adding a fifth tool is one entry
 * here (see the post-v1 roadmap: outbound HTTP inspector, jobs, cache…).
 */
export const TABS: { id: TabId; label: string }[] = [
  { id: "api", label: "API" },
  { id: "db", label: "DB" },
  { id: "log", label: "Log" },
  { id: "email", label: "Email" },
];

/**
 * The app's ONLY Base UI import. Base UI is here for the behaviour a hand-
 * rolled tab bar keeps getting wrong — roving tabindex, arrow-key navigation,
 * correct `tablist`/`tab` wiring — across the three tab bars this plan creates
 * (tools, split-pane tools, settings nav). Keeping the import in one file means
 * dropping the dependency later is a one-file change.
 *
 * Styling is entirely ours: ghosty per DESIGN.md — transparent until hover,
 * hairline border, no blur, `--radius-sm`.
 */
export function ToolTabs({
  value,
  onValueChange,
  children,
}: {
  value: TabId;
  onValueChange: (tab: TabId) => void;
  children?: React.ReactNode;
}) {
  return (
    <Tabs.Root
      value={value}
      onValueChange={(next) => onValueChange(next as TabId)}
      className="flex items-center gap-1 border-b border-border px-2"
    >
      <Tabs.List className="flex gap-1" aria-label="DevBench tools">
        {TABS.map((tab) => (
          <Tabs.Tab
            key={tab.id}
            value={tab.id}
            // Base UI 1.0.0-rc.0 renamed `[data-selected]` to `[data-active]`
            // on `<Tabs.Tab>` (see its CHANGELOG). Setting `data-selected`
            // explicitly from `value` is what makes the Tailwind variant below
            // actually match — without it, the selected-tab highlight is dead
            // CSS that never activates.
            data-selected={tab.id === value ? "" : undefined}
            className="rounded-sm px-3 py-2 text-sm font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 data-[selected]:bg-surface-2 data-[selected]:text-text"
          >
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {children}
    </Tabs.Root>
  );
}
```

- [ ] **Step 3: Write the failing `TopBar` test**

`apps/devbench/src/components/shell/TopBar.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

describe("TopBar", () => {
  it("shows the product identity", () => {
    render(<TopBar chatOpen theme="dark" onToggleChat={() => {}} onCycleTheme={() => {}} />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
  });

  it("toggles the chat dock and reflects its state", () => {
    const onToggleChat = vi.fn();
    const { rerender } = render(
      <TopBar chatOpen theme="dark" onToggleChat={onToggleChat} onCycleTheme={() => {}} />,
    );
    const button = screen.getByRole("button", { name: /toggle ai chat/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleChat).toHaveBeenCalled();

    rerender(<TopBar chatOpen={false} theme="dark" onToggleChat={onToggleChat} onCycleTheme={() => {}} />);
    expect(screen.getByRole("button", { name: /toggle ai chat/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("cycles the theme", () => {
    const onCycleTheme = vi.fn();
    render(<TopBar chatOpen theme="light" onToggleChat={() => {}} onCycleTheme={onCycleTheme} />);
    fireEvent.click(screen.getByRole("button", { name: /theme/i }));
    expect(onCycleTheme).toHaveBeenCalled();
  });

  // DESIGN.md: the topbar carries identity and app-wide actions only. Settings
  // is entered from the sessions sidebar, deliberately, to avoid two ways in.
  it("does not offer a settings entry point", () => {
    render(<TopBar chatOpen theme="dark" onToggleChat={() => {}} onCycleTheme={() => {}} />);
    expect(screen.queryByRole("button", { name: /settings/i })).not.toBeInTheDocument();
  });
});
```

Run: `bun run test -- TopBar.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 4: Implement `TopBar`**

`apps/devbench/src/components/shell/TopBar.tsx`:
```tsx
import type { ThemePref } from "../../store/useAppStore";

/**
 * The product mark: one origin node fanning into three connected nodes —
 * one request, three observed effects (DB / Log / Email). DESIGN.md picks this
 * over a letter-in-a-rounded-square precisely because it encodes the mechanic.
 */
function BrandMark() {
  return (
    <span aria-hidden="true" className="text-text">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
        <circle cx="12" cy="5" r="2" fill="currentColor" />
        <circle cx="5" cy="19" r="2" fill="currentColor" />
        <circle cx="12" cy="19" r="2" fill="currentColor" />
        <circle cx="19" cy="19" r="2" fill="currentColor" />
        <path
          d="M12 7v5M12 12L5 17M12 12v5M12 12l7 5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

const THEME_LABEL: Record<ThemePref, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

export function TopBar({
  chatOpen,
  theme,
  onToggleChat,
  onCycleTheme,
}: {
  chatOpen: boolean;
  theme: ThemePref;
  onToggleChat: () => void;
  onCycleTheme: () => void;
}) {
  return (
    // Ghosty: transparent, hairline division, no blur (DESIGN.md).
    <header className="flex h-13 shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2">
        <BrandMark />
        <span className="font-bold text-text">DevBench</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          aria-label={`Theme: ${THEME_LABEL[theme]}`}
          onClick={onCycleTheme}
          className="rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          {THEME_LABEL[theme]}
        </button>
        <button
          aria-label="Toggle AI chat"
          aria-pressed={chatOpen}
          onClick={onToggleChat}
          className="rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text aria-pressed:text-text"
        >
          Chat
        </button>
      </div>
    </header>
  );
}
```

Run: `bun run test -- TopBar.test.tsx`
Expected: PASS

- [ ] **Step 5: Extend the store**

Append to `apps/devbench/src/store/useAppStore.test.ts`:
```ts
  it("opens the chat dock by default and can close it", () => {
    expect(useAppStore.getState().chatOpen).toBe(true);
    useAppStore.getState().setChatOpen(false);
    expect(useAppStore.getState().chatOpen).toBe(false);
  });

  it("routes between the workspace and settings", () => {
    expect(useAppStore.getState().route).toBe("workspace");
    useAppStore.getState().setRoute("settings");
    expect(useAppStore.getState().route).toBe("settings");
    useAppStore.getState().setRoute("workspace");
  });

  it("tracks the active session", () => {
    useAppStore.getState().setActiveSessionId("sess-1");
    expect(useAppStore.getState().activeSessionId).toBe("sess-1");
  });
```

Run: `bun run test -- useAppStore.test.ts` → FAIL.

Modify `apps/devbench/src/store/useAppStore.ts` — add to the interface and the initializer:
```ts
export type AppRoute = "workspace" | "settings";
```
```ts
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  route: AppRoute;
  setRoute: (route: AppRoute) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
```
```ts
  chatOpen: true,
  setChatOpen: (open) => set({ chatOpen: open }),
  route: "workspace",
  setRoute: (route) => set({ route }),
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),
```

Run: `bun run test -- useAppStore.test.ts`
Expected: PASS

- [ ] **Step 6: Rewrite `App.tsx` as the three-column shell**

Replace `apps/devbench/src/App.tsx`:
```tsx
import { useEffect, useState } from "react";
import { useAppStore, type ThemePref } from "./store/useAppStore";
import { TopBar } from "./components/shell/TopBar";
import { ToolTabs, TABS } from "./components/shell/ToolTabs";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { ChatDock } from "./components/shell/ChatDock";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { ApiTab } from "./components/api/ApiTab";
import { DbTab } from "./components/db/DbTab";
import { LogTab } from "./components/log/LogTab";
import { EmailTab } from "./components/email/EmailTab";

export { TABS };

const THEME_CYCLE: ThemePref[] = ["system", "dark", "light"];

export default function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);
  const chatOpen = useAppStore((s) => s.chatOpen);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const route = useAppStore((s) => s.route);
  const setRoute = useAppStore((s) => s.setRoute);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const [dbFocusTable, setDbFocusTable] = useState<string | null>(null);
  const [emailFocusId, setEmailFocusId] = useState<number | null>(null);

  // DESIGN.md's token precedence: base `:root` is dark, a
  // `prefers-color-scheme: light` media query overrides it, and an explicit
  // `data-theme` wins over both. "system" therefore means REMOVING the
  // attribute so the media query is back in charge — not setting it to
  // "system", which matches no selector.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  function cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
    setTheme(next);
  }

  if (route === "settings") {
    return (
      <div className="flex h-screen flex-col">
        <TopBar chatOpen={chatOpen} theme={theme} onToggleChat={() => setChatOpen(!chatOpen)} onCycleTheme={cycleTheme} />
        <SettingsScreen onBack={() => setRoute("workspace")} />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar chatOpen={chatOpen} theme={theme} onToggleChat={() => setChatOpen(!chatOpen)} onCycleTheme={cycleTheme} />
      {/* Three columns. The chat dock RESIZES this row rather than overlaying
          it — it is a grid track, not a fixed-position panel (DESIGN.md). */}
      <div className="flex min-h-0 flex-1">
        <SessionsSidebar onOpenSettings={() => setRoute("settings")} />
        <div className="flex min-w-0 flex-1 flex-col">
          <ToolTabs value={activeTab} onValueChange={setActiveTab} />
          <main className="min-h-0 flex-1 overflow-y-auto p-6">
            {activeTab === "api" ? (
              <ApiTab onOpenTableInDb={setDbFocusTable} onOpenEmail={setEmailFocusId} />
            ) : null}
            {activeTab === "db" ? (
              <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
            ) : null}
            {activeTab === "log" ? <LogTab /> : null}
            {activeTab === "email" ? <EmailTab focusEmailId={emailFocusId} /> : null}
          </main>
        </div>
        {chatOpen ? <ChatDock onClose={() => setChatOpen(false)} /> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Update `App.test.tsx` for the new shell**

Replace `apps/devbench/src/App.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";
import { useAppStore } from "./store/useAppStore";

describe("App shell", () => {
  it("renders the three-column workspace with one tab per tool", () => {
    render(<App />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["API", "DB", "Log", "Email"]);
    expect(screen.getByRole("complementary", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "AI Assistant" })).toBeInTheDocument();
  });

  it("hides the chat dock when it is toggled off, without overlaying the content", () => {
    useAppStore.getState().setChatOpen(false);
    render(<App />);
    expect(screen.queryByRole("complementary", { name: "AI Assistant" })).not.toBeInTheDocument();
    useAppStore.getState().setChatOpen(true);
  });

  it("navigates to the settings screen", () => {
    useAppStore.getState().setRoute("settings");
    render(<App />);
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab").map((t) => t.textContent)).not.toContain("Email");
    useAppStore.getState().setRoute("workspace");
  });
});
```

These fail until Tasks 5 and 8 create `SessionsSidebar`, `ChatDock`, and `SettingsScreen`. Do Tasks 5–8 before expecting a green suite.

- [ ] **Step 8: Commit**

```bash
git add apps/devbench/package.json apps/devbench/src
git commit -m "feat(devbench): add Base UI tool tabs, topbar, and the three-column shell"
```

---

### Task 5: `SessionsSidebar` and the New Session picker

**Files:**
- Create: `apps/devbench/src/components/shell/SessionsSidebar.tsx`
- Create: `apps/devbench/src/components/shell/SessionsSidebar.test.tsx`
- Create: `apps/devbench/src/components/shell/NewSessionDialog.tsx`
- Create: `apps/devbench/src/components/shell/NewSessionDialog.test.tsx`
- Modify: `apps/devbench/src/lib/tauri.ts`

**Interfaces:**
- Consumes: the session commands from Task 2.
- Produces: `<SessionsSidebar onOpenSettings={() => void} />` and `<NewSessionDialog open onCreate onCancel />`, plus wrappers `invokeCreateSession`, `invokeListSessions`, `invokeListArchivedSessions`, `invokeRenameSession`, `invokeArchiveSession`, `invokeRestoreSession`, `invokeDeleteSession`. Task 12 reuses the archived-list and restore/delete wrappers.

The New Session picker is **the only glass surface in the app** (`DESIGN.md`: glass is reserved for transient overlays — the New Session picker and the command palette; everything persistent is ghosty). It therefore carries `backdrop-filter` *and* a solid fallback under `prefers-reduced-transparency`, which is not optional in that rule.

- [ ] **Step 1: Add the wrappers**

Append to `apps/devbench/src/lib/tauri.ts`:
```ts
export interface Session {
  id: string;
  name: string;
  kind: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function invokeCreateSession(name: string, kind?: string): Promise<Session> {
  return invoke("create_session", { name, kind: kind ?? null });
}
export function invokeListSessions(): Promise<Session[]> {
  return invoke("list_sessions");
}
export function invokeListArchivedSessions(): Promise<Session[]> {
  return invoke("list_archived_sessions");
}
export function invokeRenameSession(id: string, name: string): Promise<Session> {
  return invoke("rename_session", { id, name });
}
export function invokeArchiveSession(id: string): Promise<void> {
  return invoke("archive_session", { id });
}
export function invokeRestoreSession(id: string): Promise<void> {
  return invoke("restore_session", { id });
}
export function invokeDeleteSession(id: string): Promise<void> {
  return invoke("delete_session", { id });
}
```

- [ ] **Step 2: Write the failing dialog test**

`apps/devbench/src/components/shell/NewSessionDialog.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewSessionDialog } from "./NewSessionDialog";

describe("NewSessionDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<NewSessionDialog open={false} onCreate={() => {}} onCancel={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("creates a session with the entered name", () => {
    const onCreate = vi.fn();
    render(<NewSessionDialog open onCreate={onCreate} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Order flow debug"), {
      target: { value: "Checkout API" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onCreate).toHaveBeenCalledWith("Checkout API");
  });

  it("does not create a session with a blank name", () => {
    const onCreate = vi.fn();
    render(<NewSessionDialog open onCreate={onCreate} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<NewSessionDialog open onCreate={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
```

Run: `bun run test -- NewSessionDialog.test.tsx` → FAIL.

- [ ] **Step 3: Implement `NewSessionDialog`**

`apps/devbench/src/components/shell/NewSessionDialog.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";

export function NewSessionDialog({
  open,
  onCreate,
  onCancel,
}: {
  open: boolean;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  function submit() {
    if (!name.trim()) return;
    onCreate(name.trim());
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New session"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter") submit();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-32"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {/* The ONLY glass surface in the app: transient overlay, so blur is
          earned here and nowhere else (DESIGN.md). The
          `prefers-reduced-transparency` fallback is part of the rule, not an
          extra — a translucent panel with no fallback is a broken surface for
          anyone who has asked the OS to stop doing that. */}
      <div
        className="w-100 rounded-lg border border-border p-4 shadow-2xl backdrop-blur-[24px] backdrop-saturate-150"
        style={{
          background: "color-mix(in srgb, var(--surface) 72%, transparent)",
          boxShadow: "inset 0 1px 0 0 rgb(255 255 255 / 0.06)",
        }}
      >
        <div className="mb-3 text-sm font-bold text-text">New session</div>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Order flow debug"
          className="w-full rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text"
        />
        <div className="mt-2 text-[11px] text-text-faint">
          A session is a named investigation. It never limits which tools you can use.
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-sm px-3 py-1.5 text-sm text-text-muted hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-sm bg-accent px-3 py-1.5 text-sm font-bold text-accent-on"
          >
            Create session
          </button>
        </div>
      </div>
    </div>
  );
}
```

Add the reduced-transparency fallback to `apps/devbench/src/styles/globals.css`:
```css
@media (prefers-reduced-transparency: reduce) {
  .backdrop-blur-\[24px\] {
    backdrop-filter: none;
    background: var(--surface) !important;
  }
}
```

Run: `bun run test -- NewSessionDialog.test.tsx`
Expected: PASS

- [ ] **Step 4: Write the failing sidebar test**

`apps/devbench/src/components/shell/SessionsSidebar.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SessionsSidebar } from "./SessionsSidebar";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";

const sessions = [
  { id: "a", name: "Order flow debug", kind: "api", created_at: "", updated_at: "", archived_at: null },
  { id: "b", name: "Checkout API", kind: null, created_at: "", updated_at: "", archived_at: null },
];

describe("SessionsSidebar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.getState().setActiveSessionId(null);
  });

  it("lists sessions", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => expect(screen.getByText("Order flow debug")).toBeInTheDocument());
  });

  it("selects a session", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => screen.getByText("Checkout API"));
    // Each row also has an "Archive <name>" button, whose accessible name is a
    // superstring of the session name — a regex matcher here would match both
    // buttons and getByRole would throw "Found multiple elements". Use the
    // exact string so only the select button matches.
    fireEvent.click(screen.getByRole("button", { name: "Checkout API" }));
    expect(useAppStore.getState().activeSessionId).toBe("b");
  });

  // The spec is explicit: removing from the sidebar archives, it never deletes.
  it("archives rather than deletes when a session is removed", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    const archive = vi.spyOn(tauriLib, "invokeArchiveSession").mockResolvedValue(undefined);
    const del = vi.spyOn(tauriLib, "invokeDeleteSession").mockResolvedValue(undefined);
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => screen.getByText("Order flow debug"));
    fireEvent.click(screen.getByRole("button", { name: "Archive Order flow debug" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith("a"));
    expect(del).not.toHaveBeenCalled();
  });

  it("creates a session through the picker", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue([]);
    const create = vi
      .spyOn(tauriLib, "invokeCreateSession")
      .mockResolvedValue({ ...sessions[0], id: "new" });
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(screen.getByPlaceholderText("Order flow debug"), {
      target: { value: "Payment webhook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("Payment webhook"));
  });

  // The spec puts the ONE settings entry point at the bottom of this sidebar.
  it("offers the only settings entry point", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue([]);
    const onOpenSettings = vi.fn();
    render(<SessionsSidebar onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows an empty state rather than a bare list", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue([]);
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument());
  });
});
```

Run: `bun run test -- SessionsSidebar.test.tsx` → FAIL.

- [ ] **Step 5: Implement `SessionsSidebar`**

`apps/devbench/src/components/shell/SessionsSidebar.tsx`:
```tsx
import { useCallback, useEffect, useState } from "react";
import { NewSessionDialog } from "./NewSessionDialog";
import { useAppStore } from "../../store/useAppStore";
import {
  invokeArchiveSession,
  invokeCreateSession,
  invokeListSessions,
  type Session,
} from "../../lib/tauri";

export function SessionsSidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await invokeListSessions());
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(name: string) {
    setShowNew(false);
    try {
      const created = await invokeCreateSession(name);
      setActiveSessionId(created.id);
      await refresh();
    } catch {
      await refresh();
    }
  }

  async function handleArchive(id: string) {
    try {
      await invokeArchiveSession(id);
      if (activeSessionId === id) setActiveSessionId(null);
    } finally {
      await refresh();
    }
  }

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? sessions.filter(
        (s) => s.name.toLowerCase().includes(needle) || (s.kind ?? "").toLowerCase().includes(needle),
      )
    : sessions;

  return (
    // Ghosty: transparent, hairline division, no blur.
    <aside aria-label="Sessions" className="flex w-60 min-w-60 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border p-2.5 text-xs font-bold text-text-muted">
        Sessions
        <button
          onClick={() => setShowNew(true)}
          className="rounded-sm px-1.5 py-0.5 transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          New session
        </button>
      </div>

      <div className="p-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          className="w-full rounded-sm border border-border bg-bg px-2 py-1.5 text-xs text-text"
        />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        {visible.length === 0 ? (
          <div className="p-2 text-xs text-text-faint">
            {sessions.length === 0
              ? "No sessions yet. Create one to name and return to an investigation."
              : `No sessions match “${query}”.`}
          </div>
        ) : (
          visible.map((session) => (
            <div key={session.id} className="flex items-center gap-1">
              <button
                onClick={() => setActiveSessionId(session.id)}
                aria-current={activeSessionId === session.id}
                className={`flex flex-1 items-center justify-between gap-2 rounded-sm p-2 text-left text-xs transition-colors duration-150 ${
                  activeSessionId === session.id
                    ? "bg-surface-2 text-text"
                    : "text-text-muted hover:bg-surface-2"
                }`}
              >
                <span className="truncate">{session.name}</span>
                {/* Auto-inferred tag for scanning — never a gate on which
                    tools are visible (v1 spec). */}
                {session.kind ? (
                  <span className="shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-faint">
                    {session.kind}
                  </span>
                ) : null}
              </button>
              <button
                aria-label={`Archive ${session.name}`}
                onClick={() => void handleArchive(session.id)}
                className="rounded-sm px-1.5 text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border p-1.5">
        {/* The spec's single Settings entry point. Deliberately not in the
            topbar, to avoid two ways in. */}
        <button
          onClick={onOpenSettings}
          className="w-full rounded-sm p-2 text-left text-xs text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          Settings
        </button>
      </div>

      <NewSessionDialog open={showNew} onCreate={handleCreate} onCancel={() => setShowNew(false)} />
    </aside>
  );
}
```

Run: `bun run test -- SessionsSidebar.test.tsx`
Expected: PASS (six tests)

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src
git commit -m "feat(devbench): add the sessions sidebar with archive lifecycle and glass picker"
```

---

## Group C — Split view

### Task 6: Two independently-tabbed panes

**Files:**
- Create: `apps/devbench/src/components/shell/ToolPane.tsx`
- Create: `apps/devbench/src/components/shell/SplitContent.tsx`
- Create: `apps/devbench/src/components/shell/SplitContent.test.tsx`
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/App.tsx`

**Interfaces:**
- Consumes: `ToolTabs` / `TABS` (Task 4).
- Produces: `<SplitContent {...deepLinkProps} />` replacing the single `<main>`, and store fields `splitOpen: boolean` / `setSplitOpen`, `secondaryTab: TabId` / `setSecondaryTab`. `activeTab` remains the primary pane's tool, so every existing deep-link (`setActiveTab("db")` from the rollup) keeps working unchanged.

`DESIGN.md`: "a 'Split' control divides the content into two independently-tabbed panes — any of the four tools in either pane — following VS Code's split-editor pattern rather than inventing a new interaction." Two panes, not N: the spec says "any two tools", and a resizable N-pane grid is a different feature.

- [ ] **Step 1: Extend the store**

Modify `apps/devbench/src/store/useAppStore.ts`:
```ts
  /** Whether the content area is split into two panes. Per-session UI state. */
  splitOpen: boolean;
  setSplitOpen: (open: boolean) => void;
  /** The tool shown in the second pane. `activeTab` remains the first pane. */
  secondaryTab: TabId;
  setSecondaryTab: (tab: TabId) => void;
```
```ts
  splitOpen: false,
  setSplitOpen: (open) => set({ splitOpen: open }),
  secondaryTab: "db",
  setSecondaryTab: (tab) => set({ secondaryTab: tab }),
```

- [ ] **Step 2: Write the failing test**

`apps/devbench/src/components/shell/SplitContent.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { SplitContent } from "./SplitContent";
import { useAppStore } from "../../store/useAppStore";

function renderSplit() {
  return render(
    <SplitContent
      dbFocusTable={null}
      emailFocusId={null}
      onOpenTableInDb={() => {}}
      onOpenEmail={() => {}}
    />,
  );
}

describe("SplitContent", () => {
  beforeEach(() => {
    useAppStore.getState().setSplitOpen(false);
    useAppStore.getState().setActiveTab("api");
    useAppStore.getState().setSecondaryTab("db");
  });

  it("shows one tab bar when not split", () => {
    renderSplit();
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("opens a second, independently-tabbed pane", () => {
    renderSplit();
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(useAppStore.getState().splitOpen).toBe(true);
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });

  it("keeps the two panes' tools independent", () => {
    useAppStore.getState().setSplitOpen(true);
    renderSplit();
    const [primary, secondary] = screen.getAllByRole("tablist");
    fireEvent.click(within(secondary).getByRole("tab", { name: "Log" }));
    expect(useAppStore.getState().secondaryTab).toBe("log");
    expect(useAppStore.getState().activeTab).toBe("api");
    expect(within(primary).getByRole("tab", { name: "API" })).toHaveAttribute("data-selected");
  });

  it("closes the split", () => {
    useAppStore.getState().setSplitOpen(true);
    renderSplit();
    fireEvent.click(screen.getByRole("button", { name: "Close split" }));
    expect(useAppStore.getState().splitOpen).toBe(false);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });
});
```

Add `import { within } from "@testing-library/react";` to the import line.

Run: `bun run test -- SplitContent.test.tsx` → FAIL.

- [ ] **Step 3: Implement `ToolPane` and `SplitContent`**

`apps/devbench/src/components/shell/ToolPane.tsx`:
```tsx
import type { TabId } from "../../store/useAppStore";
import { ApiTab } from "../api/ApiTab";
import { DbTab } from "../db/DbTab";
import { LogTab } from "../log/LogTab";
import { EmailTab } from "../email/EmailTab";
import { useAppStore } from "../../store/useAppStore";

/**
 * Renders one tool. Both panes use this, which is what keeps "any of the four
 * tools in either pane" true by construction rather than by discipline.
 */
export function ToolPane({
  tab,
  dbFocusTable,
  emailFocusId,
  onOpenTableInDb,
  onOpenEmail,
}: {
  tab: TabId;
  dbFocusTable: string | null;
  emailFocusId: number | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);

  switch (tab) {
    case "api":
      return <ApiTab onOpenTableInDb={onOpenTableInDb} onOpenEmail={onOpenEmail} />;
    case "db":
      return (
        <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
      );
    case "log":
      return <LogTab />;
    case "email":
      return <EmailTab focusEmailId={emailFocusId} />;
  }
}
```

`apps/devbench/src/components/shell/SplitContent.tsx`:
```tsx
import { ToolTabs } from "./ToolTabs";
import { ToolPane } from "./ToolPane";
import { useAppStore } from "../../store/useAppStore";

export function SplitContent({
  dbFocusTable,
  emailFocusId,
  onOpenTableInDb,
  onOpenEmail,
}: {
  dbFocusTable: string | null;
  emailFocusId: number | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
}) {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const secondaryTab = useAppStore((s) => s.secondaryTab);
  const setSecondaryTab = useAppStore((s) => s.setSecondaryTab);
  const splitOpen = useAppStore((s) => s.splitOpen);
  const setSplitOpen = useAppStore((s) => s.setSplitOpen);

  const paneProps = { dbFocusTable, emailFocusId, onOpenTableInDb, onOpenEmail };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The primary pane's tab bar owns `activeTab`, so every existing
            deep-link (`setActiveTab("db")` from the rollup) lands here
            unchanged whether or not the split is open. */}
        <ToolTabs value={activeTab} onValueChange={setActiveTab}>
          <button
            onClick={() => setSplitOpen(!splitOpen)}
            className="ml-auto rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
          >
            Split
          </button>
        </ToolTabs>
        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <ToolPane tab={activeTab} {...paneProps} />
        </main>
      </div>

      {splitOpen ? (
        <div className="flex min-w-0 flex-1 flex-col border-l border-border">
          <ToolTabs value={secondaryTab} onValueChange={setSecondaryTab}>
            <button
              aria-label="Close split"
              onClick={() => setSplitOpen(false)}
              className="ml-auto rounded-sm px-2.5 py-1.5 text-xs text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
            >
              ✕
            </button>
          </ToolTabs>
          <main className="min-h-0 flex-1 overflow-y-auto p-6">
            <ToolPane tab={secondaryTab} {...paneProps} />
          </main>
        </div>
      ) : null}
    </div>
  );
}
```

The close button's accessible name comes from `aria-label="Close split"`, matching the test.

- [ ] **Step 4: Use `SplitContent` in `App.tsx`**

Replace the `<div className="flex min-w-0 flex-1 flex-col">…</div>` block from Task 4's `App.tsx` with:
```tsx
        <SplitContent
          dbFocusTable={dbFocusTable}
          emailFocusId={emailFocusId}
          onOpenTableInDb={setDbFocusTable}
          onOpenEmail={setEmailFocusId}
        />
```
and drop the now-unused `ToolTabs`, `ApiTab`, `DbTab`, `LogTab`, `EmailTab`, `watchedTables`, and `toggleWatchedTable` imports/selectors from `App.tsx` — they moved into `ToolPane`.

- [ ] **Step 5: Run and commit**

Run: `bun run test -- SplitContent.test.tsx`
Expected: PASS (four tests)

```bash
git add apps/devbench/src
git commit -m "feat(devbench): add split view with two independently-tabbed panes"
```

---

### Task 7: Make the DB table tree keyboard-navigable

**Files:**
- Modify: `apps/devbench/src/components/db/SchemaTree.tsx`
- Modify: `apps/devbench/src/components/db/SchemaTree.test.tsx`

**Interfaces:** No change to the component's props. This is a pure accessibility fix.

The v1 spec names this defect as part of its rationale for the UI-primitives decision: "the session list, DB table tree, and email inbox are plain clickable `<div>`s today, not keyboard-navigable list/tab primitives." The session list (Task 5) and email inbox (Plan 3) were built with buttons. `SchemaTree` is the one left, and shipping a v1 with a control reachable only by mouse is worse than the ten lines it costs to fix.

The subtlety: the row currently nests a `<button>` (the watch toggle) inside a `<div onClick>`. Promoting the outer `<div>` to a `<button>` would nest interactive elements, which is invalid HTML and produces unpredictable focus behaviour. The fix makes them **siblings** in a flex row.

- [ ] **Step 1: Write the failing test**

Append to `apps/devbench/src/components/db/SchemaTree.test.tsx`:
```tsx
  it("exposes each table as a keyboard-reachable button, not a clickable div", async () => {
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    const onSelectTable = vi.fn();

    render(
      <SchemaTree
        connection={connection}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={onSelectTable}
      />,
    );

    await waitFor(() => screen.getByText("orders"));
    const select = screen.getByRole("button", { name: "Browse orders" });
    select.focus();
    expect(select).toHaveFocus();
    fireEvent.click(select);
    expect(onSelectTable).toHaveBeenCalledWith("orders");
  });

  // Nesting a <button> inside a <button> is invalid HTML and breaks focus.
  it("keeps the watch toggle a sibling of the select button, never nested", async () => {
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    render(
      <SchemaTree
        connection={connection}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
      />,
    );
    await waitFor(() => screen.getByText("orders"));
    const watch = screen.getByRole("button", { name: "watch orders" });
    expect(watch.querySelector("button")).toBeNull();
    expect(watch.closest("button")).toBe(watch);
  });
```

Run: `bun run test -- SchemaTree.test.tsx` → FAIL (no button named "Browse orders").

- [ ] **Step 2: Replace the clickable div with sibling buttons**

Modify the row in `apps/devbench/src/components/db/SchemaTree.tsx`:
```tsx
          {tables.map((t) => (
            <div
              key={`${t.schema}.${t.name}`}
              className={`flex items-center gap-1.5 rounded-sm p-1.5 ${
                selected === t.name ? "bg-surface-2 text-text" : "text-text-muted"
              }`}
            >
              {/* Siblings, not nested: a <button> inside a <button> is invalid
                  HTML and yields unpredictable focus and activation. */}
              <button
                type="button"
                aria-label={`watch ${t.name}`}
                aria-pressed={watchedTables.has(t.name)}
                onClick={() => onToggleWatch(t.name)}
                className={`h-2.5 w-2.5 flex-shrink-0 rounded-full border ${
                  watchedTables.has(t.name) ? "border-text bg-text" : "border-text-faint"
                }`}
              />
              <button
                type="button"
                aria-label={`Browse ${t.name}`}
                aria-current={selected === t.name}
                onClick={() => select(t.name)}
                className="flex-1 truncate text-left"
              >
                {t.name}
              </button>
            </div>
          ))}
```

Run: `bun run test -- SchemaTree.test.tsx`
Expected: PASS — including the existing watch-toggle test, whose `e.stopPropagation()` is no longer needed but harmless to remove along with it.

- [ ] **Step 3: Commit**

```bash
git add apps/devbench/src/components/db
git commit -m "fix(devbench): make DB table rows keyboard-reachable buttons"
```

---

## Group D — Settings & Chat

### Task 8: The Settings screen and its vertical nav

**Files:**
- Create: `apps/devbench/src/components/settings/SettingsScreen.tsx`
- Create: `apps/devbench/src/components/settings/SettingsScreen.test.tsx`
- Modify: `apps/devbench/src/lib/tauri.ts`

**Interfaces:**
- Produces: `<SettingsScreen onBack={() => void} />`, which owns the pane routing and mounts `GeneralPane` (Task 9), `ProviderPane` (Task 10), `McpPane` (Task 12), and `ArchivePane` (Task 13). Plus `invokeGetSettings` / `invokeSetSetting` wrappers.

`DESIGN.md` records this as a worked example of its own chrome rule: Settings "was first built as a glass overlay, then moved to a full navigated screen… Once it stopped being transient, it correctly stopped being glass — same rule, applied to a changed circumstance, not a new rule." So: a navigated screen that swaps the body out, ghosty chrome, no blur. The nav uses the same Base UI `Tabs` primitive as the tool bar, with `orientation="vertical"`.

- [ ] **Step 1: Add the settings wrappers**

Append to `apps/devbench/src/lib/tauri.ts`:
```ts
export interface AppSettings {
  theme: string;
  correlation_window_ms: number;
  smtp_port: number;
  provider: string;
  model: string;
}

export function invokeGetSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export function invokeSetSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value });
}
```

- [ ] **Step 2: Write the failing test**

`apps/devbench/src/components/settings/SettingsScreen.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SettingsScreen } from "./SettingsScreen";
import * as tauriLib from "../../lib/tauri";

const settings = {
  theme: "dark",
  correlation_window_ms: 5000,
  smtp_port: 1025,
  provider: "anthropic",
  model: "claude-opus-5",
};

describe("SettingsScreen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(settings);
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({ has_key: false, provider: "anthropic", model: "claude-opus-5" });
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([]);
  });

  it("offers the four settings sections from the spec", async () => {
    render(<SettingsScreen onBack={() => {}} />);
    await waitFor(() => screen.getByRole("heading", { name: "General" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "General",
      "Provider",
      "MCP",
      "Archive",
    ]);
  });

  it("starts on General", async () => {
    render(<SettingsScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument());
  });

  it("switches panes", async () => {
    render(<SettingsScreen onBack={() => {}} />);
    await waitFor(() => screen.getByRole("heading", { name: "General" }));
    fireEvent.click(screen.getByRole("tab", { name: "Provider" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Provider" })).toBeInTheDocument());
  });

  it("navigates back to the workspace", async () => {
    const onBack = vi.fn();
    render(<SettingsScreen onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back to devbench/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
```

Run: `bun run test -- SettingsScreen.test.tsx` → FAIL.

- [ ] **Step 3: Implement `SettingsScreen`**

`apps/devbench/src/components/settings/SettingsScreen.tsx`:
```tsx
import { useState } from "react";
import { Tabs } from "@base-ui-components/react/tabs";
import { GeneralPane } from "./GeneralPane";
import { ProviderPane } from "./ProviderPane";
import { McpPane } from "./McpPane";
import { ArchivePane } from "./ArchivePane";

type PaneId = "general" | "provider" | "mcp" | "archive";

const PANES: { id: PaneId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "provider", label: "Provider" },
  { id: "mcp", label: "MCP" },
  { id: "archive", label: "Archive" },
];

/**
 * A full navigated screen, not an overlay: a 4-section surface does not fit a
 * compact modal, and app-wide config is not scoped to any session the way the
 * four tools are (v1 spec, Components). Because it is persistent rather than
 * transient, it is ghosty — no blur. That is the same DESIGN.md rule the New
 * Session picker satisfies by being glass.
 */
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [pane, setPane] = useState<PaneId>("general");

  return (
    <div className="flex min-h-0 flex-1">
      <Tabs.Root
        value={pane}
        onValueChange={(next) => setPane(next as PaneId)}
        orientation="vertical"
        className="flex min-h-0 flex-1"
      >
        <aside className="flex w-56 min-w-56 flex-col border-r border-border p-1.5">
          <button
            onClick={onBack}
            className="mb-2 rounded-sm p-2 text-left text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
          >
            ← Back to DevBench
          </button>
          <Tabs.List className="flex flex-col gap-0.5" aria-label="Settings sections">
            {PANES.map((p) => (
              <Tabs.Tab
                key={p.id}
                value={p.id}
                // Base UI 1.0.0-rc.0 renamed `[data-selected]` to `[data-active]`
                // on `<Tabs.Tab>` — see ToolTabs.tsx's identical fix (Task 4/6).
                // Without this, the selected-pane highlight is dead CSS.
                data-selected={p.id === pane ? "" : undefined}
                className="rounded-sm p-2 text-left text-sm text-text-muted transition-colors duration-150 hover:bg-surface-2 data-[selected]:bg-surface-2 data-[selected]:text-text"
              >
                {p.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </aside>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Tabs.Panel value="general" className="p-6">
            <GeneralPane />
          </Tabs.Panel>
          <Tabs.Panel value="provider" className="p-6">
            <ProviderPane />
          </Tabs.Panel>
          <Tabs.Panel value="mcp" className="p-6">
            <McpPane />
          </Tabs.Panel>
          <Tabs.Panel value="archive" className="p-6">
            <ArchivePane />
          </Tabs.Panel>
        </div>
      </Tabs.Root>
    </div>
  );
}
```

Tests stay red until Tasks 9, 10, 12, and 13 create the four panes.

- [ ] **Step 4: Commit**

```bash
git add apps/devbench/src
git commit -m "feat(devbench): add the Settings screen with vertical section nav"
```

---

### Task 9: Settings > General, and making the two hardcoded constants live

**Files:**
- Create: `apps/devbench/src/components/settings/GeneralPane.tsx`
- Create: `apps/devbench/src/components/settings/GeneralPane.test.tsx`
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Changes: `run_correlated_request_impl_with_registry` gains a `window_ms: i64` parameter (previously it read `DEFAULT_CORRELATION_WINDOW_MS` internally). The Tauri command reads the stored setting and passes it; every test passes `DEFAULT_CORRELATION_WINDOW_MS` explicitly, so the constant stays the documented default rather than becoming dead code.
- Produces: `<GeneralPane />`.

This is where Plan 2's Decision 4 and Plan 3's Decision 3 get cashed in. One of the two goes fully live; the other is honest about its limit — see the SMTP note below and Decision 5 above.

- [ ] **Step 1: Thread the window through the correlation command**

Modify `apps/devbench/src-tauri/src/commands/correlation.rs`:
```rust
pub async fn run_correlated_request_impl_with_registry(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
    logs: &LogState,
    emails: &EmailState,
    registry: &CorrelationRegistry,
    now_ms: i64,
    /// How long after the response to keep collecting. Comes from Settings >
    /// General; `DEFAULT_CORRELATION_WINDOW_MS` is the fallback when no row
    /// has been stored.
    window_ms: i64,
) -> Result<CorrelationResult, String> {
    let from_log_id = logs.next_line_id().saturating_sub(1);
    let from_email_id = emails.store().lock().map(|s| s.next_id().saturating_sub(1)).unwrap_or(0);

    let mut result = run_correlated_request_impl(request, connection, watched_tables, logs).await?;
    result.correlation_id = registry.open(from_log_id, from_email_id, now_ms + window_ms);
    Ok(result)
}
```

and the command:
```rust
#[tauri::command]
pub async fn run_correlated_request(
    db: State<'_, LocalDb>,
    logs: State<'_, Arc<LogState>>,
    emails: State<'_, Arc<EmailState>>,
    registry: State<'_, Arc<CorrelationRegistry>>,
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
) -> Result<CorrelationResult, String> {
    let method = request.method.clone();
    let url = request.url.clone();
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
    save_correlation_history(&db.pool, &method, &url, &result.response).await;
    Ok(result)
}
```

Every existing call site in the Plan 2 and Plan 3 test modules, plus `tests/smoke_test.rs`, gains a final `DEFAULT_CORRELATION_WINDOW_MS` argument.

Add one test proving the setting is honoured, in `correlation.rs`'s test module:
```rust
    #[tokio::test]
    async fn the_window_length_comes_from_the_caller_not_a_hardcoded_constant() {
        let conn = test_connection();
        let logs = LogState::new();
        let emails = listening_email_state();
        let registry = CorrelationRegistry::new();

        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/ping").with_status(200).with_body("pong").create_async().await;

        let result = run_correlated_request_impl_with_registry(
            FireRequestInput { method: "GET".into(), url: format!("{}/ping", server.url()), body: None },
            conn,
            vec![],
            &logs,
            &emails,
            &registry,
            10_000,
            30_000, // a 30s window, not the 5s default
        )
        .await
        .unwrap();
        mock.assert_async().await;

        // Collecting at default-window + 1 must still block, because this
        // window runs to 40_000. Asking at 40_001 returns immediately.
        let window = collect_correlation_window_impl(&registry, &logs, &emails, result.correlation_id, 40_001)
            .await
            .unwrap();
        assert_eq!(window.emails, Some(vec![]));
    }
```

- [ ] **Step 2: Read the stored SMTP port at startup**

Modify `apps/devbench/src-tauri/src/main.rs` — inside the `block_on` that connects `LocalDb`, read the port before binding:
```rust
            let (db, smtp_port) = tauri::async_runtime::block_on(async move {
                let db = LocalDb::connect(data_dir)
                    .await
                    .expect("failed to initialize local database");
                let port = devbench::commands::settings::get_settings_impl(&db.pool)
                    .await
                    .map(|s| s.smtp_port)
                    .unwrap_or(DEFAULT_SMTP_PORT);
                (db, port)
            });
            handle.manage(db);
```
and use `smtp_port` in place of `DEFAULT_SMTP_PORT` in the `smtp_catcher::bind(...)` call and in both `SmtpStatus` constructions.

**The limit, stated plainly:** the listener binds once, at startup. Changing the port in Settings takes effect on the next launch. The pane says so (Step 4). Hot-rebinding a running SMTP server — draining in-flight sessions, re-spawning the thread, reporting a mid-session bind failure — is a real feature and is not what the spec asks for; the spec asks for a way to change the port when 1025 is taken, which this delivers.

- [ ] **Step 3: Write the failing pane test**

`apps/devbench/src/components/settings/GeneralPane.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GeneralPane } from "./GeneralPane";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";

const settings = {
  theme: "dark",
  correlation_window_ms: 5000,
  smtp_port: 1025,
  provider: "anthropic",
  model: "claude-opus-5",
};

describe("GeneralPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(settings);
    vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);
  });

  it("shows the stored values", async () => {
    render(<GeneralPane />);
    await waitFor(() => expect(screen.getByLabelText(/correlation window/i)).toHaveValue(5));
    expect(screen.getByLabelText(/smtp port/i)).toHaveValue(1025);
  });

  // A radiogroup, not a multi-select toggle group: exactly one theme applies.
  it("offers theme as a single-select radiogroup and persists the choice", async () => {
    render(<GeneralPane />);
    await waitFor(() => screen.getByRole("radiogroup", { name: /theme/i }));
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    await waitFor(() => expect(tauriLib.invokeSetSetting).toHaveBeenCalledWith("theme", "light"));
    expect(useAppStore.getState().theme).toBe("light");
    useAppStore.getState().setTheme("dark");
  });

  it("persists the correlation window in milliseconds while showing seconds", async () => {
    render(<GeneralPane />);
    await waitFor(() => screen.getByLabelText(/correlation window/i));
    fireEvent.change(screen.getByLabelText(/correlation window/i), { target: { value: "12" } });
    fireEvent.blur(screen.getByLabelText(/correlation window/i));
    await waitFor(() =>
      expect(tauriLib.invokeSetSetting).toHaveBeenCalledWith("correlation_window_ms", "12000"),
    );
  });

  it("rejects an out-of-range correlation window instead of storing it", async () => {
    render(<GeneralPane />);
    await waitFor(() => screen.getByLabelText(/correlation window/i));
    fireEvent.change(screen.getByLabelText(/correlation window/i), { target: { value: "999" } });
    fireEvent.blur(screen.getByLabelText(/correlation window/i));
    await waitFor(() => expect(screen.getByText(/between 1 and 60 seconds/i)).toBeInTheDocument());
    expect(tauriLib.invokeSetSetting).not.toHaveBeenCalledWith("correlation_window_ms", "999000");
  });

  // The catcher binds once at startup; saying otherwise would be a lie the
  // user only discovers when no mail arrives.
  it("says an SMTP port change takes effect on restart", async () => {
    render(<GeneralPane />);
    await waitFor(() => expect(screen.getByText(/takes effect the next time devbench starts/i)).toBeInTheDocument());
  });
});
```

Run: `bun run test -- GeneralPane.test.tsx` → FAIL.

- [ ] **Step 4: Implement `GeneralPane`**

`apps/devbench/src/components/settings/GeneralPane.tsx`:
```tsx
import { useEffect, useState } from "react";
import { useAppStore, type ThemePref } from "../../store/useAppStore";
import { invokeGetSettings, invokeSetSetting } from "../../lib/tauri";

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

const MIN_WINDOW_S = 1;
const MAX_WINDOW_S = 60;

export function GeneralPane() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const [windowSeconds, setWindowSeconds] = useState(5);
  const [smtpPort, setSmtpPort] = useState(1025);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);

  useEffect(() => {
    invokeGetSettings()
      .then((s) => {
        setWindowSeconds(Math.round(s.correlation_window_ms / 1000));
        setSmtpPort(s.smtp_port);
        setTheme(s.theme as ThemePref);
      })
      .catch(() => {
        /* defaults already in state */
      });
  }, [setTheme]);

  async function saveTheme(next: ThemePref) {
    setTheme(next);
    await invokeSetSetting("theme", next).catch(() => {});
  }

  async function saveWindow() {
    if (!Number.isFinite(windowSeconds) || windowSeconds < MIN_WINDOW_S || windowSeconds > MAX_WINDOW_S) {
      setWindowError(`Correlation window must be between ${MIN_WINDOW_S} and ${MAX_WINDOW_S} seconds.`);
      return;
    }
    setWindowError(null);
    await invokeSetSetting("correlation_window_ms", String(windowSeconds * 1000)).catch(() => {});
  }

  async function savePort() {
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      setPortError("SMTP port must be between 1 and 65535.");
      return;
    }
    setPortError(null);
    await invokeSetSetting("smtp_port", String(smtpPort)).catch(() => {});
  }

  return (
    <div className="max-w-160">
      <h2 className="text-lg font-bold text-text">General</h2>
      <p className="mt-1 text-sm text-text-muted">App-wide behavior.</p>

      <section className="mt-6 rounded-lg border border-border p-4">
        {/* A radiogroup: exactly one theme applies at a time. Base UI's
            ToggleGroup is a MULTI-select primitive and would be the wrong
            semantics here (see this plan's Decision 1). */}
        <div role="radiogroup" aria-label="Theme">
          <div className="text-sm font-semibold text-text">Theme</div>
          <div className="mt-2 inline-flex rounded-sm border border-border p-0.5">
            {THEMES.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={theme === t.id}
                onClick={() => void saveTheme(t.id)}
                className={`rounded-sm px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                  theme === t.id ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <label htmlFor="corr-window" className="text-sm font-semibold text-text">
          Correlation window
        </label>
        <div className="mt-2 flex items-center gap-2">
          <input
            id="corr-window"
            type="number"
            min={MIN_WINDOW_S}
            max={MAX_WINDOW_S}
            value={windowSeconds}
            onChange={(e) => setWindowSeconds(Number(e.target.value))}
            onBlur={() => void saveWindow()}
            className="w-24 rounded-sm border border-border bg-bg px-2.5 py-2 text-sm tabular-nums text-text"
          />
          <span className="text-xs text-text-muted">seconds after the response</span>
        </div>
        <div className="mt-1 text-[11px] text-text-faint">
          How long DevBench keeps collecting log lines and emails for the “what happened” rollup after a
          request completes.
        </div>
        {windowError ? <div className="mt-1 text-xs text-danger">{windowError}</div> : null}
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <label htmlFor="smtp-port" className="text-sm font-semibold text-text">
          SMTP port
        </label>
        <div className="mt-2 flex items-center gap-2">
          <input
            id="smtp-port"
            type="number"
            min={1}
            max={65535}
            value={smtpPort}
            onChange={(e) => setSmtpPort(Number(e.target.value))}
            onBlur={() => void savePort()}
            className="w-24 rounded-sm border border-border bg-bg px-2.5 py-2 text-sm tabular-nums text-text"
          />
          <span className="text-xs text-text-muted">localhost only</span>
        </div>
        <div className="mt-1 text-[11px] text-text-faint">
          Point your backend’s SMTP config at this port to catch outgoing mail — the same setup as Mailhog
          or Mailpit. The catcher binds at launch, so a change here takes effect the next time DevBench
          starts.
        </div>
        {portError ? <div className="mt-1 text-xs text-danger">{portError}</div> : null}
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Run and commit**

Run: `cd apps/devbench/src-tauri && cargo test` then `cd apps/devbench && bun run test -- GeneralPane.test.tsx`
Expected: PASS

```bash
git add apps/devbench/src apps/devbench/src-tauri
git commit -m "feat(devbench): add Settings > General and make the window/port settings live"
```

---

### Task 10: `SecretStore` and Settings > Provider

**Files:**
- Create: `apps/devbench/src-tauri/src/secrets.rs`
- Create: `apps/devbench/src-tauri/src/commands/provider.rs`
- Modify: `apps/devbench/src-tauri/Cargo.toml`, `lib.rs`, `main.rs`, `commands/mod.rs`
- Create: `apps/devbench/src/components/settings/ProviderPane.tsx`
- Create: `apps/devbench/src/components/settings/ProviderPane.test.tsx`
- Modify: `apps/devbench/src/lib/tauri.ts`

**Interfaces:**
- Produces:
  - `pub trait SecretStore: Send + Sync { fn set(&self, account: &str, secret: &str) -> Result<(), String>; fn get(&self, account: &str) -> Result<Option<String>, String>; fn clear(&self, account: &str) -> Result<(), String>; }`
  - `pub struct KeyringSecretStore` and `pub struct InMemorySecretStore`.
  - `pub struct ProviderStatus { provider: String, model: String, has_key: bool }` and commands `get_provider_status()`, `set_provider_api_key(key: String)`, `clear_provider_api_key()`.
  Task 14's chat command reads the key through the same trait.

**The key is never returned to the frontend.** `get_provider_status` reports `has_key: bool` only. A key that round-trips through the webview is readable by any HTML the app renders.

- [ ] **Step 1: Add the crate and write `secrets.rs`**

`apps/devbench/src-tauri/Cargo.toml`, under `[dependencies]`: `keyring = "4"`

`apps/devbench/src-tauri/src/secrets.rs`:
```rust
use std::collections::HashMap;
use std::sync::Mutex;

/// Keychain service name. Stable across releases — changing it orphans every
/// stored key.
pub const SERVICE: &str = "com.benchapps.devbench";

/// OS-native secret storage, behind a trait for one concrete reason: a
/// keychain is an ambient OS resource, and a headless CI box has no Secret
/// Service provider at all. Tests use `InMemorySecretStore` so they exercise
/// the calling code without depending on the machine they run on.
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn clear(&self, account: &str) -> Result<(), String>;
}

pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("cannot open the OS keychain: {e}"))?;
        entry.set_password(secret).map_err(|e| format!("cannot store the key: {e}"))
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("cannot open the OS keychain: {e}"))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("cannot read the key: {e}")),
        }
    }

    fn clear(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("cannot open the OS keychain: {e}"))?;
        match entry.delete_credential() {
            // Deleting something that is already gone is the desired end state.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("cannot delete the key: {e}")),
        }
    }
}

#[derive(Default)]
pub struct InMemorySecretStore {
    entries: Mutex<HashMap<String, String>>,
}

impl SecretStore for InMemorySecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .get(account)
            .cloned())
    }

    fn clear(&self, account: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_store_round_trips_and_clears() {
        let store = InMemorySecretStore::default();
        assert_eq!(store.get("anthropic").unwrap(), None);
        store.set("anthropic", "sk-ant-test").unwrap();
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("sk-ant-test"));
        store.clear("anthropic").unwrap();
        assert_eq!(store.get("anthropic").unwrap(), None);
    }

    #[test]
    fn clearing_an_absent_secret_is_not_an_error() {
        let store = InMemorySecretStore::default();
        assert!(store.clear("never-set").is_ok());
    }

    /// Exercises the REAL keychain. Ignored by default: a headless CI box has
    /// no Secret Service provider, so this would fail for reasons unrelated to
    /// the code. Run manually with:
    ///     cargo test -- --ignored keyring_store_round_trips
    #[test]
    #[ignore]
    fn keyring_store_round_trips_against_the_real_os_keychain() {
        let store = KeyringSecretStore;
        let account = "devbench-test-account";
        store.set(account, "sk-ant-manual-test").unwrap();
        assert_eq!(store.get(account).unwrap().as_deref(), Some("sk-ant-manual-test"));
        store.clear(account).unwrap();
        assert_eq!(store.get(account).unwrap(), None);
    }
}
```

Add `pub mod secrets;` to `lib.rs`.

- [ ] **Step 2: Write `commands/provider.rs`**

```rust
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;

use crate::commands::settings::get_settings_impl;
use crate::local_db::LocalDb;
use crate::secrets::SecretStore;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProviderStatus {
    pub provider: String,
    pub model: String,
    /// Whether a key is stored. The key ITSELF is never returned: anything the
    /// frontend can read, any HTML the app renders can also read.
    pub has_key: bool,
}

pub async fn get_provider_status_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<ProviderStatus, String> {
    let settings = get_settings_impl(pool).await?;
    let has_key = secrets.get(&settings.provider)?.is_some();
    Ok(ProviderStatus { provider: settings.provider, model: settings.model, has_key })
}

pub async fn set_provider_api_key_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    key: &str,
) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("an API key cannot be blank — use Remove key to clear it".to_string());
    }
    let settings = get_settings_impl(pool).await?;
    secrets.set(&settings.provider, key)
}

pub async fn clear_provider_api_key_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
) -> Result<(), String> {
    let settings = get_settings_impl(pool).await?;
    secrets.clear(&settings.provider)
}

#[tauri::command]
pub async fn get_provider_status(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
) -> Result<ProviderStatus, String> {
    get_provider_status_impl(&db.pool, secrets.as_ref()).await
}

#[tauri::command]
pub async fn set_provider_api_key(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    key: String,
) -> Result<(), String> {
    set_provider_api_key_impl(&db.pool, secrets.as_ref(), &key).await
}

#[tauri::command]
pub async fn clear_provider_api_key(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
) -> Result<(), String> {
    clear_provider_api_key_impl(&db.pool, secrets.as_ref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::settings::set_setting_impl;
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn status_reports_no_key_before_one_is_stored() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let status = get_provider_status_impl(&db.pool, &secrets).await.unwrap();
        assert!(!status.has_key);
        assert_eq!(status.provider, "anthropic");
        assert_eq!(status.model, "claude-opus-5");
    }

    #[tokio::test]
    async fn storing_a_key_flips_has_key_without_ever_exposing_the_key() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "  sk-ant-secret  ").await.unwrap();

        let status = get_provider_status_impl(&db.pool, &secrets).await.unwrap();
        assert!(status.has_key);
        // The serialized status must not carry the secret anywhere.
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("sk-ant-secret"));
        // …and the stored value is trimmed, so a pasted trailing space does
        // not produce a silent 401 later.
        assert_eq!(secrets.get("anthropic").unwrap().as_deref(), Some("sk-ant-secret"));
    }

    #[tokio::test]
    async fn a_blank_key_is_rejected_rather_than_silently_stored() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        assert!(set_provider_api_key_impl(&db.pool, &secrets, "   ").await.is_err());
    }

    #[tokio::test]
    async fn clearing_removes_the_key() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-secret").await.unwrap();
        clear_provider_api_key_impl(&db.pool, &secrets).await.unwrap();
        assert!(!get_provider_status_impl(&db.pool, &secrets).await.unwrap().has_key);
    }

    #[tokio::test]
    async fn keys_are_stored_per_provider() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant").await.unwrap();
        set_setting_impl(&db.pool, "provider", "openai").await.unwrap();
        assert!(!get_provider_status_impl(&db.pool, &secrets).await.unwrap().has_key);
    }
}
```

Register `pub mod provider;` and the three commands. In `main.rs`, manage the store:
```rust
            app.manage(Arc::new(devbench::secrets::KeyringSecretStore) as Arc<dyn devbench::secrets::SecretStore>);
```

- [ ] **Step 3: Frontend wrappers and pane**

Append to `lib/tauri.ts`:
```ts
export interface ProviderStatus {
  provider: string;
  model: string;
  /** The key itself is never sent to the frontend — only whether one exists. */
  has_key: boolean;
}

export function invokeGetProviderStatus(): Promise<ProviderStatus> {
  return invoke("get_provider_status");
}
export function invokeSetProviderApiKey(key: string): Promise<void> {
  return invoke("set_provider_api_key", { key });
}
export function invokeClearProviderApiKey(): Promise<void> {
  return invoke("clear_provider_api_key");
}
```

`apps/devbench/src/components/settings/ProviderPane.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ProviderPane } from "./ProviderPane";
import * as tauriLib from "../../lib/tauri";

describe("ProviderPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);
    vi.spyOn(tauriLib, "invokeSetProviderApiKey").mockResolvedValue(undefined);
    vi.spyOn(tauriLib, "invokeClearProviderApiKey").mockResolvedValue(undefined);
  });

  it("says no key is stored and explains BYOK", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: false,
    });
    render(<ProviderPane />);
    await waitFor(() => expect(screen.getByText(/no key stored/i)).toBeInTheDocument());
    expect(screen.getByText(/never through a devbench server/i)).toBeInTheDocument();
  });

  it("stores a key and never renders it back", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus")
      .mockResolvedValueOnce({ provider: "anthropic", model: "claude-opus-5", has_key: false })
      .mockResolvedValue({ provider: "anthropic", model: "claude-opus-5", has_key: true });

    render(<ProviderPane />);
    await waitFor(() => screen.getByLabelText(/api key/i));
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(tauriLib.invokeSetProviderApiKey).toHaveBeenCalledWith("sk-ant-secret"));
    await waitFor(() => expect(screen.getByText(/key stored in your os keychain/i)).toBeInTheDocument());
    // The input is cleared and the key is never echoed anywhere in the DOM.
    expect(document.body.textContent).not.toContain("sk-ant-secret");
  });

  it("removes a stored key", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    render(<ProviderPane />);
    await waitFor(() => screen.getByRole("button", { name: "Remove key" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(tauriLib.invokeClearProviderApiKey).toHaveBeenCalled());
  });

  it("persists the selected model", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    render(<ProviderPane />);
    await waitFor(() => screen.getByLabelText(/model/i));
    fireEvent.change(screen.getByLabelText(/model/i), { target: { value: "claude-haiku-4-5" } });
    await waitFor(() => expect(tauriLib.invokeSetSetting).toHaveBeenCalledWith("model", "claude-haiku-4-5"));
  });
});
```

`apps/devbench/src/components/settings/ProviderPane.tsx`:
```tsx
import { useCallback, useEffect, useState } from "react";
import {
  invokeClearProviderApiKey,
  invokeGetProviderStatus,
  invokeSetProviderApiKey,
  invokeSetSetting,
  type ProviderStatus,
} from "../../lib/tauri";

const MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5 — most capable" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest" },
];

export function ProviderPane() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invokeGetProviderStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveKey() {
    setError(null);
    try {
      await invokeSetProviderApiKey(draftKey);
      // Drop the plaintext from React state the moment it is stored.
      setDraftKey("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeKey() {
    setError(null);
    try {
      await invokeClearProviderApiKey();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveModel(model: string) {
    setStatus((prev) => (prev ? { ...prev, model } : prev));
    await invokeSetSetting("model", model).catch(() => {});
  }

  return (
    <div className="max-w-160">
      <h2 className="text-lg font-bold text-text">Provider</h2>
      <p className="mt-1 text-sm text-text-muted">
        Bring your own key — DevBench calls your provider directly, never through a DevBench server.
      </p>

      <section className="mt-6 rounded-lg border border-border p-4">
        <label htmlFor="api-key" className="text-sm font-semibold text-text">
          API key
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder={status?.has_key ? "•••••••••••• (stored)" : "sk-ant-…"}
            className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-sm text-text"
          />
          <button
            onClick={() => void saveKey()}
            className="rounded-sm bg-accent px-3 py-2 text-sm font-bold text-accent-on"
          >
            Save key
          </button>
          {status?.has_key ? (
            <button
              onClick={() => void removeKey()}
              className="rounded-sm px-3 py-2 text-sm text-text-muted hover:bg-surface-2"
            >
              Remove key
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 text-[11px] text-text-faint">
          {status?.has_key
            ? "Key stored in your OS keychain. DevBench reads it only when you send a chat message."
            : "No key stored. The chat dock stays disabled until you add one."}
        </div>
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <label htmlFor="model" className="text-sm font-semibold text-text">
          Model
        </label>
        <select
          id="model"
          value={status?.model ?? "claude-opus-5"}
          onChange={(e) => void saveModel(e.target.value)}
          className="mt-2 w-full max-w-80 rounded-sm border border-border bg-surface-2 px-2.5 py-2 text-sm text-text"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run and commit**

Run: `cd apps/devbench/src-tauri && cargo test --lib secrets:: provider::` then `cd apps/devbench && bun run test -- ProviderPane.test.tsx`
Expected: PASS. The `#[ignore]`d keychain test does not run; verify it manually once with `cargo test -- --ignored keyring_store_round_trips`.

```bash
git add apps/devbench/src-tauri apps/devbench/src
git commit -m "feat(devbench): store the BYOK key in the OS keychain behind a SecretStore trait"
```

---

### Task 11: The MCP client

**Files:**
- Create: `apps/devbench/src-tauri/src/mcp_client.rs`
- Modify: `apps/devbench/src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` module in `mcp_client.rs`

**Interfaces:**
- Produces:
  - `pub struct McpTool { name: String, description: Option<String>, input_schema: serde_json::Value }`
  - `pub struct McpToolResult { text: String, is_error: bool }`
  - `pub struct McpSession<R, W>` generic over `R: AsyncBufRead + Unpin + Send`, `W: AsyncWrite + Unpin + Send`, with `new(reader, writer)`, `initialize() -> Result<String, String>` (returns the server name), `list_tools() -> Result<Vec<McpTool>, String>`, `call_tool(name, args) -> Result<McpToolResult, String>`.
  - `pub async fn connect_stdio(command: &str, args: &[String]) -> Result<(Child, McpSession<BufReader<ChildStdout>, ChildStdin>), String>` — returns the tuple, not a bare `McpSession`: the caller needs the `Child` handle to control the server's lifetime (dropping it kills the process via `kill_on_drop(true)`). An earlier draft of this brief stated the bare-`McpSession` return in prose while the Step 1 code below always returned the tuple; the tuple is correct and is what Task 11's implementation used.
  Task 12 uses `connect_stdio` + `initialize` + `list_tools` for the status list; Task 14 uses `call_tool`.

Being generic over the streams (Decision 2) is what makes this testable: the tests below drive a real JSON-RPC conversation over `tokio::io::duplex` against a hand-written fake server, with no child process, no fixture binary, and no timing flakiness.

- [ ] **Step 1: Write the client and its tests**

`apps/devbench/src-tauri/src/mcp_client.rs`:
```rust
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// MCP revision this client speaks. Servers negotiate down; a server that
/// cannot serve it says so in `initialize`'s reply, which we surface verbatim.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Ceiling on one JSON-RPC frame. An MCP server is a user-configured child
/// process, but a runaway one must not be able to exhaust memory — the same
/// bounded-read discipline `fire_request` and the SMTP catcher follow.
const MAX_FRAME_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct McpToolResult {
    pub text: String,
    /// True when the server reported the call itself failed. Surfaced to the
    /// model as an error tool_result rather than being swallowed — a tool that
    /// silently "succeeds" with no output is worse than one that says it broke.
    pub is_error: bool,
}

/// A JSON-RPC 2.0 conversation with an MCP server over newline-delimited
/// frames. Generic over the streams so tests can run a full protocol exchange
/// over `tokio::io::duplex` with no child process.
pub struct McpSession<R, W> {
    reader: R,
    writer: W,
    next_id: u64,
}

impl<R, W> McpSession<R, W>
where
    R: AsyncBufRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send,
{
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader, writer, next_id: 1 }
    }

    async fn send(&mut self, frame: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(frame).map_err(|e| format!("cannot encode request: {e}"))?;
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("cannot write to the MCP server: {e}"))?;
        self.writer.flush().await.map_err(|e| format!("cannot flush to the MCP server: {e}"))
    }

    /// Reads frames until one carries the id we are waiting for, so a server
    /// that interleaves notifications or log messages does not desynchronize us.
    async fn read_result(&mut self, want_id: u64) -> Result<Value, String> {
        loop {
            let mut line = String::new();
            let read = (&mut self.reader)
                .take(MAX_FRAME_BYTES)
                .read_line(&mut line)
                .await
                .map_err(|e| format!("cannot read from the MCP server: {e}"))?;
            if read == 0 {
                return Err("the MCP server closed the connection".to_string());
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let frame: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                // A server that writes non-JSON to stdout (a stray log line) is
                // common enough that skipping it beats failing the session.
                Err(_) => continue,
            };
            if frame.get("id").and_then(Value::as_u64) != Some(want_id) {
                continue;
            }
            if let Some(error) = frame.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown MCP error");
                return Err(format!("MCP server error: {message}"));
            }
            return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await?;
        self.read_result(id).await
    }

    /// Handshake. Returns the server's advertised name for the status list.
    pub async fn initialize(&mut self) -> Result<String, String> {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "devbench", "version": "0.1.0"},
                }),
            )
            .await?;

        // The spec requires this notification after a successful initialize.
        // It carries no id and gets no reply.
        self.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await?;

        Ok(result
            .get("serverInfo")
            .and_then(|i| i.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string())
    }

    pub async fn list_tools(&mut self) -> Result<Vec<McpTool>, String> {
        let result = self.request("tools/list", json!({})).await?;
        let tools = result.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(tools
            .into_iter()
            .filter_map(|t| {
                Some(McpTool {
                    name: t.get("name")?.as_str()?.to_string(),
                    description: t.get("description").and_then(Value::as_str).map(str::to_string),
                    input_schema: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                })
            })
            .collect())
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<McpToolResult, String> {
        let result = self.request("tools/call", json!({"name": name, "arguments": arguments})).await?;
        let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
        // MCP returns a content array; concatenating the text parts is what the
        // model needs. Non-text parts are named rather than dropped silently.
        let text = result
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .map(|p| match p.get("type").and_then(Value::as_str) {
                        Some("text") => p.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                        Some(other) => format!("[{other} content omitted]"),
                        None => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        Ok(McpToolResult { text, is_error })
    }
}

/// Spawns an MCP server as a child process and speaks to it over stdio.
/// The `Child` is returned alongside the session so the caller controls its
/// lifetime — dropping it kills the server.
pub async fn connect_stdio(
    command: &str,
    args: &[String],
) -> Result<(Child, McpSession<BufReader<ChildStdout>, ChildStdin>), String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // Inherit stderr so a server's diagnostics reach the developer's
        // terminal instead of filling an unread pipe until it blocks.
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start MCP server `{command}`: {e}"))?;

    let stdin = child.stdin.take().ok_or("MCP server has no stdin")?;
    let stdout = child.stdout.take().ok_or("MCP server has no stdout")?;
    Ok((child, McpSession::new(BufReader::new(stdout), stdin)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt as _, AsyncWriteExt as _, BufReader as TokioBufReader};

    /// A fake MCP server: reads request frames and replies from a script.
    /// Running the real protocol over an in-memory duplex is what lets these
    /// tests be deterministic — no process, no sleeps, no ports.
    fn spawn_fake_server(
        mut server_reader: TokioBufReader<tokio::io::DuplexStream>,
        mut server_writer: tokio::io::DuplexStream,
        replies: Vec<Value>,
    ) {
        tokio::spawn(async move {
            let mut remaining = replies.into_iter();
            loop {
                let mut line = String::new();
                if server_reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                let frame: Value = match serde_json::from_str(line.trim()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // Notifications have no id and get no reply.
                let Some(id) = frame.get("id").and_then(Value::as_u64) else { continue };
                let Some(mut reply) = remaining.next() else { return };
                reply["id"] = json!(id);
                reply["jsonrpc"] = json!("2.0");
                let mut out = serde_json::to_string(&reply).unwrap();
                out.push('\n');
                if server_writer.write_all(out.as_bytes()).await.is_err() {
                    return;
                }
                let _ = server_writer.flush().await;
            }
        });
    }

    /// Builds a connected client/fake-server pair.
    ///
    /// Note the TWO `duplex` pairs rather than one: a single `DuplexStream`
    /// pair is bidirectional, so using one would have the client reading back
    /// its own writes. One pair carries client→server, the other server→client.
    fn connect_fake(
        replies: Vec<Value>,
    ) -> McpSession<TokioBufReader<tokio::io::DuplexStream>, tokio::io::DuplexStream> {
        let (to_server_client, to_server_server) = duplex(64 * 1024);
        let (to_client_server, to_client_client) = duplex(64 * 1024);
        spawn_fake_server(TokioBufReader::new(to_server_server), to_client_server, replies);
        McpSession::new(TokioBufReader::new(to_client_client), to_server_client)
    }

    #[tokio::test]
    async fn initialize_returns_the_server_name_and_sends_the_initialized_notification() {
        let mut session = connect_fake(vec![json!({
            "result": {"protocolVersion": PROTOCOL_VERSION, "serverInfo": {"name": "filesystem"}}
        })]);
        assert_eq!(session.initialize().await.unwrap(), "filesystem");
    }

    #[tokio::test]
    async fn list_tools_parses_the_tool_definitions() {
        let mut session = connect_fake(vec![json!({
            "result": {"tools": [
                {"name": "read_file", "description": "Read a file",
                 "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}},
                {"name": "write_file"}
            ]}
        })]);
        let tools = session.list_tools().await.unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "read_file");
        assert_eq!(tools[0].description.as_deref(), Some("Read a file"));
        // A tool with no schema still gets a valid empty object schema, because
        // the Messages API rejects a tool without one.
        assert_eq!(tools[1].input_schema, json!({"type": "object", "properties": {}}));
    }

    #[tokio::test]
    async fn call_tool_concatenates_text_content() {
        let mut session = connect_fake(vec![json!({
            "result": {"content": [{"type": "text", "text": "line one"}, {"type": "text", "text": "line two"}]}
        })]);
        let result = session.call_tool("read_file", json!({"path": "/tmp/x"})).await.unwrap();
        assert_eq!(result.text, "line one\nline two");
        assert!(!result.is_error);
    }

    #[tokio::test]
    async fn call_tool_surfaces_a_server_reported_failure_rather_than_hiding_it() {
        let mut session = connect_fake(vec![json!({
            "result": {"isError": true, "content": [{"type": "text", "text": "file not found"}]}
        })]);
        let result = session.call_tool("read_file", json!({"path": "/nope"})).await.unwrap();
        assert!(result.is_error);
        assert_eq!(result.text, "file not found");
    }

    #[tokio::test]
    async fn a_jsonrpc_error_frame_becomes_an_err() {
        let mut session = connect_fake(vec![json!({"error": {"code": -32601, "message": "Method not found"}})]);
        let err = session.list_tools().await.unwrap_err();
        assert!(err.contains("Method not found"));
    }

    #[tokio::test]
    async fn a_closed_connection_is_reported_not_hung() {
        let (to_server_client, to_server_server) = duplex(1024);
        let (to_client_server, to_client_client) = duplex(1024);
        drop(to_server_server);
        drop(to_client_server);
        let mut session = McpSession::new(TokioBufReader::new(to_client_client), to_server_client);
        assert!(session.list_tools().await.is_err());
    }
}
```

Add `pub mod mcp_client;` to `lib.rs`.

- [ ] **Step 2: Run and commit**

Run: `cd apps/devbench/src-tauri && cargo test --lib mcp_client::`
Expected: PASS (six tests)

```bash
git add apps/devbench/src-tauri/src/mcp_client.rs apps/devbench/src-tauri/src/lib.rs
git commit -m "feat(devbench): add a transport-generic MCP stdio client"
```

---

### Task 12: Settings > MCP

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/mcp.rs`
- Create: `apps/devbench/src/components/settings/McpPane.tsx`
- Create: `apps/devbench/src/components/settings/McpPane.test.tsx`
- Modify: `commands/mod.rs`, `main.rs`, `lib/tauri.ts`

**Interfaces:**
- Produces: `pub struct McpServerConfig { id, name, command, args }`, `pub struct McpServerStatus { config, state: String, error: Option<String>, tool_count: usize }`, and commands `list_mcp_servers()`, `add_mcp_server(name, command, args)`, `remove_mcp_server(id)`, `check_mcp_server(id)`. Task 14 reuses `list_mcp_servers_impl` and the connect-and-list-tools helper.

- [ ] **Step 1: Write `commands/mcp.rs`**

```rust
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::State;
use uuid::Uuid;

use crate::local_db::LocalDb;
use crate::mcp_client::{connect_stdio, McpTool};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct McpServerStatus {
    pub config: McpServerConfig,
    /// "connected" | "error" | "unchecked"
    pub state: String,
    pub error: Option<String>,
    pub tool_count: usize,
}

pub async fn list_mcp_servers_impl(pool: &SqlitePool) -> Result<Vec<McpServerConfig>, String> {
    let rows = sqlx::query("SELECT id, name, command, args FROM mcp_servers ORDER BY name")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("failed to list MCP servers: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| McpServerConfig {
            id: r.get("id"),
            name: r.get("name"),
            command: r.get("command"),
            // A corrupt args column degrades to "no args" rather than making
            // the whole list unreadable.
            args: serde_json::from_str(&r.get::<String, _>("args")).unwrap_or_default(),
        })
        .collect())
}

pub async fn add_mcp_server_impl(
    pool: &SqlitePool,
    name: &str,
    command: &str,
    args: &[String],
) -> Result<McpServerConfig, String> {
    let (name, command) = (name.trim(), command.trim());
    if name.is_empty() || command.is_empty() {
        return Err("an MCP server needs a name and a command".to_string());
    }
    let config = McpServerConfig {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        command: command.to_string(),
        args: args.to_vec(),
    };
    sqlx::query("INSERT INTO mcp_servers (id, name, command, args, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&config.id)
        .bind(&config.name)
        .bind(&config.command)
        .bind(serde_json::to_string(&config.args).unwrap_or_else(|_| "[]".to_string()))
        .bind(Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("an MCP server named `{name}` already exists")
            } else {
                format!("failed to add MCP server: {e}")
            }
        })?;
    Ok(config)
}

pub async fn remove_mcp_server_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM mcp_servers WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to remove MCP server: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("no MCP server with id {id}"));
    }
    Ok(())
}

/// Spawns the server, handshakes, lists its tools, then shuts it down.
/// Used both by the Settings status check and by the chat tool loop.
pub async fn probe_server(config: &McpServerConfig) -> Result<Vec<McpTool>, String> {
    let (mut child, mut session) = connect_stdio(&config.command, &config.args).await?;
    let result = async {
        session.initialize().await?;
        session.list_tools().await
    }
    .await;
    // kill_on_drop is set, but being explicit means a failed probe does not
    // leave a process alive until the Child value happens to be dropped.
    let _ = child.kill().await;
    result
}

#[tauri::command]
pub async fn list_mcp_servers(db: State<'_, LocalDb>) -> Result<Vec<McpServerConfig>, String> {
    list_mcp_servers_impl(&db.pool).await
}

#[tauri::command]
pub async fn add_mcp_server(
    db: State<'_, LocalDb>,
    name: String,
    command: String,
    args: Vec<String>,
) -> Result<McpServerConfig, String> {
    add_mcp_server_impl(&db.pool, &name, &command, &args).await
}

#[tauri::command]
pub async fn remove_mcp_server(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    remove_mcp_server_impl(&db.pool, &id).await
}

#[tauri::command]
pub async fn check_mcp_server(db: State<'_, LocalDb>, id: String) -> Result<McpServerStatus, String> {
    let config = list_mcp_servers_impl(&db.pool)
        .await?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("no MCP server with id {id}"))?;
    Ok(match probe_server(&config).await {
        Ok(tools) => McpServerStatus {
            config,
            state: "connected".to_string(),
            error: None,
            tool_count: tools.len(),
        },
        Err(e) => McpServerStatus { config, state: "error".to_string(), error: Some(e), tool_count: 0 },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn adds_and_lists_a_server_with_its_args() {
        let (_dir, db) = db().await;
        add_mcp_server_impl(&db.pool, "filesystem", "npx", &["@mcp/server-filesystem".into()])
            .await
            .unwrap();
        let listed = list_mcp_servers_impl(&db.pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].command, "npx");
        assert_eq!(listed[0].args, vec!["@mcp/server-filesystem".to_string()]);
    }

    #[tokio::test]
    async fn rejects_a_duplicate_name_with_a_readable_message() {
        let (_dir, db) = db().await;
        add_mcp_server_impl(&db.pool, "fs", "npx", &[]).await.unwrap();
        let err = add_mcp_server_impl(&db.pool, "fs", "other", &[]).await.unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[tokio::test]
    async fn rejects_a_blank_name_or_command() {
        let (_dir, db) = db().await;
        assert!(add_mcp_server_impl(&db.pool, "  ", "npx", &[]).await.is_err());
        assert!(add_mcp_server_impl(&db.pool, "fs", "  ", &[]).await.is_err());
    }

    #[tokio::test]
    async fn removing_reports_an_unknown_id() {
        let (_dir, db) = db().await;
        assert!(remove_mcp_server_impl(&db.pool, "nope").await.is_err());
    }

    // A command that does not exist must surface as an error status, not a
    // panic and not a server that silently reports zero tools.
    #[tokio::test]
    async fn probing_a_nonexistent_command_is_a_readable_error() {
        let config = McpServerConfig {
            id: "x".into(),
            name: "broken".into(),
            command: "definitely-not-a-real-binary-xyz".into(),
            args: vec![],
        };
        let err = probe_server(&config).await.unwrap_err();
        assert!(err.contains("cannot start MCP server"));
    }
}
```

Register the module and four commands.

- [ ] **Step 2: Frontend wrappers and pane**

Append to `lib/tauri.ts`:
```ts
export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export interface McpServerStatus {
  config: McpServerConfig;
  state: string;
  error: string | null;
  tool_count: number;
}

export function invokeListMcpServers(): Promise<McpServerConfig[]> {
  return invoke("list_mcp_servers");
}
export function invokeAddMcpServer(name: string, command: string, args: string[]): Promise<McpServerConfig> {
  return invoke("add_mcp_server", { name, command, args });
}
export function invokeRemoveMcpServer(id: string): Promise<void> {
  return invoke("remove_mcp_server", { id });
}
export function invokeCheckMcpServer(id: string): Promise<McpServerStatus> {
  return invoke("check_mcp_server", { id });
}
```

`apps/devbench/src/components/settings/McpPane.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpPane } from "./McpPane";
import * as tauriLib from "../../lib/tauri";

const server = { id: "s1", name: "filesystem", command: "npx", args: ["@mcp/server-filesystem"] };

describe("McpPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeAddMcpServer").mockResolvedValue(server);
    vi.spyOn(tauriLib, "invokeRemoveMcpServer").mockResolvedValue(undefined);
  });

  it("shows an empty state explaining what MCP servers are for", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([]);
    render(<McpPane />);
    await waitFor(() => expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument());
  });

  it("lists configured servers with their command", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([server]);
    render(<McpPane />);
    await waitFor(() => expect(screen.getByText("filesystem")).toBeInTheDocument());
    expect(screen.getByText(/npx @mcp\/server-filesystem/)).toBeInTheDocument();
  });

  it("reports a connected server and its tool count", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([server]);
    vi.spyOn(tauriLib, "invokeCheckMcpServer").mockResolvedValue({
      config: server,
      state: "connected",
      error: null,
      tool_count: 4,
    });
    render(<McpPane />);
    await waitFor(() => screen.getByText("filesystem"));
    fireEvent.click(screen.getByRole("button", { name: "Check filesystem" }));
    await waitFor(() => expect(screen.getByText(/connected · 4 tools/i)).toBeInTheDocument());
  });

  it("shows why a server failed rather than just marking it red", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([server]);
    vi.spyOn(tauriLib, "invokeCheckMcpServer").mockResolvedValue({
      config: server,
      state: "error",
      error: "cannot start MCP server `npx`: No such file or directory",
      tool_count: 0,
    });
    render(<McpPane />);
    await waitFor(() => screen.getByText("filesystem"));
    fireEvent.click(screen.getByRole("button", { name: "Check filesystem" }));
    await waitFor(() => expect(screen.getByText(/No such file or directory/)).toBeInTheDocument());
  });

  it("adds a server, splitting the command line into command and args", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([]);
    render(<McpPane />);
    await waitFor(() => screen.getByPlaceholderText("filesystem"));
    fireEvent.change(screen.getByPlaceholderText("filesystem"), { target: { value: "fs" } });
    fireEvent.change(screen.getByPlaceholderText("npx @mcp/server-filesystem"), {
      target: { value: "npx @mcp/server-filesystem /tmp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add MCP server" }));
    await waitFor(() =>
      expect(tauriLib.invokeAddMcpServer).toHaveBeenCalledWith("fs", "npx", [
        "@mcp/server-filesystem",
        "/tmp",
      ]),
    );
  });
});
```

`apps/devbench/src/components/settings/McpPane.tsx`:
```tsx
import { useCallback, useEffect, useState } from "react";
import {
  invokeAddMcpServer,
  invokeCheckMcpServer,
  invokeListMcpServers,
  invokeRemoveMcpServer,
  type McpServerConfig,
  type McpServerStatus,
} from "../../lib/tauri";

export function McpPane() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setServers(await invokeListMcpServers());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add() {
    setError(null);
    // A single command-line field is what a developer already has in their
    // notes; splitting it here beats making them fill in a JSON array.
    const parts = commandLine.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      setError("Enter the command that starts the server.");
      return;
    }
    try {
      await invokeAddMcpServer(name, parts[0], parts.slice(1));
      setName("");
      setCommandLine("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function check(id: string) {
    try {
      const status = await invokeCheckMcpServer(id);
      setStatuses((prev) => ({ ...prev, [id]: status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(id: string) {
    await invokeRemoveMcpServer(id).catch(() => {});
    await refresh();
  }

  return (
    <div className="max-w-160">
      <h2 className="text-lg font-bold text-text">MCP Servers</h2>
      <p className="mt-1 text-sm text-text-muted">Tools the AI assistant can call during a chat.</p>

      <div className="mt-6 flex flex-col gap-2">
        {servers.length === 0 ? (
          <div className="rounded-lg border border-border p-4 text-sm text-text-faint">
            No MCP servers configured. Add one to let the assistant call external tools during a chat.
          </div>
        ) : (
          servers.map((s) => {
            const status = statuses[s.id];
            return (
              <div key={s.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text">{s.name}</div>
                    <div className="truncate font-mono text-xs text-text-muted">
                      {[s.command, ...s.args].join(" ")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {status ? (
                      <span
                        className={`rounded-sm px-2 py-0.5 text-[11px] font-semibold ${
                          status.state === "connected"
                            ? "bg-success-bg text-success"
                            : "bg-danger-bg text-danger"
                        }`}
                      >
                        {status.state === "connected"
                          ? `Connected · ${status.tool_count} tools`
                          : "Error"}
                      </span>
                    ) : (
                      <span className="text-[11px] text-text-faint">Unchecked</span>
                    )}
                    <button
                      aria-label={`Check ${s.name}`}
                      onClick={() => void check(s.id)}
                      className="rounded-sm px-2 py-1 text-xs text-text-muted hover:bg-surface-2"
                    >
                      Check
                    </button>
                    <button
                      aria-label={`Remove ${s.name}`}
                      onClick={() => void remove(s.id)}
                      className="rounded-sm px-2 py-1 text-xs text-text-faint hover:bg-surface-2 hover:text-text"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {status?.error ? (
                  <div className="mt-2 rounded-sm bg-danger-bg px-2 py-1 font-mono text-[11px] text-danger">
                    {status.error}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <section className="mt-4 rounded-lg border border-border p-4">
        <div className="text-sm font-semibold text-text">Add a server</div>
        <div className="mt-2 flex flex-col gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="filesystem"
            aria-label="Server name"
            className="rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text"
          />
          <input
            value={commandLine}
            onChange={(e) => setCommandLine(e.target.value)}
            placeholder="npx @mcp/server-filesystem"
            aria-label="Command"
            className="rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-sm text-text"
          />
          <button
            onClick={() => void add()}
            className="self-start rounded-sm bg-accent px-3 py-2 text-sm font-bold text-accent-on"
          >
            Add MCP server
          </button>
        </div>
        <div className="mt-2 text-[11px] text-text-faint">
          DevBench starts this command and speaks MCP over its stdin/stdout. Credentials come from the
          command’s own environment — DevBench never stores them.
        </div>
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Run and commit**

Run: `cd apps/devbench/src-tauri && cargo test --lib mcp::` then `cd apps/devbench && bun run test -- McpPane.test.tsx`
Expected: PASS

```bash
git add apps/devbench/src-tauri apps/devbench/src
git commit -m "feat(devbench): add Settings > MCP with server config and status checks"
```

---

### Task 13: Settings > Archive

**Files:**
- Create: `apps/devbench/src/components/settings/ArchivePane.tsx`
- Create: `apps/devbench/src/components/settings/ArchivePane.test.tsx`

**Interfaces:**
- Consumes: `invokeListArchivedSessions`, `invokeRestoreSession`, `invokeDeleteSession` (Task 5's wrappers over Task 2's commands). Produces `<ArchivePane />`.

- [ ] **Step 1: Write the failing test**

`apps/devbench/src/components/settings/ArchivePane.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ArchivePane } from "./ArchivePane";
import * as tauriLib from "../../lib/tauri";

const archived = [
  {
    id: "a",
    name: "Payment webhook investigation",
    kind: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    archived_at: "2026-07-25T00:00:00Z",
  },
];

describe("ArchivePane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeRestoreSession").mockResolvedValue(undefined);
    vi.spyOn(tauriLib, "invokeDeleteSession").mockResolvedValue(undefined);
  });

  it("lists archived sessions", async () => {
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue(archived);
    render(<ArchivePane />);
    await waitFor(() => expect(screen.getByText("Payment webhook investigation")).toBeInTheDocument());
  });

  it("restores a session", async () => {
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue(archived);
    render(<ArchivePane />);
    await waitFor(() => screen.getByRole("button", { name: "Restore Payment webhook investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Payment webhook investigation" }));
    await waitFor(() => expect(tauriLib.invokeRestoreSession).toHaveBeenCalledWith("a"));
  });

  // Permanent deletion is the one destructive action in the app; it asks first.
  it("requires confirmation before deleting permanently", async () => {
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue(archived);
    render(<ArchivePane />);
    await waitFor(() => screen.getByRole("button", { name: /delete forever/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete forever/i }));
    expect(tauriLib.invokeDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByText(/this cannot be undone/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(tauriLib.invokeDeleteSession).toHaveBeenCalledWith("a"));
  });

  it("shows an empty state", async () => {
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue([]);
    render(<ArchivePane />);
    await waitFor(() => expect(screen.getByText(/nothing archived/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Implement `ArchivePane`**

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  invokeDeleteSession,
  invokeListArchivedSessions,
  invokeRestoreSession,
  type Session,
} from "../../lib/tauri";

export function ArchivePane() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSessions(await invokeListArchivedSessions());
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function restore(id: string) {
    await invokeRestoreSession(id).catch(() => {});
    await refresh();
  }

  async function confirmDelete(id: string) {
    await invokeDeleteSession(id).catch(() => {});
    setConfirmingId(null);
    await refresh();
  }

  return (
    <div className="max-w-160">
      <h2 className="text-lg font-bold text-text">Archive</h2>
      <p className="mt-1 text-sm text-text-muted">
        Sessions removed from the sidebar, kept here until restored or deleted.
      </p>

      <div className="mt-6 flex flex-col gap-2">
        {sessions.length === 0 ? (
          <div className="rounded-lg border border-border p-4 text-sm text-text-faint">
            Nothing archived. Removing a session from the sidebar puts it here — it is never deleted
            outright.
          </div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-text">{s.name}</div>
                  <div className="text-[11px] text-text-faint">
                    Archived {s.archived_at ? new Date(s.archived_at).toLocaleDateString() : "—"}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    aria-label={`Restore ${s.name}`}
                    onClick={() => void restore(s.id)}
                    className="rounded-sm border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-2"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => setConfirmingId(s.id)}
                    className="rounded-sm px-2.5 py-1 text-xs text-text-faint hover:bg-surface-2 hover:text-danger"
                  >
                    Delete forever
                  </button>
                </div>
              </div>
              {confirmingId === s.id ? (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-sm bg-danger-bg px-2 py-1.5">
                  <span className="text-xs text-danger">
                    Delete “{s.name}” permanently? This cannot be undone.
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmingId(null)}
                      className="rounded-sm px-2 py-0.5 text-xs text-text-muted"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void confirmDelete(s.id)}
                      className="rounded-sm bg-danger px-2 py-0.5 text-xs font-bold text-accent-on"
                    >
                      Confirm delete
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run and commit**

Run: `bun run test -- ArchivePane.test.tsx SettingsScreen.test.tsx`
Expected: PASS — `SettingsScreen.test.tsx` goes green now that all four panes exist.

```bash
git add apps/devbench/src/components/settings
git commit -m "feat(devbench): add Settings > Archive with restore and confirmed delete"
```

---

### Task 14: The chat dock

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/chat.rs`
- Create: `apps/devbench/src/components/shell/ChatDock.tsx`
- Create: `apps/devbench/src/components/shell/ChatDock.test.tsx`
- Modify: `commands/mod.rs`, `main.rs`, `lib/tauri.ts`

**Interfaces:**
- Produces: `pub struct ChatMessage { role: String, content: String }`, `pub struct ChatReply { content: String, tool_calls: Vec<String> }`, and command `send_chat_message(messages: Vec<ChatMessage>) -> Result<ChatReply, String>`.

`send_chat_message_impl` takes a `base_url: &str` so the tests point it at a `mockito` server. Three API facts the code depends on (Decision 4): no `temperature`/`top_p`/`top_k` on `claude-opus-5`; `max_tokens` covers thinking plus text; `stop_reason: "refusal"` arrives as an HTTP 200 with empty `content`.

- [ ] **Step 1: Write `commands/chat.rs`**

```rust
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

use crate::commands::mcp::{list_mcp_servers_impl, probe_server};
use crate::commands::settings::get_settings_impl;
use crate::local_db::LocalDb;
use crate::mcp_client::connect_stdio;
use crate::secrets::SecretStore;

const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Covers thinking AND response text on models where thinking is on by
/// default (Claude Opus 5) — sizing it tightly truncates mid-answer.
const MAX_TOKENS: u32 = 16_000;
/// Bounds the tool loop so a model that keeps calling tools cannot spin.
const MAX_TOOL_ITERATIONS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChatReply {
    pub content: String,
    /// Names of MCP tools invoked while producing this reply, so the UI can
    /// show what the assistant actually did rather than only what it said.
    pub tool_calls: Vec<String>,
}

const SYSTEM_PROMPT: &str = "You are DevBench's assistant. DevBench is a local-first developer \
workbench that correlates an HTTP request with the database rows it changed, the log lines it \
produced, and the mail it sent. Answer concisely and concretely about what the user is debugging.";

pub async fn send_chat_message_impl(
    pool: &SqlitePool,
    secrets: &dyn SecretStore,
    base_url: &str,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    let settings = get_settings_impl(pool).await?;
    let api_key = secrets
        .get(&settings.provider)?
        .ok_or("No API key stored. Add one in Settings > Provider.")?;

    // Gather MCP tools. A broken server must not disable chat entirely — it
    // just contributes no tools, and the Settings > MCP status says why.
    let mut tool_defs: Vec<Value> = Vec::new();
    let mut tool_owner: std::collections::HashMap<String, _> = Default::default();
    for config in list_mcp_servers_impl(pool).await.unwrap_or_default() {
        if let Ok(tools) = probe_server(&config).await {
            for tool in tools {
                tool_defs.push(json!({
                    "name": tool.name,
                    "description": tool.description.unwrap_or_default(),
                    "input_schema": tool.input_schema,
                }));
                tool_owner.insert(tool.name, config.clone());
            }
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;

    let mut api_messages: Vec<Value> = messages
        .iter()
        .map(|m| json!({"role": m.role, "content": m.content}))
        .collect();
    let mut used_tools: Vec<String> = Vec::new();

    for _ in 0..MAX_TOOL_ITERATIONS {
        let mut body = json!({
            "model": settings.model,
            "max_tokens": MAX_TOKENS,
            // Effort is inside output_config, not top-level. `medium` keeps a
            // chat dock responsive; low/medium are strong on Claude Opus 5.
            "output_config": {"effort": "medium"},
            "system": SYSTEM_PROMPT,
            "messages": api_messages,
        });
        // NOTE: temperature / top_p / top_k are deliberately absent. They are
        // removed on Claude Opus 5 and sending any of them returns a 400.
        if !tool_defs.is_empty() {
            body["tools"] = json!(tool_defs);
        }

        let response = client
            .post(format!("{base_url}/v1/messages"))
            .header("x-api-key", &api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("chat request failed: {e}"))?;

        let status = response.status();
        let text = response.text().await.map_err(|e| format!("cannot read chat response: {e}"))?;
        if !status.is_success() {
            return Err(format!("provider returned {status}: {text}"));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|e| format!("cannot parse chat response: {e}"))?;

        // A refusal is an HTTP 200 with an empty content array. Checking
        // stop_reason BEFORE reading content is what keeps this from looking
        // like an empty successful reply.
        if parsed.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
            let category = parsed
                .get("stop_details")
                .and_then(|d| d.get("category"))
                .and_then(Value::as_str)
                .unwrap_or("unspecified");
            return Err(format!("The provider declined this request ({category})."));
        }

        let content = parsed.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
        let text_out: String = content
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");

        if parsed.get("stop_reason").and_then(Value::as_str) != Some("tool_use") {
            return Ok(ChatReply { content: text_out, tool_calls: used_tools });
        }

        // Echo the assistant turn back verbatim, then answer every tool_use
        // block in ONE user message — splitting them trains the model out of
        // parallel tool calls.
        api_messages.push(json!({"role": "assistant", "content": content}));
        let mut results: Vec<Value> = Vec::new();
        for block in content.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")) {
            let name = block.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            let id = block.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let input = block.get("input").cloned().unwrap_or_else(|| json!({}));

            let (text, is_error) = match tool_owner.get(&name) {
                Some(config) => match connect_stdio(&config.command, &config.args).await {
                    Ok((mut child, mut session)) => {
                        let outcome = async {
                            session.initialize().await?;
                            session.call_tool(&name, input).await
                        }
                        .await;
                        let _ = child.kill().await;
                        match outcome {
                            Ok(r) => (r.text, r.is_error),
                            Err(e) => (e, true),
                        }
                    }
                    Err(e) => (e, true),
                },
                None => (format!("no MCP server provides the tool `{name}`"), true),
            };
            used_tools.push(name);
            // A failed tool is returned as an error tool_result, never dropped:
            // omitting a result for a tool_use id makes the next request invalid.
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": text,
                "is_error": is_error,
            }));
        }
        api_messages.push(json!({"role": "user", "content": results}));
    }

    Err(format!(
        "the assistant kept requesting tools after {MAX_TOOL_ITERATIONS} rounds — stopping"
    ))
}

#[tauri::command]
pub async fn send_chat_message(
    db: State<'_, LocalDb>,
    secrets: State<'_, Arc<dyn SecretStore>>,
    messages: Vec<ChatMessage>,
) -> Result<ChatReply, String> {
    send_chat_message_impl(&db.pool, secrets.as_ref(), ANTHROPIC_BASE_URL, messages).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::provider::set_provider_api_key_impl;
    use crate::secrets::InMemorySecretStore;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    fn user(text: &str) -> Vec<ChatMessage> {
        vec![ChatMessage { role: "user".into(), content: text.into() }]
    }

    #[tokio::test]
    async fn refuses_to_send_without_a_stored_key() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        let err = send_chat_message_impl(&db.pool, &secrets, "http://unused", user("hi"))
            .await
            .unwrap_err();
        assert!(err.contains("Settings > Provider"));
    }

    #[tokio::test]
    async fn sends_the_message_and_returns_the_text_reply() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-test").await.unwrap();

        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-ant-test")
            .match_header("anthropic-version", ANTHROPIC_VERSION)
            .with_status(200)
            .with_body(r#"{"stop_reason":"end_turn","content":[{"type":"text","text":"Three rows changed."}]}"#)
            .create_async()
            .await;

        let reply = send_chat_message_impl(&db.pool, &secrets, &server.url(), user("what happened?"))
            .await
            .unwrap();
        mock.assert_async().await;
        assert_eq!(reply.content, "Three rows changed.");
        assert!(reply.tool_calls.is_empty());
    }

    // Sending any of these to Claude Opus 5 is a 400. This asserts the request
    // builder never includes them, rather than relying on nobody adding them.
    #[tokio::test]
    async fn never_sends_sampling_parameters() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-test").await.unwrap();

        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/messages")
            .match_body(mockito::Matcher::PartialJson(json!({"model": "claude-opus-5"})))
            .with_status(200)
            .with_body(r#"{"stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]}"#)
            .create_async()
            .await;

        send_chat_message_impl(&db.pool, &secrets, &server.url(), user("hi")).await.unwrap();
        mock.assert_async().await;

        let sent = &server.received_requests().await.unwrap()[0];
        let body: Value = serde_json::from_slice(sent.body.as_ref().unwrap()).unwrap();
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());
        assert_eq!(body["output_config"]["effort"], "medium");
    }

    // HTTP 200 + empty content. Reading content[0] blindly would look like an
    // empty successful reply.
    #[tokio::test]
    async fn a_refusal_becomes_a_readable_error_not_an_empty_reply() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-test").await.unwrap();

        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{"stop_reason":"refusal","stop_details":{"category":"cyber"},"content":[]}"#)
            .create_async()
            .await;

        let err = send_chat_message_impl(&db.pool, &secrets, &server.url(), user("hi"))
            .await
            .unwrap_err();
        assert!(err.contains("declined"));
        assert!(err.contains("cyber"));
    }

    #[tokio::test]
    async fn a_provider_error_surfaces_its_body() {
        let (_dir, db) = db().await;
        let secrets = InMemorySecretStore::default();
        set_provider_api_key_impl(&db.pool, &secrets, "sk-ant-test").await.unwrap();

        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/v1/messages")
            .with_status(401)
            .with_body(r#"{"error":{"message":"invalid x-api-key"}}"#)
            .create_async()
            .await;

        let err = send_chat_message_impl(&db.pool, &secrets, &server.url(), user("hi"))
            .await
            .unwrap_err();
        assert!(err.contains("401"));
        assert!(err.contains("invalid x-api-key"));
    }
}
```

Register `pub mod chat;` and the command.

- [ ] **Step 2: Frontend wrapper and dock**

Append to `lib/tauri.ts`:
```ts
export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatReply {
  content: string;
  tool_calls: string[];
}

export function invokeSendChatMessage(messages: ChatMessage[]): Promise<ChatReply> {
  return invoke("send_chat_message", { messages });
}
```

`apps/devbench/src/components/shell/ChatDock.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ChatDock } from "./ChatDock";
import * as tauriLib from "../../lib/tauri";

describe("ChatDock", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("prompts for a key when none is stored, instead of failing on send", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: false,
    });
    render(<ChatDock onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/add a provider key in settings/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/ask about this request/i)).toBeDisabled();
  });

  it("sends a message and renders the reply", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    vi.spyOn(tauriLib, "invokeSendChatMessage").mockResolvedValue({
      content: "Three rows changed in orders.",
      tool_calls: [],
    });

    render(<ChatDock onClose={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/ask about this request/i), {
      target: { value: "what happened?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByText("Three rows changed in orders.")).toBeInTheDocument());
    expect(screen.getByText("what happened?")).toBeInTheDocument();
  });

  it("names the MCP tools the assistant used", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    vi.spyOn(tauriLib, "invokeSendChatMessage").mockResolvedValue({
      content: "Done.",
      tool_calls: ["read_file"],
    });
    render(<ChatDock onClose={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/ask about this request/i), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByText(/used read_file/i)).toBeInTheDocument());
  });

  it("shows a send failure without losing the transcript", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    vi.spyOn(tauriLib, "invokeSendChatMessage").mockRejectedValue(new Error("provider returned 401"));
    render(<ChatDock onClose={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/ask about this request/i), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByText(/provider returned 401/)).toBeInTheDocument());
    expect(screen.getByText("hi")).toBeInTheDocument();
  });

  it("closes", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    const onClose = vi.fn();
    render(<ChatDock onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

`apps/devbench/src/components/shell/ChatDock.tsx`:
```tsx
import { useEffect, useState } from "react";
import {
  invokeGetProviderStatus,
  invokeSendChatMessage,
  type ChatMessage,
} from "../../lib/tauri";

interface Turn extends ChatMessage {
  toolCalls?: string[];
}

export function ChatDock({ onClose }: { onClose: () => void }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invokeGetProviderStatus()
      .then((s) => setHasKey(s.has_key))
      .catch(() => setHasKey(false));
  }, []);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    const next: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(next);
    setDraft("");
    setSending(true);
    setError(null);
    try {
      const reply = await invokeSendChatMessage(next.map((t) => ({ role: t.role, content: t.content })));
      setTurns([...next, { role: "assistant", content: reply.content, toolCalls: reply.tool_calls }]);
    } catch (err) {
      // The transcript is preserved: losing the user's question because the
      // provider 401'd would be worse than the 401.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    // Ghosty and a flex sibling of the content column — it RESIZES the
    // workspace rather than overlaying it (DESIGN.md).
    <aside aria-label="AI Assistant" className="flex w-80 min-w-80 flex-col border-l border-border">
      <div className="flex items-center justify-between border-b border-border p-2.5">
        <span className="text-xs font-bold text-text-muted">AI Assistant</span>
        <button
          aria-label="Close chat"
          onClick={onClose}
          className="rounded-sm px-1.5 text-text-faint hover:bg-surface-2 hover:text-text"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {turns.length === 0 ? (
          <div className="text-xs text-text-faint">
            Ask about this session, or anything DevBench observed.
          </div>
        ) : (
          turns.map((turn, i) => (
            <div
              key={i}
              className={`rounded-lg px-2.5 py-2 text-xs ${
                turn.role === "user" ? "bg-surface-2 text-text" : "text-text"
              }`}
            >
              <div className="whitespace-pre-wrap">{turn.content}</div>
              {turn.toolCalls && turn.toolCalls.length > 0 ? (
                <div className="mt-1 text-[11px] text-text-faint">
                  Used {turn.toolCalls.join(", ")}
                </div>
              ) : null}
            </div>
          ))
        )}
        {sending ? <div className="text-xs text-text-faint">Thinking…</div> : null}
        {error ? (
          <div className="rounded-sm bg-danger-bg px-2 py-1 text-[11px] text-danger">{error}</div>
        ) : null}
        {hasKey === false ? (
          <div className="rounded-sm bg-warning-bg px-2 py-1 text-[11px] text-warning">
            Add a provider key in Settings &gt; Provider to use the assistant.
          </div>
        ) : null}
      </div>

      <div className="flex gap-2 border-t border-border p-2.5">
        <input
          value={draft}
          disabled={hasKey !== true}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          placeholder="Ask about this request…"
          className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-xs text-text disabled:opacity-60"
        />
        <button
          aria-label="Send message"
          disabled={hasKey !== true || sending}
          onClick={() => void send()}
          className="rounded-sm bg-accent px-2.5 text-xs font-bold text-accent-on disabled:opacity-60"
        >
          Send
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Run and commit**

Run: `cd apps/devbench/src-tauri && cargo test --lib chat::` then `cd apps/devbench && bun run test`
Expected: PASS — the whole frontend suite, including `App.test.tsx`, is green now that every shell component exists.

```bash
git add apps/devbench/src-tauri apps/devbench/src
git commit -m "feat(devbench): add the BYOK chat dock with an MCP tool loop"
```

---

### Task 15: Full verification

**Files:** none created — this is the plan's proof.

- [ ] **Step 1: Run everything**

```bash
docker compose up -d
cd apps/devbench/src-tauri && cargo test
cd ../ && bun run test
```
Expected: PASS on both. Note the `#[ignore]`d keychain test does not run; verify it once manually:
```bash
cd apps/devbench/src-tauri && cargo test -- --ignored keyring_store_round_trips
```

- [ ] **Step 2: Verify persistence by hand**

```bash
cd apps/devbench && bun run tauri dev
```
DB tab → watch two tables. Quit. Relaunch. Expected: the same two tables are still watched, and the rollup no longer says "no tables are being watched".

- [ ] **Step 3: Verify the shell**

Expected in one window: sessions sidebar on the left with a **New session** button and **Settings** pinned at the bottom; tool tabs in the main column (not the topbar); chat dock on the right that *resizes* the content column when toggled from the topbar, never overlaying it. Arrow keys move between tool tabs (Base UI's roving tabindex). Tab reaches every DB table row.

- [ ] **Step 4: Verify split view**

Click **Split** → a second pane with its own tab bar. Put DB in one and API in the other, fire a request, and watch the grid and the rollup at once. Click a rollup chip → the *primary* pane switches, the secondary is untouched.

- [ ] **Step 5: Verify Settings end to end**

General: switch theme (applies immediately, survives restart); set the correlation window to 12s, fire a request, confirm the Log chip resolves after ~12s not ~5s; change the SMTP port and confirm the pane says it takes effect on restart. Provider: paste a key, confirm the pane reports it stored and the key never appears in the DOM (DevTools → search the document for the key prefix). MCP: add `npx @modelcontextprotocol/server-filesystem /tmp`, click **Check**, confirm a tool count. Archive: remove a session from the sidebar, confirm it appears in Archive, restore it, confirm it returns.

- [ ] **Step 6: Verify the chat**

With a key stored, ask the assistant a question. With an MCP server configured, ask something that needs it and confirm the "Used …" line names the tool. Remove the key and confirm the dock disables its input with the Settings pointer rather than failing on send.

- [ ] **Step 7: Commit**

```bash
git commit --allow-empty -m "chore(devbench): verify the v1 shell end to end"
```

---

## Self-Review

**Spec coverage.** Shell and sessions ("Three-column shell: sessions sidebar → main content → chat dock… The chat dock is collapsible and resizes the content column when toggled, never overlays it") — Tasks 4, 5, 14. Sessions as a pure organizational layer with an auto-inferred type badge, never a view restriction — Task 5, Decision 6. Split view ("a 'Split' control divides it into two independently-tabbed panes — any of the four tools in either pane") — Task 6. Settings as a full navigation destination with four sections, entered only from the sidebar button — Tasks 8–13. Settings > General (theme, correlation window, SMTP port) — Task 9, including making Plan 2's and Plan 3's constants live. Settings > Provider (BYOK key + model, key in OS-native secure storage) — Task 10. Settings > MCP (configured server list with connection status) and "the AI assistant can call configured MCP servers during a chat — a v1 capability, not deferred" — Tasks 11, 12, 14. Settings > Archive (restore removed sessions) — Task 13. Session archiving as a lifecycle, not a delete — Task 2. `DESIGN.md`'s ghosty/glass split, with the New Session picker as the only glass surface and Settings correctly ghosty — Tasks 5, 8. The Base UI rationale the spec gives (clickable `<div>`s that are not keyboard-navigable) — Tasks 4, 5, 7. Persisted watched tables, closing the `watched_tables`-table-exists-but-is-never-read gap — Task 3.

Deliberately **not** covered, each recorded above as a decision rather than an omission: hot-rebinding the SMTP listener on a port change (Decision 5 — takes effect on restart, and the pane says so); persisting split layout and chat transcripts (Decision 7); a connection-picker UI replacing `DEV_CONNECTION` (still open from Plan 1 — the correlation loop's remaining hardcoded value, and the natural first task of a v1.1 plan); the end-to-end tauri-driver + WebdriverIO smoke test named in the spec's Testing section (the Rust-level smoke tests in Plans 1–3 cover the correlation loop against real dependencies; driving the built app is a separate harness, not a task inside a feature plan).

**Placeholder scan.** No TBD/TODO markers. Every code step contains real code. The three third-party APIs this plan depends on were verified by compiling against the installed packages before the plan was written: Base UI's `Tabs.Root` `value`/`onValueChange`/`orientation` and its multi-select `ToggleGroup` (which is why Decision 1 narrows adoption), and `keyring`'s `Entry::new` / `set_password` / `get_password` / `delete_credential` / `Error::NoEntry`. The two deliberate "later" items — the SMTP port needing a restart (Decision 5) and in-memory split/chat state (Decision 7) — are both named as scoping decisions rather than left silent. Every `Result` is mapped to a real `format!` error string.

**Type consistency.** `AppSettings { theme, correlation_window_ms, smtp_port, provider, model }` is defined once in Task 1 and mirrored once in Task 8. `Session { id, name, kind, created_at, updated_at, archived_at }` is defined once in Task 2 and mirrored once in Task 5, then reused unchanged by Task 13. `ProviderStatus { provider, model, has_key }` — Task 10, mirrored once. `McpServerConfig` / `McpServerStatus` — Task 12, mirrored once. `ChatMessage` / `ChatReply` — Task 14, mirrored once. `SecretStore`'s three methods are used identically by `commands/provider.rs` and `commands/chat.rs`. `run_correlated_request_impl_with_registry` gains its `window_ms` parameter in Task 9, and that task updates every call site — the Plan 2 and Plan 3 test modules plus `tests/smoke_test.rs` — in the same commit. `TabId` is extended in Plan 2 and Plan 3 and is *not* changed here; `TABS` moves from `App.tsx` to `ToolTabs.tsx` in Task 4 with a re-export so no importer breaks.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-30-devbench-v1-shell.md`.
