# DevBench v1 — Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working, demoable slice of DevBench: fire an HTTP request from a real UI, watch it hit a real Postgres database, and see an accurate "what happened" rollup showing exactly which rows were inserted, updated, or deleted — the actual differentiator, proven end to end, before any other tool (Log, Email) or shell chrome (Sessions, Split view, Settings, Chat) exists.

**Architecture:** Tauri app (`apps/devbench`) with a React/Vite frontend and a Rust backend exposed as Tauri commands. The frontend never talks to Postgres directly — every DB/HTTP operation is a Rust command. Correlation is computed by diffing per-row content hashes (keyed by primary key) captured immediately before and after the request, not by net row-count, because an `UPDATE` changes zero rows in a count-based diff and would otherwise vanish from the rollup entirely.

**Tech Stack:** Bun + Turborepo (monorepo), Vite + React + TypeScript, Zustand, Tailwind CSS v4, Tauri 2 + Rust, sqlx (Postgres + SQLite), Vitest + React Testing Library (frontend tests), Rust's built-in test framework with `#[sqlx::test]` against a real local Postgres (backend tests).

## Global Constraints

- MIT license on all code in `apps/devbench` — no proprietary dependencies with incompatible licenses.
- Local-first: the app calls only the user's own target API and their own Postgres instance. No DevBench-operated server exists or is contacted anywhere in this plan.
- All DB/HTTP/filesystem operations happen in Rust, invoked from the frontend exclusively via `@tauri-apps/api`'s `invoke()` — the frontend holds no database driver.
- Visual system follows `DESIGN.md`: monochrome (no accent hue beyond inversion), dark-primary with independent light support, ghosty persistent chrome (no blur in this plan — nothing built here is a transient overlay).
- Diff/correlation logic is the most bug-prone, highest-value code in this plan (per the v1 spec's Testing section) — it is tested against a real local Postgres, never a mock.
- Package manager is Bun exclusively — no `npm install` / `yarn` commands anywhere in this plan.

---

## File Structure

```
bench-apps/
  package.json                          # root workspace manifest (Bun workspaces)
  turbo.json                            # Turborepo task graph
  apps/
    devbench/
      package.json
      vite.config.ts
      tsconfig.json
      tailwind.config.ts                 # Tailwind v4 config, @theme mapped to DESIGN.md tokens
      index.html
      src/
        main.tsx                        # React entry point
        App.tsx                         # topbar + tabbar + content shell (no sidebar/chat yet)
        styles/
          tokens.css                    # DESIGN.md tokens as CSS custom properties
          globals.css                   # Tailwind directives + base styles
        store/
          useAppStore.ts                # Zustand: activeTab, theme, activeConnectionId
        lib/
          tauri.ts                      # thin typed wrappers around invoke()
        components/
          shell/
            TopBar.tsx
            TopBar.test.tsx
            TabBar.tsx
            TabBar.test.tsx
          api/
            ApiTab.tsx
            RequestBuilder.tsx
            RequestBuilder.test.tsx
            ResponseViewer.tsx
            ResponseViewer.test.tsx
            HistorySidebar.tsx
            HistorySidebar.test.tsx
          db/
            DbTab.tsx
            SchemaTree.tsx
            SchemaTree.test.tsx
            DataGrid.tsx
            DataGrid.test.tsx
          rollup/
            Rollup.tsx
            Rollup.test.tsx
      src-tauri/
        Cargo.toml
        tauri.conf.json
        migrations/
          0001_init.sql                 # local SQLite schema
        src/
          main.rs
          local_db.rs                   # local SQLite connection + migrations
          commands/
            mod.rs
            request.rs                  # fire_request
            history.rs                  # save/list request history
            db.rs                       # db_connect_and_list_tables, list_table_rows
            correlation.rs              # snapshot/diff + run_correlated_request
```

**Responsibilities:**
- `local_db.rs` owns the app's own SQLite file (history, connections, watched tables) — never touches the user's Postgres.
- `commands/db.rs` owns read/introspection operations against the user's Postgres (connect, list tables, list rows).
- `commands/correlation.rs` owns the diff algorithm and the orchestration that ties `request.rs` and `db.rs` together into one correlated call — this is the file with the highest bug cost in the whole plan.
- `commands/request.rs` is a thin, generic HTTP-firing command with no DB knowledge — kept separate so it stays reusable and easy to reason about in isolation.

---

### Task 1: Monorepo scaffold — Bun workspaces, Turborepo, Tauri app shell

**Files:**
- Create: `package.json` (root)
- Create: `turbo.json`
- Create: `apps/devbench/package.json`
- Create: `apps/devbench/src-tauri/Cargo.toml`
- Create: `apps/devbench/src-tauri/tauri.conf.json`
- Create: `apps/devbench/src-tauri/src/main.rs`
- Create: `apps/devbench/index.html`
- Create: `apps/devbench/vite.config.ts`
- Create: `apps/devbench/tsconfig.json`
- Create: `apps/devbench/src/main.tsx`
- Create: `apps/devbench/src/App.tsx`

**Interfaces:**
- Produces: a running `bun run dev` at the repo root that launches the Tauri window showing a placeholder React page. Nothing downstream depends on any exported function yet — this task's contract is "the app launches."

- [ ] **Step 1: Root workspace manifest**

`package.json`:
```json
{
  "name": "bench-apps",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test"
  },
  "devDependencies": {
    "turbo": "^2.1.0"
  }
}
```

- [ ] **Step 2: Turborepo task graph**

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": {
      "cache": false,
      "persistent": true
    },
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "src-tauri/target/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    }
  }
}
```

- [ ] **Step 3: devbench app manifest**

`apps/devbench/package.json`:
```json
{
  "name": "devbench",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "vite dev",
    "build": "tsc && vite build",
    "test": "vitest run",
    "tauri": "tauri"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zustand": "^4.5.0",
    "@tauri-apps/api": "^2.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.5.0",
    "jsdom": "^25.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0"
  }
}
```

- [ ] **Step 4: Vite config**

`apps/devbench/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
```

`apps/devbench/src/test-setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 5: TypeScript config**

`apps/devbench/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 6: HTML entry + React entry point**

`apps/devbench/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>DevBench</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/devbench/src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`apps/devbench/src/App.tsx` (placeholder — real shell built in Task 3):
```tsx
export default function App() {
  return <div>DevBench</div>;
}
```

- [ ] **Step 7: Tauri shell**

`apps/devbench/src-tauri/Cargo.toml`:
```toml
[package]
name = "devbench"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
tauri = { version = "2.0", features = [] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1.40", features = ["full"] }

[[bin]]
name = "devbench"
path = "src/main.rs"
```

`apps/devbench/src-tauri/tauri.conf.json`:
```json
{
  "productName": "DevBench",
  "version": "0.1.0",
  "identifier": "com.benchapps.devbench",
  "build": {
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "DevBench",
        "width": 1280,
        "height": 800
      }
    ]
  }
}
```

`apps/devbench/src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running devbench");
}
```

- [ ] **Step 8: Verify it launches**

Run: `bun install && bun run dev`
Expected: a Tauri window opens showing the text "DevBench". No Rust commands are registered yet — that starts in Task 5.

- [ ] **Step 9: Commit**

```bash
git add package.json turbo.json apps/devbench
git commit -m "chore: scaffold devbench monorepo (Bun/Turborepo/Tauri/Vite/React)"
```

---

### Task 2: Design tokens + Tailwind v4 wiring

**Files:**
- Create: `apps/devbench/src/styles/tokens.css`
- Create: `apps/devbench/src/styles/globals.css`
- Modify: `apps/devbench/src/main.tsx` (already imports `globals.css` from Task 1 — no change needed)
- Test: `apps/devbench/src/styles/tokens.test.tsx`

**Interfaces:**
- Produces: CSS custom properties (`--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--text-faint`, `--accent`, `--accent-strong`, `--accent-on`, `--success`, `--success-bg`, `--warning`, `--warning-bg`, `--danger`, `--danger-bg`, `--radius-sm`, `--radius-lg`) available globally, and Tailwind utilities (`bg-surface`, `text-muted`, etc.) that reference them. Every later component task consumes these Tailwind utilities, not raw CSS variables directly.

- [ ] **Step 1: Token values from DESIGN.md**

`apps/devbench/src/styles/tokens.css`:
```css
:root {
  --bg: #08090c;
  --surface: #121419;
  --surface-2: #191c22;
  --border: #24262e;
  --text: #ecedf2;
  --text-muted: #999fac;
  --text-faint: #666d7a;
  --accent: #f2f3f5;
  --accent-strong: #ffffff;
  --accent-on: #0a0b0e;
  --success: #3fce85;
  --success-bg: #12271c;
  --warning: #e3a438;
  --warning-bg: #2b2210;
  --danger: #e5695f;
  --danger-bg: #2b1514;
  --radius-sm: 6px;
  --radius-lg: 12px;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f7fa;
    --surface: #ffffff;
    --surface-2: #eef1f6;
    --border: #dde3ec;
    --text: #10151f;
    --text-muted: #5b6472;
    --text-faint: #8a92a1;
    --accent: #10151f;
    --accent-strong: #000000;
    --accent-on: #ffffff;
    --success: #167a45;
    --success-bg: #e3f5eb;
    --warning: #a3660a;
    --warning-bg: #faf0dc;
    --danger: #b93a3a;
    --danger-bg: #fbe9e9;
  }
}

:root[data-theme="dark"] {
  --bg: #08090c; --surface: #121419; --surface-2: #191c22; --border: #24262e;
  --text: #ecedf2; --text-muted: #999fac; --text-faint: #666d7a;
  --accent: #f2f3f5; --accent-strong: #ffffff; --accent-on: #0a0b0e;
  --success: #3fce85; --success-bg: #12271c;
  --warning: #e3a438; --warning-bg: #2b2210;
  --danger: #e5695f; --danger-bg: #2b1514;
}

:root[data-theme="light"] {
  --bg: #f5f7fa; --surface: #ffffff; --surface-2: #eef1f6; --border: #dde3ec;
  --text: #10151f; --text-muted: #5b6472; --text-faint: #8a92a1;
  --accent: #10151f; --accent-strong: #000000; --accent-on: #ffffff;
  --success: #167a45; --success-bg: #e3f5eb;
  --warning: #a3660a; --warning-bg: #faf0dc;
  --danger: #b93a3a; --danger-bg: #fbe9e9;
}
```

- [ ] **Step 2: Tailwind v4 theme mapped to the tokens**

`apps/devbench/src/styles/globals.css`:
```css
@import "tailwindcss";
@import "./tokens.css";

@theme {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-border: var(--border);
  --color-text: var(--text);
  --color-text-muted: var(--text-muted);
  --color-text-faint: var(--text-faint);
  --color-accent: var(--accent);
  --color-accent-strong: var(--accent-strong);
  --color-accent-on: var(--accent-on);
  --color-success: var(--success);
  --color-success-bg: var(--success-bg);
  --color-warning: var(--warning);
  --color-warning-bg: var(--warning-bg);
  --color-danger: var(--danger);
  --color-danger-bg: var(--danger-bg);
  --radius-sm: var(--radius-sm);
  --radius-lg: var(--radius-lg);
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Consolas, monospace;
}

body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
}
```

`apps/devbench/tailwind.config.ts` (v4 needs this only for `content` globbing, theme now lives in CSS):
```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
} satisfies Config;
```

- [ ] **Step 3: Write the failing test**

`apps/devbench/src/styles/tokens.test.tsx`:
```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("design tokens", () => {
  it("exposes --bg as a computed style on the document root", () => {
    render(<div />);
    const value = getComputedStyle(document.documentElement).getPropertyValue("--bg");
    expect(value.trim()).not.toBe("");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun run test -- tokens.test.tsx`
Expected: FAIL — `tokens.css` isn't imported by anything the test loads yet (jsdom doesn't process Vite's CSS imports from `main.tsx` in isolation).

- [ ] **Step 5: Import tokens directly in the test setup so jsdom sees them**

Modify `apps/devbench/src/test-setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
import "./styles/tokens.css";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run test -- tokens.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/styles apps/devbench/src/test-setup.ts apps/devbench/tailwind.config.ts
git commit -m "feat: wire DESIGN.md tokens into Tailwind v4 theme"
```

---

### Task 3: Zustand store + shell layout (topbar + tabbar + content)

**Files:**
- Create: `apps/devbench/src/store/useAppStore.ts`
- Create: `apps/devbench/src/store/useAppStore.test.ts`
- Modify: `apps/devbench/src/App.tsx`
- Test: `apps/devbench/src/App.test.tsx`

**Interfaces:**
- Produces: `useAppStore()` hook with shape `{ activeTab: "api" | "db"; setActiveTab: (tab: "api" | "db") => void; theme: "dark" | "light" | "system"; setTheme: (t) => void }`. Every component task after this one reads `activeTab`/`setActiveTab` from this store — the type name `"api" | "db"` is authoritative for the rest of this plan (Log/Email are added to this union in their own plans, not here).

- [ ] **Step 1: Write the failing store test**

`apps/devbench/src/store/useAppStore.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

describe("useAppStore", () => {
  it("defaults to the api tab and dark theme", () => {
    const state = useAppStore.getState();
    expect(state.activeTab).toBe("api");
    expect(state.theme).toBe("dark");
  });

  it("setActiveTab switches tabs", () => {
    useAppStore.getState().setActiveTab("db");
    expect(useAppStore.getState().activeTab).toBe("db");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- useAppStore.test.ts`
Expected: FAIL — `./useAppStore` doesn't exist.

- [ ] **Step 3: Implement the store**

`apps/devbench/src/store/useAppStore.ts`:
```ts
import { create } from "zustand";

export type TabId = "api" | "db";
export type ThemePref = "dark" | "light" | "system";

interface AppState {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  theme: ThemePref;
  setTheme: (theme: ThemePref) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: "api",
  setActiveTab: (tab) => set({ activeTab: tab }),
  theme: "dark",
  setTheme: (theme) => set({ theme }),
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- useAppStore.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing shell layout test**

`apps/devbench/src/App.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App shell", () => {
  it("renders the DevBench brand and both tabs", () => {
    render(<App />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "API" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "DB" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun run test -- App.test.tsx`
Expected: FAIL — `App.tsx` is still the Task 1 placeholder with no tabs.

- [ ] **Step 7: Implement the shell layout**

`apps/devbench/src/App.tsx`:
```tsx
import { useAppStore } from "./store/useAppStore";

export default function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-13 items-center gap-4 border-b border-border px-4">
        <span className="font-bold text-text">DevBench</span>
        <nav className="flex gap-1" aria-label="DevBench sections">
          <button
            role="tab"
            aria-selected={activeTab === "api"}
            className={`rounded-sm px-3 py-2 text-sm font-medium ${
              activeTab === "api" ? "bg-surface-2 text-text" : "text-text-muted"
            }`}
            onClick={() => setActiveTab("api")}
          >
            API
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "db"}
            className={`rounded-sm px-3 py-2 text-sm font-medium ${
              activeTab === "db" ? "bg-surface-2 text-text" : "text-text-muted"
            }`}
            onClick={() => setActiveTab("db")}
          >
            DB
          </button>
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        {activeTab === "api" ? <div data-testid="api-panel" /> : <div data-testid="db-panel" />}
      </main>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun run test -- App.test.tsx`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src/store apps/devbench/src/App.tsx apps/devbench/src/App.test.tsx
git commit -m "feat: add Zustand store and app shell with API/DB tab switching"
```

---

### Task 4: Rust `fire_request` command

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/mod.rs`
- Create: `apps/devbench/src-tauri/src/commands/request.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Modify: `apps/devbench/src-tauri/Cargo.toml`
- Test: inline `#[cfg(test)]` module in `request.rs`

**Interfaces:**
- Produces: Tauri command `fire_request(input: FireRequestInput) -> Result<FireRequestOutput, String>` where `FireRequestInput { method: String, url: String, body: Option<String> }` and `FireRequestOutput { status_code: u16, body: String, duration_ms: u64 }`. Task 6 (RequestBuilder) and Task 8 (correlation orchestration) both call this exact command name and shape.

- [ ] **Step 1: Add `reqwest` dependency**

Modify `apps/devbench/src-tauri/Cargo.toml`, add under `[dependencies]`:
```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

- [ ] **Step 2: Write the failing test**

`apps/devbench/src-tauri/src/commands/request.rs`:
```rust
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Deserialize)]
pub struct FireRequestInput {
    pub method: String,
    pub url: String,
    pub body: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FireRequestOutput {
    pub status_code: u16,
    pub body: String,
    pub duration_ms: u64,
}

pub async fn fire_request_impl(input: FireRequestInput) -> Result<FireRequestOutput, String> {
    let client = reqwest::Client::new();
    let method: reqwest::Method = input
        .method
        .parse()
        .map_err(|e| format!("invalid method '{}': {e}", input.method))?;
    let mut req = client.request(method, &input.url);
    if let Some(body) = &input.body {
        req = req.header("content-type", "application/json").body(body.clone());
    }

    let started = Instant::now();
    let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status_code = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("failed to read response body: {e}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    Ok(FireRequestOutput { status_code, body, duration_ms })
}

#[tauri::command]
pub async fn fire_request(input: FireRequestInput) -> Result<FireRequestOutput, String> {
    fire_request_impl(input).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fires_a_get_request_and_reports_status() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .with_status(200)
            .with_body("pong")
            .create_async()
            .await;

        let result = fire_request_impl(FireRequestInput {
            method: "GET".to_string(),
            url: format!("{}/ping", server.url()),
            body: None,
        })
        .await
        .expect("request should succeed");

        mock.assert_async().await;
        assert_eq!(result.status_code, 200);
        assert_eq!(result.body, "pong");
    }

    #[tokio::test]
    async fn rejects_an_invalid_method() {
        let result = fire_request_impl(FireRequestInput {
            method: "NOT-A-METHOD lol".to_string(),
            url: "http://localhost".to_string(),
            body: None,
        })
        .await;

        assert!(result.is_err());
    }
}
```

Add test-only dependency to `Cargo.toml`:
```toml
[dev-dependencies]
mockito = "1.5"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/devbench/src-tauri && cargo test fires_a_get_request`
Expected: FAIL to compile — `commands` module isn't wired into `main.rs` yet, and `mockito` isn't installed.

- [ ] **Step 3: Wire the module and dependency**

Run: `cd apps/devbench/src-tauri && cargo add mockito --dev`

`apps/devbench/src-tauri/src/commands/mod.rs`:
```rust
pub mod request;
```

Modify `apps/devbench/src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::request::fire_request])
        .run(tauri::generate_context!())
        .expect("error while running devbench");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/devbench/src-tauri && cargo test fire_request`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri
git commit -m "feat: add fire_request Tauri command"
```

---

### Task 5: RequestBuilder + ResponseViewer components

**Files:**
- Create: `apps/devbench/src/lib/tauri.ts`
- Create: `apps/devbench/src/components/api/RequestBuilder.tsx`
- Create: `apps/devbench/src/components/api/RequestBuilder.test.tsx`
- Create: `apps/devbench/src/components/api/ResponseViewer.tsx`
- Create: `apps/devbench/src/components/api/ResponseViewer.test.tsx`
- Create: `apps/devbench/src/components/api/ApiTab.tsx`
- Modify: `apps/devbench/src/App.tsx`

**Interfaces:**
- Consumes: Tauri command `fire_request` from Task 4 (via the `invokeFireRequest` wrapper defined here).
- Produces: `<ApiTab />` — a self-contained component rendering the request builder and response viewer, holding its own local response state. `ResponseViewer` accepts `{ result: FireRequestOutput | null }`. This is the shape Task 8 (correlation wiring) will replace the direct `invokeFireRequest` call in — noted there, not changed here.

- [ ] **Step 1: Typed Tauri invoke wrapper**

`apps/devbench/src/lib/tauri.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

export interface FireRequestInput {
  method: string;
  url: string;
  body?: string;
}

export interface FireRequestOutput {
  status_code: number;
  body: string;
  duration_ms: number;
}

export function invokeFireRequest(input: FireRequestInput): Promise<FireRequestOutput> {
  return invoke("fire_request", { input });
}
```

- [ ] **Step 2: Write the failing ResponseViewer test**

`apps/devbench/src/components/api/ResponseViewer.test.tsx`:
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
    render(
      <ResponseViewer
        result={{ status_code: 200, body: '{"id":8841}', duration_ms: 142 }}
      />,
    );
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("142ms")).toBeInTheDocument();
    expect(screen.getByText('{"id":8841}')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- ResponseViewer.test.tsx`
Expected: FAIL — `./ResponseViewer` doesn't exist.

- [ ] **Step 4: Implement ResponseViewer**

`apps/devbench/src/components/api/ResponseViewer.tsx`:
```tsx
import type { FireRequestOutput } from "../../lib/tauri";

export function ResponseViewer({ result }: { result: FireRequestOutput | null }) {
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
      </div>
      <pre className="whitespace-pre-wrap rounded-b-lg border-t border-border bg-surface-2 p-3 font-mono text-sm text-text">
        {result.body}
      </pre>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- ResponseViewer.test.tsx`
Expected: PASS

- [ ] **Step 6: Write the failing RequestBuilder test**

`apps/devbench/src/components/api/RequestBuilder.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestBuilder } from "./RequestBuilder";
import * as tauriLib from "../../lib/tauri";

describe("RequestBuilder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires a request with the entered URL and reports the result", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeFireRequest").mockResolvedValue({
      status_code: 200,
      body: "{}",
      duration_ms: 12,
    });

    render(<RequestBuilder onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), {
      target: { value: "/api/orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({
      status_code: 200,
      body: "{}",
      duration_ms: 12,
    }));
    expect(tauriLib.invokeFireRequest).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/orders",
      body: undefined,
    });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `bun run test -- RequestBuilder.test.tsx`
Expected: FAIL — `./RequestBuilder` doesn't exist.

- [ ] **Step 8: Implement RequestBuilder**

`apps/devbench/src/components/api/RequestBuilder.tsx`:
```tsx
import { useState } from "react";
import { invokeFireRequest, type FireRequestOutput } from "../../lib/tauri";

export function RequestBuilder({ onResult }: { onResult: (result: FireRequestOutput) => void }) {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    setSending(true);
    try {
      const result = await invokeFireRequest({ method, url, body: undefined });
      onResult(result);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex gap-2 rounded-t-lg border border-b-0 border-border bg-surface p-3">
      <select
        value={method}
        onChange={(e) => setMethod(e.target.value)}
        className="rounded-sm border border-border bg-surface-2 px-2.5 py-2 font-bold text-text"
      >
        <option>GET</option>
        <option>POST</option>
        <option>PUT</option>
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
  );
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `bun run test -- RequestBuilder.test.tsx`
Expected: PASS

- [ ] **Step 10: Assemble ApiTab and wire into App**

`apps/devbench/src/components/api/ApiTab.tsx`:
```tsx
import { useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import type { FireRequestOutput } from "../../lib/tauri";

export function ApiTab() {
  const [result, setResult] = useState<FireRequestOutput | null>(null);

  return (
    <div className="mx-auto flex max-w-180 flex-col gap-4">
      <RequestBuilder onResult={setResult} />
      <ResponseViewer result={result} />
    </div>
  );
}
```

Modify `apps/devbench/src/App.tsx` — replace the `data-testid="api-panel"` placeholder:
```tsx
import { ApiTab } from "./components/api/ApiTab";
// ...
{activeTab === "api" ? <ApiTab /> : <div data-testid="db-panel" />}
```

- [ ] **Step 11: Commit**

```bash
git add apps/devbench/src/lib apps/devbench/src/components/api apps/devbench/src/App.tsx
git commit -m "feat: add RequestBuilder and ResponseViewer, wire into ApiTab"
```

---

### Task 6: Local SQLite — connection, migrations, request history

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0001_init.sql`
- Create: `apps/devbench/src-tauri/src/local_db.rs`
- Create: `apps/devbench/src-tauri/src/commands/history.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`
- Modify: `apps/devbench/src-tauri/Cargo.toml`

**Interfaces:**
- Produces: Tauri commands `save_history_entry(entry: HistoryEntryInput) -> Result<(), String>` and `list_history() -> Result<Vec<HistoryEntry>, String>`, and a `local_db::LocalDb` struct exposing `pool: sqlx::SqlitePool`, managed as Tauri app state. Task 8's correlation orchestration calls `save_history_entry` after every fired request. `HistoryEntry` fields (`id, method, url, status_code, duration_ms, fired_at`) are the authoritative shape Task 7's `HistorySidebar` component renders.

- [ ] **Step 1: Add sqlx dependency**

Modify `apps/devbench/src-tauri/Cargo.toml`:
```toml
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "sqlite", "postgres", "chrono", "uuid"] }
uuid = { version = "1.10", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
```

- [ ] **Step 2: Migration**

`apps/devbench/src-tauri/migrations/0001_init.sql`:
```sql
CREATE TABLE request_history (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  fired_at TEXT NOT NULL
);

CREATE TABLE watched_tables (
  connection_key TEXT NOT NULL,
  table_name TEXT NOT NULL,
  PRIMARY KEY (connection_key, table_name)
);
```

- [ ] **Step 3: Local DB connection module**

`apps/devbench/src-tauri/src/local_db.rs`:
```rust
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use std::path::PathBuf;

pub struct LocalDb {
    pub pool: SqlitePool,
}

impl LocalDb {
    pub async fn connect(app_data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("failed to create app data dir: {e}"))?;
        let db_path = app_data_dir.join("devbench.db");
        let url = format!("sqlite://{}?mode=rwc", db_path.display());

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .map_err(|e| format!("failed to connect to local db: {e}"))?;

        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|e| format!("migration failed: {e}"))?;

        Ok(Self { pool })
    }
}
```

- [ ] **Step 4: History commands**

`apps/devbench/src-tauri/src/commands/history.rs`:
```rust
use crate::local_db::LocalDb;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct HistoryEntryInput {
    pub method: String,
    pub url: String,
    pub status_code: u16,
    pub response_body: String,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct HistoryEntry {
    pub id: String,
    pub method: String,
    pub url: String,
    pub status_code: i64,
    pub response_body: String,
    pub duration_ms: i64,
    pub fired_at: String,
}

#[tauri::command]
pub async fn save_history_entry(
    db: State<'_, LocalDb>,
    entry: HistoryEntryInput,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let fired_at = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&entry.method)
    .bind(&entry.url)
    .bind(entry.status_code as i64)
    .bind(&entry.response_body)
    .bind(entry.duration_ms as i64)
    .bind(&fired_at)
    .execute(&db.pool)
    .await
    .map_err(|e| format!("failed to save history entry: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn list_history(db: State<'_, LocalDb>) -> Result<Vec<HistoryEntry>, String> {
    let rows = sqlx::query(
        "SELECT id, method, url, status_code, response_body, duration_ms, fired_at \
         FROM request_history ORDER BY fired_at DESC LIMIT 50",
    )
    .fetch_all(&db.pool)
    .await
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
        })
        .collect())
}
```

- [ ] **Step 5: Register the module, manage `LocalDb` as app state**

`apps/devbench/src-tauri/src/commands/mod.rs`:
```rust
pub mod history;
pub mod request;
```

Modify `apps/devbench/src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod local_db;

use local_db::LocalDb;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            tauri::async_runtime::block_on(async move {
                let db = LocalDb::connect(data_dir)
                    .await
                    .expect("failed to initialize local database");
                handle.manage(db);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::request::fire_request,
            commands::history::save_history_entry,
            commands::history::list_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devbench");
}
```

Add `tauri = { version = "2.0", features = ["path-all"] }` is unnecessary — `app.path()` is core API; no `Cargo.toml` change needed beyond Step 1.

- [ ] **Step 6: Write and run a Rust test for the history commands**

Append to `apps/devbench/src-tauri/src/commands/history.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_db::LocalDb;

    #[tokio::test]
    async fn saves_and_lists_a_history_entry() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();

        sqlx::query(
            "INSERT INTO request_history (id, method, url, status_code, response_body, duration_ms, fired_at) \
             VALUES ('1', 'GET', '/api/orders', 200, '{}', 12, '2026-07-30T00:00:00Z')",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        let rows = sqlx::query(
            "SELECT id, method, url, status_code, response_body, duration_ms, fired_at FROM request_history",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 1);
    }
}
```

Add dev-dependency: `cargo add tempfile --dev`

Run: `cd apps/devbench/src-tauri && cargo test saves_and_lists_a_history_entry`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src-tauri
git commit -m "feat: add local SQLite storage and request history commands"
```

---

### Task 7: HistorySidebar component

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Create: `apps/devbench/src/components/api/HistorySidebar.tsx`
- Create: `apps/devbench/src/components/api/HistorySidebar.test.tsx`
- Modify: `apps/devbench/src/components/api/ApiTab.tsx`

**Interfaces:**
- Consumes: `list_history` command from Task 6.
- Produces: `<HistorySidebar onSelect={(entry: HistoryEntry) => void} />`. `ApiTab` renders it alongside the request builder.

- [ ] **Step 1: Add typed wrapper**

Modify `apps/devbench/src/lib/tauri.ts`, append:
```ts
export interface HistoryEntry {
  id: string;
  method: string;
  url: string;
  status_code: number;
  response_body: string;
  duration_ms: number;
  fired_at: string;
}

export function invokeListHistory(): Promise<HistoryEntry[]> {
  return invoke("list_history");
}
```

- [ ] **Step 2: Write the failing test**

`apps/devbench/src/components/api/HistorySidebar.test.tsx`:
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HistorySidebar } from "./HistorySidebar";
import * as tauriLib from "../../lib/tauri";

describe("HistorySidebar", () => {
  it("lists past requests with method, path, and status", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([
      {
        id: "1",
        method: "POST",
        url: "/api/orders",
        status_code: 200,
        response_body: "{}",
        duration_ms: 142,
        fired_at: "2026-07-30T14:02:11Z",
      },
    ]);

    render(<HistorySidebar onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText("/api/orders")).toBeInTheDocument());
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- HistorySidebar.test.tsx`
Expected: FAIL — `./HistorySidebar` doesn't exist.

- [ ] **Step 4: Implement HistorySidebar**

`apps/devbench/src/components/api/HistorySidebar.tsx`:
```tsx
import { useEffect, useState } from "react";
import { invokeListHistory, type HistoryEntry } from "../../lib/tauri";

export function HistorySidebar({ onSelect }: { onSelect: (entry: HistoryEntry) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    invokeListHistory().then(setEntries);
  }, []);

  return (
    <aside className="w-55 min-w-55 border-r border-border">
      <div className="border-b border-border p-2.5 text-xs font-bold text-text-muted">History</div>
      <div className="flex flex-col gap-0.5 p-1.5">
        {entries.map((entry) => (
          <button
            key={entry.id}
            onClick={() => onSelect(entry)}
            className="flex flex-col gap-0.5 rounded-sm p-2 text-left hover:bg-surface-2"
          >
            <div className="flex items-center gap-1.5">
              <span className="w-10 text-xs font-bold text-text-muted">{entry.method}</span>
              <span className="truncate font-mono text-xs text-text">{entry.url}</span>
            </div>
            <span className="text-[11px] text-text-faint">{entry.status_code}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- HistorySidebar.test.tsx`
Expected: PASS

- [ ] **Step 6: Wire into ApiTab**

Modify `apps/devbench/src/components/api/ApiTab.tsx`:
```tsx
import { useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { HistorySidebar } from "./HistorySidebar";
import type { FireRequestOutput, HistoryEntry } from "../../lib/tauri";

export function ApiTab() {
  const [result, setResult] = useState<FireRequestOutput | null>(null);

  function handleHistorySelect(entry: HistoryEntry) {
    setResult({
      status_code: entry.status_code,
      body: entry.response_body,
      duration_ms: entry.duration_ms,
    });
  }

  return (
    <div className="-m-6 flex h-full">
      <HistorySidebar onSelect={handleHistorySelect} />
      <div className="mx-auto flex max-w-180 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <RequestBuilder onResult={setResult} />
        <ResponseViewer result={result} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/lib apps/devbench/src/components/api
git commit -m "feat: add HistorySidebar to the API tab"
```

---

### Task 8: Postgres connection + schema introspection

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/db.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Produces: `connection_string(input: &DbConnectInput) -> String` (used by Task 9's correlation module too — not re-derived there), and Tauri command `db_connect_and_list_tables(input: DbConnectInput) -> Result<Vec<TableInfo>, String>` where `TableInfo { schema: String, name: String }`.

- [ ] **Step 1: Write the failing test**

`apps/devbench/src-tauri/src/commands/db.rs`:
```rust
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;

#[derive(Debug, Deserialize, Clone)]
pub struct DbConnectInput {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}

pub fn connection_string(input: &DbConnectInput) -> String {
    format!(
        "postgres://{}:{}@{}:{}/{}",
        input.username, input.password, input.host, input.port, input.database
    )
}

#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
}

pub async fn list_tables_impl(input: &DbConnectInput) -> Result<Vec<TableInfo>, String> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(input))
        .await
        .map_err(|e| format!("connection failed: {e}"))?;

    let rows = sqlx::query(
        "SELECT table_schema, table_name FROM information_schema.tables \
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
         ORDER BY table_schema, table_name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("query failed: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| TableInfo {
            schema: r.get("table_schema"),
            name: r.get("table_name"),
        })
        .collect())
}

#[tauri::command]
pub async fn db_connect_and_list_tables(input: DbConnectInput) -> Result<Vec<TableInfo>, String> {
    list_tables_impl(&input).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> DbConnectInput {
        DbConnectInput {
            host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
            port: 5432,
            database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            password: std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into()),
        }
    }

    #[tokio::test]
    async fn lists_the_public_orders_table() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres — see CONTRIBUTING for setup");

        sqlx::query("DROP TABLE IF EXISTS orders_for_test")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE orders_for_test (id serial PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();

        let tables = list_tables_impl(&conn).await.unwrap();
        assert!(tables.iter().any(|t| t.name == "orders_for_test" && t.schema == "public"));

        sqlx::query("DROP TABLE orders_for_test").execute(&pool).await.unwrap();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/devbench/src-tauri && cargo test lists_the_public_orders_table`
Expected: FAIL — `commands::db` isn't registered in `mod.rs` yet, won't compile.

- [ ] **Step 3: Register the module and command**

`apps/devbench/src-tauri/src/commands/mod.rs`:
```rust
pub mod db;
pub mod history;
pub mod request;
```

Modify `apps/devbench/src-tauri/src/main.rs`, add to `generate_handler!`:
```rust
commands::db::db_connect_and_list_tables,
```

- [ ] **Step 4: Run test to verify it passes**

Requires a real local Postgres reachable with the env vars in `test_connection()` (defaults: `localhost:5432`, db `devbench_test`, user/pass `postgres`/`postgres`) — per this plan's Global Constraints, this is intentional, not a gap to fix later.

Run: `cd apps/devbench/src-tauri && cargo test lists_the_public_orders_table`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri
git commit -m "feat: add Postgres connection and schema introspection command"
```

---

### Task 9: Correlation engine — snapshot, diff by primary key + content hash

**Files:**
- Create: `apps/devbench/src-tauri/src/commands/correlation.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `commands::db::{DbConnectInput, connection_string}` from Task 8.
- Produces: `diff_table_snapshots(table: &str, before: &[RowSnapshot], after: &[RowSnapshot]) -> TableDiff` where `TableDiff { table: String, inserted: i64, updated: i64, deleted: i64 }`. This exact function and type are what Task 10's `run_correlated_request` command calls per watched table — the type name `TableDiff` is authoritative for Task 11 (Rollup component) too, which renders it as-is via serde.

This is the highest-value, highest-bug-cost code in the plan (per the spec's Testing section) — diffing by net row count would silently miss every `UPDATE`, since an update changes zero rows in a count. Diffing is done per-row, keyed by primary key, comparing a content hash.

- [ ] **Step 1: Write the failing test for the diff algorithm (pure function, no DB needed)**

`apps/devbench/src-tauri/src/commands/correlation.rs`:
```rust
use super::db::{connection_string, DbConnectInput};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Pool, Postgres, Row};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct RowSnapshot {
    pub pk: String,
    pub hash: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TableDiff {
    pub table: String,
    pub inserted: i64,
    pub updated: i64,
    pub deleted: i64,
}

pub fn diff_table_snapshots(table: &str, before: &[RowSnapshot], after: &[RowSnapshot]) -> TableDiff {
    let before_map: HashMap<&str, &str> =
        before.iter().map(|r| (r.pk.as_str(), r.hash.as_str())).collect();
    let after_map: HashMap<&str, &str> =
        after.iter().map(|r| (r.pk.as_str(), r.hash.as_str())).collect();

    let mut inserted = 0i64;
    let mut updated = 0i64;
    for (pk, after_hash) in &after_map {
        match before_map.get(pk) {
            None => inserted += 1,
            Some(before_hash) if before_hash != after_hash => updated += 1,
            _ => {}
        }
    }

    let deleted = before_map.keys().filter(|pk| !after_map.contains_key(*pk)).count() as i64;

    TableDiff {
        table: table.to_string(),
        inserted,
        updated,
        deleted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(pk: &str, hash: &str) -> RowSnapshot {
        RowSnapshot { pk: pk.to_string(), hash: hash.to_string() }
    }

    #[test]
    fn detects_an_insert() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a"), snap("2", "b")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 1, updated: 0, deleted: 0 });
    }

    #[test]
    fn detects_an_update_even_though_row_count_is_unchanged() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a-changed")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 1, deleted: 0 });
    }

    #[test]
    fn detects_a_delete() {
        let before = vec![snap("1", "a"), snap("2", "b")];
        let after = vec![snap("1", "a")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 0, deleted: 1 });
    }

    #[test]
    fn reports_nothing_when_unchanged() {
        let before = vec![snap("1", "a")];
        let after = vec![snap("1", "a")];
        let diff = diff_table_snapshots("orders", &before, &after);
        assert_eq!(diff, TableDiff { table: "orders".into(), inserted: 0, updated: 0, deleted: 0 });
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/devbench/src-tauri && cargo test detects_an_insert detects_an_update detects_a_delete reports_nothing`
Expected: FAIL to compile — `commands::correlation` isn't registered in `mod.rs`.

- [ ] **Step 3: Register the module**

`apps/devbench/src-tauri/src/commands/mod.rs`:
```rust
pub mod correlation;
pub mod db;
pub mod history;
pub mod request;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/devbench/src-tauri && cargo test detects_an_insert detects_an_update detects_a_delete reports_nothing`
Expected: PASS (all four)

- [ ] **Step 5: Add the Postgres-backed snapshot function (requires a real table, tested against real Postgres)**

Append to `apps/devbench/src-tauri/src/commands/correlation.rs`:
```rust
pub async fn get_primary_key_column(pool: &Pool<Postgres>, table: &str) -> Result<String, String> {
    let row = sqlx::query(
        "SELECT kcu.column_name FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name \
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 LIMIT 1",
    )
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("failed to look up primary key for {table}: {e}"))?;

    row.map(|r| r.get::<String, _>("column_name"))
        .ok_or_else(|| format!("table {table} has no single-column primary key — not watchable"))
}

pub async fn snapshot_table(
    pool: &Pool<Postgres>,
    table: &str,
    pk_col: &str,
) -> Result<Vec<RowSnapshot>, String> {
    let sql = format!("SELECT {pk_col}::text as pk, md5(t::text) as hash FROM {table} t");
    let rows = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("snapshot failed for {table}: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|r| RowSnapshot { pk: r.get("pk"), hash: r.get("hash") })
        .collect())
}
```

- [ ] **Step 6: Write and run the Postgres-backed test**

Append to the `#[cfg(test)] mod tests` block:
```rust
    fn test_connection() -> DbConnectInput {
        DbConnectInput {
            host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
            port: 5432,
            database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            password: std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into()),
        }
    }

    #[tokio::test]
    async fn snapshot_and_diff_detects_a_real_update() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        sqlx::query("DROP TABLE IF EXISTS correlation_test").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE correlation_test (id serial PRIMARY KEY, status text)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO correlation_test (status) VALUES ('pending')")
            .execute(&pool).await.unwrap();

        let pk_col = get_primary_key_column(&pool, "correlation_test").await.unwrap();
        assert_eq!(pk_col, "id");

        let before = snapshot_table(&pool, "correlation_test", &pk_col).await.unwrap();
        sqlx::query("UPDATE correlation_test SET status = 'shipped' WHERE id = 1")
            .execute(&pool).await.unwrap();
        let after = snapshot_table(&pool, "correlation_test", &pk_col).await.unwrap();

        let diff = diff_table_snapshots("correlation_test", &before, &after);
        assert_eq!(diff, TableDiff { table: "correlation_test".into(), inserted: 0, updated: 1, deleted: 0 });

        sqlx::query("DROP TABLE correlation_test").execute(&pool).await.unwrap();
    }
```

Run: `cd apps/devbench/src-tauri && cargo test snapshot_and_diff_detects_a_real_update`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src-tauri/src/commands/correlation.rs apps/devbench/src-tauri/src/commands/mod.rs
git commit -m "feat: add correlation diff algorithm, tested for insert/update/delete"
```

---

### Task 10: `run_correlated_request` — orchestrate snapshot → request → snapshot → diff

**Files:**
- Modify: `apps/devbench/src-tauri/src/commands/correlation.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `commands::request::fire_request_impl` (Task 4), `commands::db::{DbConnectInput, connection_string}` (Task 8), `commands::history::save_history_entry`-equivalent logic (this task writes history directly, matching Task 6's schema).
- Produces: Tauri command `run_correlated_request(request: FireRequestInput, connection: DbConnectInput, watched_tables: Vec<String>) -> Result<CorrelationResult, String>` where `CorrelationResult { response: FireRequestOutput, table_diffs: Vec<TableDiff> }`. Task 11 (Rollup component) and Task 12 (frontend wiring) both consume `CorrelationResult` exactly as named here — `table_diffs`, not `diffs` or `tables`.

- [ ] **Step 1: Write the failing integration test**

Append to `apps/devbench/src-tauri/src/commands/correlation.rs`, above the existing `#[cfg(test)]` block's closing brace (add as new top-level items, not inside the test module):
```rust
use super::request::{fire_request_impl, FireRequestInput, FireRequestOutput};

#[derive(Debug, Serialize)]
pub struct CorrelationResult {
    pub response: FireRequestOutput,
    pub table_diffs: Vec<TableDiff>,
}

pub async fn run_correlated_request_impl(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
) -> Result<CorrelationResult, String> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(&connection))
        .await
        .map_err(|e| format!("connection failed: {e}"))?;

    let mut before_snapshots = Vec::with_capacity(watched_tables.len());
    for table in &watched_tables {
        let pk_col = get_primary_key_column(&pool, table).await?;
        let snapshot = snapshot_table(&pool, table, &pk_col).await?;
        before_snapshots.push((table.clone(), pk_col, snapshot));
    }

    let response = fire_request_impl(request).await?;

    let mut table_diffs = Vec::with_capacity(watched_tables.len());
    for (table, pk_col, before) in before_snapshots {
        let after = snapshot_table(&pool, &table, &pk_col).await?;
        let diff = diff_table_snapshots(&table, &before, &after);
        if diff.inserted > 0 || diff.updated > 0 || diff.deleted > 0 {
            table_diffs.push(diff);
        }
    }

    Ok(CorrelationResult { response, table_diffs })
}

#[tauri::command]
pub async fn run_correlated_request(
    request: FireRequestInput,
    connection: DbConnectInput,
    watched_tables: Vec<String>,
) -> Result<CorrelationResult, String> {
    run_correlated_request_impl(request, connection, watched_tables).await
}
```

Add to the existing `#[cfg(test)] mod tests` block:
```rust
    #[tokio::test]
    async fn run_correlated_request_reports_only_tables_that_actually_changed() {
        let conn = test_connection();
        let pool = PgPoolOptions::new()
            .connect(&connection_string(&conn))
            .await
            .expect("requires a real local Postgres");

        sqlx::query("DROP TABLE IF EXISTS orders_e2e").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE IF EXISTS untouched_e2e").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE orders_e2e (id serial PRIMARY KEY, status text)")
            .execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE untouched_e2e (id serial PRIMARY KEY)")
            .execute(&pool).await.unwrap();

        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/orders")
            .with_status(201)
            .with_body(r#"{"id":1}"#)
            .create_async()
            .await;
        // The mocked endpoint doesn't actually touch Postgres, so simulate the
        // side effect a real backend would cause by writing directly here —
        // this test asserts the orchestration + diff, not a real backend.
        sqlx::query("INSERT INTO orders_e2e (status) VALUES ('pending')")
            .execute(&pool).await.unwrap();

        let result = run_correlated_request_impl(
            FireRequestInput {
                method: "POST".to_string(),
                url: format!("{}/orders", server.url()),
                body: None,
            },
            conn,
            vec!["orders_e2e".to_string(), "untouched_e2e".to_string()],
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(result.response.status_code, 201);
        assert_eq!(result.table_diffs.len(), 1);
        assert_eq!(result.table_diffs[0].table, "orders_e2e");
        assert_eq!(result.table_diffs[0].inserted, 1);

        sqlx::query("DROP TABLE orders_e2e").execute(&pool).await.unwrap();
        sqlx::query("DROP TABLE untouched_e2e").execute(&pool).await.unwrap();
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/devbench/src-tauri && cargo test run_correlated_request_reports_only_tables`
Expected: FAIL — `fire_request_impl`/`FireRequestInput`/`FireRequestOutput` aren't `pub` from `request.rs` yet in a form `correlation.rs` can import (they are already `pub` per Task 4 — this step should actually compile; if it doesn't, the likely cause is `FireRequestOutput` missing `Clone`/fields visibility, already handled in Task 4's definition). Confirm the specific compiler error before changing anything.

Note: given Task 4 already made these `pub`, this test is expected to fail only on the *assertion* (or pass immediately) rather than a compile error — run it first and read the actual failure before assuming what's broken.

- [ ] **Step 3: Fix any compile errors surfaced, then re-run**

Run: `cd apps/devbench/src-tauri && cargo test run_correlated_request_reports_only_tables`
Expected: PASS

- [ ] **Step 4: Register the new command**

Modify `apps/devbench/src-tauri/src/main.rs`, add to `generate_handler!`:
```rust
commands::correlation::run_correlated_request,
```

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri
git commit -m "feat: add run_correlated_request orchestration command"
```

---

### Task 11: Rollup component

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Create: `apps/devbench/src/components/rollup/Rollup.tsx`
- Create: `apps/devbench/src/components/rollup/Rollup.test.tsx`

**Interfaces:**
- Consumes: `CorrelationResult`/`TableDiff` shape from Task 10, mirrored here as TypeScript types.
- Produces: `<Rollup diffs={TableDiff[]} loading={boolean} onTableClick={(table: string) => void} />`. Task 12 wires this to real data and to the DB tab switch.

- [ ] **Step 1: Add types**

Modify `apps/devbench/src/lib/tauri.ts`, append:
```ts
export interface TableDiff {
  table: string;
  inserted: number;
  updated: number;
  deleted: number;
}

export interface CorrelationResult {
  response: FireRequestOutput;
  table_diffs: TableDiff[];
}

export interface DbConnectInput {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export function invokeRunCorrelatedRequest(args: {
  request: FireRequestInput;
  connection: DbConnectInput;
  watchedTables: string[];
}): Promise<CorrelationResult> {
  return invoke("run_correlated_request", {
    request: args.request,
    connection: args.connection,
    watchedTables: args.watchedTables,
  });
}
```

- [ ] **Step 2: Write the failing test**

`apps/devbench/src/components/rollup/Rollup.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Rollup } from "./Rollup";

describe("Rollup", () => {
  it("shows a loading skeleton", () => {
    render(<Rollup diffs={[]} loading onTableClick={() => {}} />);
    expect(screen.getByTestId("rollup-loading")).toBeInTheDocument();
  });

  it("shows a zero-effects message when nothing changed", () => {
    render(<Rollup diffs={[]} loading={false} onTableClick={() => {}} />);
    expect(screen.getByText(/no observed effects/i)).toBeInTheDocument();
  });

  it("lists each changed table and calls onTableClick", () => {
    const onTableClick = vi.fn();
    render(
      <Rollup
        diffs={[{ table: "orders", inserted: 1, updated: 0, deleted: 0 }]}
        loading={false}
        onTableClick={onTableClick}
      />,
    );
    const item = screen.getByRole("button", { name: /orders/i });
    expect(item).toHaveTextContent("1 inserted");
    fireEvent.click(item);
    expect(onTableClick).toHaveBeenCalledWith("orders");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- Rollup.test.tsx`
Expected: FAIL — `./Rollup` doesn't exist.

- [ ] **Step 4: Implement Rollup**

`apps/devbench/src/components/rollup/Rollup.tsx`:
```tsx
import type { TableDiff } from "../../lib/tauri";

function summarize(diff: TableDiff): string {
  const parts: string[] = [];
  if (diff.inserted > 0) parts.push(`${diff.inserted} inserted`);
  if (diff.updated > 0) parts.push(`${diff.updated} updated`);
  if (diff.deleted > 0) parts.push(`${diff.deleted} deleted`);
  return parts.join(", ");
}

export function Rollup({
  diffs,
  loading,
  onTableClick,
}: {
  diffs: TableDiff[];
  loading: boolean;
  onTableClick: (table: string) => void;
}) {
  if (loading) {
    return (
      <div data-testid="rollup-loading" className="flex gap-4.5 p-3">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  if (diffs.length === 0) {
    return (
      <div className="p-3 text-text-faint">
        No observed effects — nothing in the watched tables changed.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-5 p-3">
      {diffs.map((diff) => (
        <button
          key={diff.table}
          onClick={() => onTableClick(diff.table)}
          className="flex items-center gap-1.5 font-semibold text-text hover:text-accent"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-text-faint" />
          {diff.table} <span className="font-normal text-text-muted">{summarize(diff)}</span>
          <span className="font-bold text-accent">→</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- Rollup.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/lib apps/devbench/src/components/rollup
git commit -m "feat: add Rollup component with loading/zero/populated states"
```

---

### Task 12: SchemaTree + DataGrid (DB tab, Browse mode)

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Create: `apps/devbench/src/components/db/SchemaTree.tsx`
- Create: `apps/devbench/src/components/db/SchemaTree.test.tsx`
- Create: `apps/devbench/src/components/db/DataGrid.tsx`
- Create: `apps/devbench/src/components/db/DataGrid.test.tsx`
- Create: `apps/devbench/src/components/db/DbTab.tsx`

**Interfaces:**
- Consumes: `db_connect_and_list_tables` (Task 8).
- Produces: `<SchemaTree connection={DbConnectInput} watchedTables={Set<string>} onToggleWatch={(table: string) => void} onSelectTable={(table: string) => void} />` and `<DataGrid columns={string[]} rows={string[][]} />`. Task 13 assembles these into `DbTab` and Task 14 wires watched-table state to the store.

This task adds `list_table_rows` as a small, focused Rust command (Browse mode needs to display current row contents — the correlation engine only needed counts/hashes, not full rows).

- [ ] **Step 1: Add `list_table_rows` Rust command**

Append to `apps/devbench/src-tauri/src/commands/db.rs`:
```rust
#[derive(Debug, Serialize)]
pub struct TableRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

fn cell_to_string(row: &sqlx::postgres::PgRow, index: usize) -> Option<String> {
    use sqlx::Row as _;
    if let Ok(v) = row.try_get::<Option<String>, _>(index) { return v; }
    if let Ok(v) = row.try_get::<Option<i64>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<i32>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<f64>, _>(index) { return v.map(|n| n.to_string()); }
    if let Ok(v) = row.try_get::<Option<bool>, _>(index) { return v.map(|b| b.to_string()); }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(index) { return v.map(|d| d.to_string()); }
    if let Ok(v) = row.try_get::<Option<uuid::Uuid>, _>(index) { return v.map(|u| u.to_string()); }
    None
}

#[tauri::command]
pub async fn list_table_rows(input: DbConnectInput, table: String) -> Result<TableRows, String> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&connection_string(&input))
        .await
        .map_err(|e| format!("connection failed: {e}"))?;

    let sql = format!("SELECT * FROM {table} LIMIT 200");
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("query failed: {e}"))?;

    let columns: Vec<String> = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();

    let out_rows = rows
        .iter()
        .map(|row| (0..columns.len()).map(|i| cell_to_string(row, i)).collect())
        .collect();

    Ok(TableRows { columns, rows: out_rows })
}
```

- [ ] **Step 2: Register the command**

Modify `apps/devbench/src-tauri/src/main.rs`, add to `generate_handler!`:
```rust
commands::db::list_table_rows,
```

- [ ] **Step 3: Frontend types + wrapper**

Modify `apps/devbench/src/lib/tauri.ts`, append:
```ts
export interface TableInfo {
  schema: string;
  name: string;
}

export function invokeDbConnectAndListTables(connection: DbConnectInput): Promise<TableInfo[]> {
  return invoke("db_connect_and_list_tables", { input: connection });
}

export interface TableRows {
  columns: string[];
  rows: (string | null)[][];
}

export function invokeListTableRows(connection: DbConnectInput, table: string): Promise<TableRows> {
  return invoke("list_table_rows", { input: connection, table });
}
```

- [ ] **Step 4: Write the failing DataGrid test**

`apps/devbench/src/components/db/DataGrid.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataGrid } from "./DataGrid";

describe("DataGrid", () => {
  it("renders column headers and row cells", () => {
    render(
      <DataGrid
        columns={["id", "status"]}
        rows={[["8841", "pending"], ["8840", "shipped"]]}
      />,
    );
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("8841")).toBeInTheDocument();
    expect(screen.getByText("shipped")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun run test -- DataGrid.test.tsx`
Expected: FAIL — `./DataGrid` doesn't exist.

- [ ] **Step 6: Implement DataGrid (plain table for this plan — TanStack Table/Virtual upgrade is a follow-up once row counts in real usage justify it, not deferred silently: noted in this plan's own scope, not hidden)**

`apps/devbench/src/components/db/DataGrid.tsx`:
```tsx
export function DataGrid({ columns, rows }: { columns: string[]; rows: (string | null)[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full font-mono text-sm">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="whitespace-nowrap border-b border-border bg-surface-2 px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-text-faint"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-surface-2">
              {row.map((cell, j) => (
                <td key={j} className="whitespace-nowrap border-b border-border px-3 py-1.75 tabular-nums text-text">
                  {cell ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun run test -- DataGrid.test.tsx`
Expected: PASS

- [ ] **Step 8: Write the failing SchemaTree test**

`apps/devbench/src/components/db/SchemaTree.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SchemaTree } from "./SchemaTree";
import * as tauriLib from "../../lib/tauri";

const connection = { host: "localhost", port: 5432, database: "d", username: "u", password: "p" };

describe("SchemaTree", () => {
  it("lists tables and toggles watch state", async () => {
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    const onToggleWatch = vi.fn();

    render(
      <SchemaTree
        connection={connection}
        watchedTables={new Set()}
        onToggleWatch={onToggleWatch}
        onSelectTable={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /watch orders/i }));
    expect(onToggleWatch).toHaveBeenCalledWith("orders");
  });
});
```

- [ ] **Step 9: Run test to verify it fails**

Run: `bun run test -- SchemaTree.test.tsx`
Expected: FAIL — `./SchemaTree` doesn't exist.

- [ ] **Step 10: Implement SchemaTree**

`apps/devbench/src/components/db/SchemaTree.tsx`:
```tsx
import { useEffect, useState } from "react";
import { invokeDbConnectAndListTables, type DbConnectInput, type TableInfo } from "../../lib/tauri";

export function SchemaTree({
  connection,
  watchedTables,
  onToggleWatch,
  onSelectTable,
}: {
  connection: DbConnectInput;
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  onSelectTable: (table: string) => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    invokeDbConnectAndListTables(connection).then(setTables);
  }, [connection]);

  function select(name: string) {
    setSelected(name);
    onSelectTable(name);
  }

  return (
    <aside className="w-50 min-w-50 border-r border-border">
      <div className="border-b border-border p-2.5 text-xs font-bold text-text-muted">
        {connection.database}
      </div>
      <div className="flex flex-col gap-0.5 p-1.5">
        {tables.map((t) => (
          <div
            key={`${t.schema}.${t.name}`}
            onClick={() => select(t.name)}
            className={`flex items-center gap-1.5 rounded-sm p-1.5 ${
              selected === t.name ? "bg-surface-2 text-text" : "text-text-muted"
            }`}
          >
            <button
              aria-label={`watch ${t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleWatch(t.name);
              }}
              className={`h-2.5 w-2.5 flex-shrink-0 rounded-full border ${
                watchedTables.has(t.name) ? "border-text bg-text" : "border-text-faint"
              }`}
            />
            <span>{t.name}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 11: Run test to verify it passes**

Run: `bun run test -- SchemaTree.test.tsx`
Expected: PASS

- [ ] **Step 12: Assemble DbTab**

`apps/devbench/src/components/db/DbTab.tsx`:
```tsx
import { useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid } from "./DataGrid";
import { invokeListTableRows, type DbConnectInput, type TableRows } from "../../lib/tauri";

const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

export function DbTab({
  watchedTables,
  onToggleWatch,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
}) {
  const [tableRows, setTableRows] = useState<TableRows | null>(null);

  async function handleSelectTable(table: string) {
    const rows = await invokeListTableRows(DEV_CONNECTION, table);
    setTableRows(rows);
  }

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connection={DEV_CONNECTION}
        watchedTables={watchedTables}
        onToggleWatch={onToggleWatch}
        onSelectTable={handleSelectTable}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {tableRows ? <DataGrid columns={tableRows.columns} rows={tableRows.rows} /> : null}
      </div>
    </div>
  );
}
```

Note: `DEV_CONNECTION` is hardcoded here deliberately — a real connection-picker UI (saved connections, a connect form) is explicitly out of scope for this plan per its Goal (proving the correlation loop), and is a natural next plan once this one is validated. This is a scoping decision, not a forgotten placeholder — flagged here so it isn't mistaken for one later.

- [ ] **Step 13: Commit**

```bash
git add apps/devbench/src-tauri apps/devbench/src/lib apps/devbench/src/components/db
git commit -m "feat: add SchemaTree and DataGrid, assemble DbTab in Browse mode"
```

---

### Task 13: Wire watched-table state, correlation, and rollup into the API tab end-to-end

**Files:**
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/store/useAppStore.test.ts`
- Modify: `apps/devbench/src/components/api/RequestBuilder.tsx`
- Modify: `apps/devbench/src/components/api/RequestBuilder.test.tsx`
- Modify: `apps/devbench/src/components/api/ApiTab.tsx`
- Modify: `apps/devbench/src/App.tsx`

**Interfaces:**
- Consumes: `invokeRunCorrelatedRequest` (Task 11), `Rollup` (Task 11), `DbTab`'s `watchedTables`/`onToggleWatch` contract (Task 12).
- Produces: the fully wired app — this is the last task before the end-to-end test in Task 14. No new exported interfaces; this task is pure wiring.

- [ ] **Step 1: Add watched-table state to the store**

Modify `apps/devbench/src/store/useAppStore.ts`:
```ts
import { create } from "zustand";

export type TabId = "api" | "db";
export type ThemePref = "dark" | "light" | "system";

interface AppState {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  theme: ThemePref;
  setTheme: (theme: ThemePref) => void;
  watchedTables: Set<string>;
  toggleWatchedTable: (table: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: "api",
  setActiveTab: (tab) => set({ activeTab: tab }),
  theme: "dark",
  setTheme: (theme) => set({ theme }),
  watchedTables: new Set(),
  toggleWatchedTable: (table) =>
    set((state) => {
      const next = new Set(state.watchedTables);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return { watchedTables: next };
    }),
}));
```

Modify `apps/devbench/src/store/useAppStore.test.ts`, append:
```ts
  it("toggleWatchedTable adds and removes a table", () => {
    useAppStore.getState().toggleWatchedTable("orders");
    expect(useAppStore.getState().watchedTables.has("orders")).toBe(true);
    useAppStore.getState().toggleWatchedTable("orders");
    expect(useAppStore.getState().watchedTables.has("orders")).toBe(false);
  });
```

Run: `bun run test -- useAppStore.test.ts`
Expected: PASS

- [ ] **Step 2: Change RequestBuilder to fire correlated requests**

Modify `apps/devbench/src/components/api/RequestBuilder.test.tsx` — replace its single test with:
```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestBuilder } from "./RequestBuilder";
import * as tauriLib from "../../lib/tauri";

const connection = { host: "localhost", port: 5432, database: "d", username: "u", password: "p" };

describe("RequestBuilder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires a correlated request against the watched tables and reports the result", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      response: { status_code: 201, body: '{"id":8841}', duration_ms: 142 },
      table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
    });

    render(
      <RequestBuilder connection={connection} watchedTables={new Set(["orders"])} onResult={onResult} />,
    );
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), {
      target: { value: "/api/orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        response: { status_code: 201, body: '{"id":8841}', duration_ms: 142 },
        table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
      }),
    );
    expect(tauriLib.invokeRunCorrelatedRequest).toHaveBeenCalledWith({
      request: { method: "GET", url: "/api/orders", body: undefined },
      connection,
      watchedTables: ["orders"],
    });
  });
});
```

Run: `bun run test -- RequestBuilder.test.tsx`
Expected: FAIL — `RequestBuilder` doesn't accept `connection`/`watchedTables` props yet, and calls the wrong function.

- [ ] **Step 3: Update RequestBuilder implementation**

`apps/devbench/src/components/api/RequestBuilder.tsx`:
```tsx
import { useState } from "react";
import { invokeRunCorrelatedRequest, type CorrelationResult, type DbConnectInput } from "../../lib/tauri";

export function RequestBuilder({
  connection,
  watchedTables,
  onResult,
}: {
  connection: DbConnectInput;
  watchedTables: Set<string>;
  onResult: (result: CorrelationResult) => void;
}) {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    setSending(true);
    try {
      const result = await invokeRunCorrelatedRequest({
        request: { method, url, body: undefined },
        connection,
        watchedTables: Array.from(watchedTables),
      });
      onResult(result);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex gap-2 rounded-t-lg border border-b-0 border-border bg-surface p-3">
      <select
        value={method}
        onChange={(e) => setMethod(e.target.value)}
        className="rounded-sm border border-border bg-surface-2 px-2.5 py-2 font-bold text-text"
      >
        <option>GET</option>
        <option>POST</option>
        <option>PUT</option>
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
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- RequestBuilder.test.tsx`
Expected: PASS

- [ ] **Step 5: Wire ApiTab: real connection, watched tables from the store, Rollup, and DB-tab deep-link**

Modify `apps/devbench/src/components/api/ApiTab.tsx`:
```tsx
import { useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { HistorySidebar } from "./HistorySidebar";
import { Rollup } from "../rollup/Rollup";
import { useAppStore } from "../../store/useAppStore";
import type { CorrelationResult, DbConnectInput, HistoryEntry } from "../../lib/tauri";

const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

export function ApiTab({ onOpenTableInDb }: { onOpenTableInDb: (table: string) => void }) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const [correlation, setCorrelation] = useState<CorrelationResult | null>(null);
  const [sending, setSending] = useState(false);

  function handleResult(result: CorrelationResult) {
    setSending(false);
    setCorrelation(result);
  }

  function handleHistorySelect(entry: HistoryEntry) {
    setCorrelation({
      response: { status_code: entry.status_code, body: entry.response_body, duration_ms: entry.duration_ms },
      table_diffs: [],
    });
  }

  function handleTableClick(table: string) {
    setActiveTab("db");
    onOpenTableInDb(table);
  }

  return (
    <div className="-m-6 flex h-full">
      <HistorySidebar onSelect={handleHistorySelect} />
      <div className="mx-auto flex max-w-180 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <RequestBuilder
          connection={DEV_CONNECTION}
          watchedTables={watchedTables}
          onResult={(r) => {
            setSending(true);
            handleResult(r);
          }}
        />
        <ResponseViewer result={correlation?.response ?? null} />
        {correlation ? (
          <div>
            <div className="m-0.5 text-[11.5px] font-bold uppercase tracking-wide text-text-faint">
              What happened
            </div>
            <div className="rounded-lg border border-border bg-surface">
              <Rollup diffs={correlation.table_diffs} loading={sending} onTableClick={handleTableClick} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire App.tsx: DbTab, watched-table toggling, and the rollup deep-link target**

Modify `apps/devbench/src/App.tsx`:
```tsx
import { useState } from "react";
import { useAppStore } from "./store/useAppStore";
import { ApiTab } from "./components/api/ApiTab";
import { DbTab } from "./components/db/DbTab";

export default function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);
  const [dbFocusTable, setDbFocusTable] = useState<string | null>(null);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-13 items-center gap-4 border-b border-border px-4">
        <span className="font-bold text-text">DevBench</span>
        <nav className="flex gap-1" aria-label="DevBench sections">
          <button
            role="tab"
            aria-selected={activeTab === "api"}
            className={`rounded-sm px-3 py-2 text-sm font-medium ${
              activeTab === "api" ? "bg-surface-2 text-text" : "text-text-muted"
            }`}
            onClick={() => setActiveTab("api")}
          >
            API
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "db"}
            className={`rounded-sm px-3 py-2 text-sm font-medium ${
              activeTab === "db" ? "bg-surface-2 text-text" : "text-text-muted"
            }`}
            onClick={() => setActiveTab("db")}
          >
            DB
          </button>
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        {activeTab === "api" ? (
          <ApiTab onOpenTableInDb={setDbFocusTable} />
        ) : (
          <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 7: Accept `focusTable` in DbTab to complete the deep-link**

Modify `apps/devbench/src/components/db/DbTab.tsx` — change the function signature and add an effect:
```tsx
import { useEffect, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid } from "./DataGrid";
import { invokeListTableRows, type DbConnectInput, type TableRows } from "../../lib/tauri";

const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

export function DbTab({
  watchedTables,
  onToggleWatch,
  focusTable,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  focusTable: string | null;
}) {
  const [tableRows, setTableRows] = useState<TableRows | null>(null);

  async function handleSelectTable(table: string) {
    const rows = await invokeListTableRows(DEV_CONNECTION, table);
    setTableRows(rows);
  }

  useEffect(() => {
    if (focusTable) handleSelectTable(focusTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTable]);

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connection={DEV_CONNECTION}
        watchedTables={watchedTables}
        onToggleWatch={onToggleWatch}
        onSelectTable={handleSelectTable}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {tableRows ? <DataGrid columns={tableRows.columns} rows={tableRows.rows} /> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run the full frontend test suite**

Run: `bun run test`
Expected: PASS across all files (adjust any test broken by the prop-signature changes in this task — `ApiTab`/`DbTab` don't have their own dedicated test files yet, so no other files should need edits).

- [ ] **Step 9: Commit**

```bash
git add apps/devbench/src
git commit -m "feat: wire correlated requests, rollup, and DB deep-link end-to-end"
```

---

### Task 14: End-to-end smoke test

**Files:**
- Create: `apps/devbench/src-tauri/tests/smoke_test.rs`

**Interfaces:**
- Consumes: `commands::correlation::run_correlated_request_impl` (Task 10). No new interfaces produced — this is the plan's final verification, matching the v1 spec's Testing section requirement verbatim ("fire a request against a seeded local Postgres... assert the rollup shows the expected diff").

- [ ] **Step 1: Write the smoke test**

`apps/devbench/src-tauri/tests/smoke_test.rs`:
```rust
use devbench::commands::correlation::run_correlated_request_impl;
use devbench::commands::db::DbConnectInput;
use devbench::commands::request::FireRequestInput;
use sqlx::postgres::PgPoolOptions;

fn test_connection() -> DbConnectInput {
    DbConnectInput {
        host: std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into()),
        port: 5432,
        database: std::env::var("PGDATABASE").unwrap_or_else(|_| "devbench_test".into()),
        username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
        password: std::env::var("PGPASSWORD").unwrap_or_else(|_| "postgres".into()),
    }
}

#[tokio::test]
async fn firing_a_request_against_a_seeded_postgres_produces_the_expected_rollup() {
    let conn = test_connection();
    let pool = PgPoolOptions::new()
        .connect(&format!(
            "postgres://{}:{}@{}:{}/{}",
            conn.username, conn.password, conn.host, conn.port, conn.database
        ))
        .await
        .expect("requires a real local Postgres");

    sqlx::query("DROP TABLE IF EXISTS smoke_orders").execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE smoke_orders (id serial PRIMARY KEY, status text)")
        .execute(&pool)
        .await
        .unwrap();

    let mut server = mockito::Server::new_async().await;
    server
        .mock("POST", "/orders")
        .with_status(201)
        .with_body(r#"{"id":1}"#)
        .create_async()
        .await;
    sqlx::query("INSERT INTO smoke_orders (status) VALUES ('pending')")
        .execute(&pool)
        .await
        .unwrap();

    let result = run_correlated_request_impl(
        FireRequestInput {
            method: "POST".to_string(),
            url: format!("{}/orders", server.url()),
            body: None,
        },
        conn,
        vec!["smoke_orders".to_string()],
    )
    .await
    .expect("correlated request should succeed");

    assert_eq!(result.response.status_code, 201);
    assert_eq!(result.table_diffs.len(), 1);
    assert_eq!(result.table_diffs[0].table, "smoke_orders");
    assert_eq!(result.table_diffs[0].inserted, 1);

    sqlx::query("DROP TABLE smoke_orders").execute(&pool).await.unwrap();
}
```

- [ ] **Step 2: Expose a library target so the integration test can import `devbench::commands`**

Create `apps/devbench/src-tauri/src/lib.rs`:
```rust
pub mod commands;
pub mod local_db;
```

Modify `apps/devbench/src-tauri/Cargo.toml`, add:
```toml
[lib]
name = "devbench"
path = "src/lib.rs"
```

Modify `apps/devbench/src-tauri/src/main.rs` — replace `mod commands;` / `mod local_db;` with:
```rust
use devbench::commands;
use devbench::local_db::LocalDb;
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `cd apps/devbench/src-tauri && cargo test --test smoke_test`
Expected: first run surfaces any wiring issues from Step 2 (fix compile errors if the crate name/module paths don't match — `devbench` matches the `[lib] name` set above); once compiling, expect PASS.

- [ ] **Step 4: Run the entire backend suite together as a final check**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS — every test from Tasks 4, 6, 8, 9, 10, and this task's smoke test, all green together.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri
git commit -m "test: add end-to-end smoke test for the correlated-request core loop"
```

---

## Self-Review

**Spec coverage:** API tab (request builder, response, history) — Tasks 4–7, 13. DB tab Browse mode + watched-table toggles — Tasks 8, 9, 12, 13. Correlation engine (before/after diff) — Tasks 9, 10. Rollup UI with deep-link — Tasks 11, 13. Local SQLite storage — Task 6. Testing requirement ("run against a real local Postgres in CI, not a mock") — Tasks 8, 9, 10, 14 all do this. Explicitly and deliberately **not** covered here, reserved for later plans per the phasing decision: DB Query mode's full SQL editor, Log tab, Email tab, Sessions/Archive, Split view, Settings (General/Provider/MCP/Archive), Chat dock/BYOK, connection-picker UI (DEV_CONNECTION is hardcoded — flagged inline in Task 12).

**Placeholder scan:** no TBD/TODO markers; every step has real code; no "add appropriate error handling" phrasing — every `Result` in this plan is mapped to a real `format!(...)` error string.

**Type consistency:** `TableDiff { table, inserted, updated, deleted }` is defined once in Task 9 and used identically (never renamed to `diffs` or restructured) through Tasks 10, 11, 13. `CorrelationResult { response, table_diffs }` is defined in Task 10 and consumed with those exact field names in Tasks 11 and 13. `FireRequestOutput` is defined in Task 4 and never redefined. `DbConnectInput` is defined once in Task 8 (Rust) and mirrored once in `lib/tauri.ts` (Task 11) — no second, drifted definition.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-30-devbench-v1-core-loop.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
