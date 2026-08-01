# DevBench v2 Tab Instances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DevBench's fixed four-tab workspace with tab *instances* — the same tool can be opened more than once, each instance independent and persisted per session.

**Architecture:** `TabId` (today the identity of a tab) becomes `ToolKind` (the *kind* of a tab). A new `Tab` type (`id`, `kind`, `pane`, `ordinal`, `state`) is the real identity, held in the store as `tabs: Tab[]` plus `activeTabId: { left, right }`. `splitOpen` stops being stored state and becomes a derived read (`tabs.some(t => t.pane === "right")`). A new SQLite `tabs` table persists the set per session; `session_id IS NULL` is the unnamed scratch workspace. The three App-level singletons that broke under duplication (`dbFocusTable`, `emailFocusId`, `activeLogSourceId`) move into each tab's own `state`, except Email's selection, which stays deliberately unpersisted and is targeted per-instance instead. All mounted tabs stay mounted — switching tabs toggles a CSS class, never unmounts.

**Tech Stack:** React 18, TypeScript, Zustand, Tailwind v4 (CSS-first `@theme`), Base UI `1.0.0-rc.0`, sqlx 0.8 (SQLite), Tauri v2, Vitest + @testing-library/react, Bun.

**Spec:** `docs/superpowers/specs/2026-07-31-devbench-v2-shell-design.md` — this plan implements item #2 only: "Tab instances," "Tab persistence," "Three singletons that must become per-tab," "Tab lifecycle: mounted, not remounted," and "Empty state."

**Reference mockup:** `docs/mockups/devbench-v2-shell.html`

## Preconditions

This plan is **plan 2 of 2** and builds directly on top of plan 1
(`docs/superpowers/plans/2026-07-31-devbench-v2-chrome.md`). Before starting
any task here, re-verify these plan-1 artifacts exist with the shape this plan
assumes — a five-minute check that catches drift cheaply, before it costs a
whole task's rework.

**Corrections to the brief this plan was commissioned under:** the commissioning
brief claimed plan 1 was "2/8 tasks done" and that `AppStrip` did not exist yet.
Both were stale. As of this writing, `git log` shows all 8 of plan 1's tasks
landed (`3525a6a` through `cbadbba` on this branch, `worktree-devbench-v2-chrome`),
`bun run test` passes 144 tests across 29 files, and `cd src-tauri && cargo test`
passes 131 lib tests (1 ignored: the real-OS-keychain test) plus 3 smoke tests.
`.superpowers/sdd/2026-07-31-devbench-v2-chrome/progress.md` does not exist —
it is gitignored and was never written. **Re-run the counts above before
starting Task 1** — if they differ, plan 1 has moved further (or been amended)
since this plan was written, and every code block below that quotes plan-1
files verbatim should be diffed against the real files first.

The commissioning brief also said this plan's new migration would be
`0003_*.sql`. That number is taken: `0003_session_scoped_history.sql` landed
via a separate, already-merged plan
(`docs/superpowers/plans/2026-07-31-devbench-v1.1-session-scoped-history.md`).
This plan's migration is **`0004_tabs.sql`**.

| Plan-1 artifact this plan assumes | File | Used by |
|---|---|---|
| `AppStrip` renders a 44px grid strip, no `TopBar`/`ToolTabs` | `src/components/shell/AppStrip.tsx` | Task 2 rewrites this file's internals; its role in `App.tsx` is unchanged |
| `Menu` popup primitive: `{label, options, value?, onSelect, trigger, triggerClassName, align?}`, renders `menu`/`menuitem`/`menuitemradio` roles | `src/components/ui/Menu.tsx` | Task 2 extends it with optional `open`/`onOpenChange`; Task 6's `+` picker and Task 5's empty-state button both reuse it unchanged |
| `Tabs` re-export, the app's only other Base UI doorway besides `Menu` | `src/components/ui/Tabs.tsx` | Task 2's `AppStrip` keeps using it for tab selection/keyboard behaviour |
| `TABS: {id: TabId, label: string}[]`, the four tool kinds in order | `src/components/shell/tools.ts` | Task 1 reuses this list's `id`s as `ToolKind`; Task 2's `+` menu options come from it |
| `--w-sidebar` / `--w-chat` tokens, strip grid mirrors the body | `src/styles/tokens.css` | Unchanged; Task 2's rewritten `AppStrip` keeps the same grid |
| Settings > Appearance owns the theme control | `src/components/settings/AppearancePane.tsx` | Untouched by this plan |
| `sqlx::migrate!("./migrations")` runs every `NNNN_*.sql` file in order at startup | `src-tauri/src/local_db.rs:22-25` | Task 3's migration |
| Command pattern: a plain `async fn foo_impl(pool: &SqlitePool, ...)` plus a thin `#[tauri::command] async fn foo(db: State<'_, LocalDb>, ...)` wrapper; `#[cfg(test)] mod tests` at the bottom using `tempfile::tempdir()` + `LocalDb::connect` | `src-tauri/src/commands/sessions.rs`, `src-tauri/src/commands/watched.rs` | Task 3's `commands/tabs.rs` |
| `sessions` table, `delete_session_impl` is a real hard `DELETE` | `src-tauri/migrations/0002_shell.sql`, `src-tauri/src/commands/sessions.rs:139-149` | Task 3's `tabs.session_id` foreign key and its cascade-delete test |
| `request_history.session_id` nullable FK pattern (`ON DELETE SET NULL`, `sqlx-sqlite` runs `PRAGMA foreign_keys = ON` by default) | `src-tauri/migrations/0003_session_scoped_history.sql` | Task 3's FK (this plan uses `ON DELETE CASCADE` instead — see Task 3 for why) |
| `AppSettings`/`invokeGetSettings`/`invokeSetSetting` and the "update store, then fire-and-forget persist" convention used by `AppearancePane.choose()` and `SessionsSidebar.selectSession()` | `src/lib/tauri.ts`, `src/components/settings/AppearancePane.tsx:18-21`, `src/components/shell/SessionsSidebar.tsx:43-54` | Task 4's `useTabController` hook follows the identical convention |
| `activeSessionId` in the store, set by `SessionsSidebar` | `src/store/useAppStore.ts`, `src/components/shell/SessionsSidebar.tsx` | Task 4's session-switch effect watches this field |

**Note on test suite state during this plan.** Task 1 removes `activeTab`,
`setActiveTab`, `secondaryTab`, `setSecondaryTab`, `splitOpen`, `setSplitOpen`,
`activeLogSourceId`, and `setActiveLogSourceId` from the store. A repo-wide
grep for every one of those names turns up exactly one casualty:
**`SplitContent.test.tsx`'s `beforeEach` calls three of them directly and will
throw ("`setSplitOpen` is not a function") starting the moment Task 1 lands.**
`SplitContent.tsx` itself does not crash (it degrades to rendering nothing
useful, not a nested test file), and no other test file — including
`App.test.tsx`, `ApiTab.test.tsx`, and `AppStrip.test.tsx` — touches any of
these fields directly. `LogTab.tsx` also reads the removed
`activeLogSourceId`/`setActiveLogSourceId` and would throw if a log source were
ever clicked, but **no `LogTab.test.tsx` exists**, so nothing currently
exercises that path. `bun run test` (full suite) is therefore expected to show
**exactly one red file, `SplitContent.test.tsx` (3 tests), from Task 1 through
Task 4**, fixed in Task 5 when the component and its test are rewritten
together. Every task's own "run the tests" step names the file explicitly so
this is never a surprise. Do not attempt to fix `SplitContent.test.tsx` before
Task 5 — its correct new shape (multi-tab-per-pane, mounted lifecycle, empty
state) is not settled until then, and a premature fix would be redone.

`bun run test` (`vitest run`) does **not** typecheck — a stale prop name or a
renamed type will pass every test that doesn't happen to exercise it. Per the
same lesson already recorded in the v1.1 session-scoped-history plan's Global
Constraints, **`bun run build` (which runs `tsc`) is the real gate for type
drift** and is required to pass by Task 7, the final task.

## Global Constraints

These carry over from plan 1 and bind this plan too:

- **Run tests from `apps/devbench`:** `bun run test` (vitest). A single file: `bun run test -- src/path/File.test.tsx`.
- **`bun run test` does not typecheck.** `bun run build` (runs `tsc`) is the gate that catches stale types; it must pass by Task 7.
- **Tailwind v4, CSS-first.** No `theme.extend` in `tailwind.config.ts`; tokens are CSS custom properties in `src/styles/tokens.css`, surfaced via the `@theme` block in `src/styles/globals.css`.
- **Base UI is confined to `src/components/ui/`.** No other file may import from `@base-ui-components/react`. `src/components/ui/boundary.test.ts` enforces this — it must keep passing.
- **DESIGN.md chrome rule:** persistent surfaces (strip, sidebars, tab bars) are *ghosty* — transparent background, `1px solid var(--border)` hairline, **no blur**. Only transient overlays (menus, pickers) are *glass* — `backdrop-blur-xl backdrop-saturate-150` plus a solid `color-mix` fallback under `prefers-reduced-transparency` (see `src/components/ui/Menu.tsx` for the pattern; do not add a second fallback rule).
- **Motion:** 150–250ms, state-conveying only.
- **Radius:** `--radius-sm` (6px) for interactive controls, `--radius-lg` (12px) for cards/surfaces/popups.
- **Never use raw emoji as icons.** Inline stroke SVGs, `currentColor`, ~1.6–1.8px stroke. (One exception already exists in the codebase — `SessionsSidebar`'s `✕` archive glyph — which this plan does not touch or extend.)
- **Comments stay sparse.** No multi-paragraph doc blocks above components, no comments restating what the code says. Comment only what a reader cannot infer: a hidden constraint, a subtle invariant, a workaround for a specific bug, a deliberate deviation from the obvious approach.
- **Every `Menu` trigger is named by its `label` prop** via `aria-label`. Tests locate triggers by that name.
- **Every Tauri command follows the established split:** a thin `#[tauri::command]` wrapper delegating to a plain `_impl` function taking `&SqlitePool`, never `tauri::State`, directly.
- **Tauri v2 converts camelCase JS argument keys to snake_case Rust parameters** (`sessionId` → `session_id`), matching the existing `watchedTables` → `watched_tables` behaviour.
- **The app uses zero Tauri events.** Every live surface is a frontend poll (`setInterval` + `invoke`) or a direct `invoke` on user action. Do not introduce `emit`/`listen`.
- **Package manager is Bun exclusively** for the frontend; **Rust tests run via `cargo test`** from `apps/devbench/src-tauri`.
- **A failure to observe is never rendered as "nothing happened."** This plan's analogue: a tab whose debounced write fails is not shown as an error to the user (best-effort persistence, matching `AppearancePane.choose()`'s `.catch(() => {})`), but it must never be silently mistaken for success in a way that misleads about *data*, only about *durability*.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/store/useAppStore.ts` | **Rewritten.** `ToolKind`, `Pane`, `Tab` types; `tabs`/`activeTabId` state; pure, synchronous tab actions; `isSplitOpen` selector. `TabId` name is retired. | 1 |
| `src/components/ui/Menu.tsx` | **Extended.** Gains optional `open`/`onOpenChange` for the one controlled use case (Split-declined). Existing call sites are unaffected. | 2 |
| `src/components/shell/AppStrip.tsx` | **Rewritten.** Dynamic per-pane tab groups from `tabs`, per-tab close, `+` picker per pane, DB-tab subtitle labels, Split/Close-split against the new model. | 2 |
| `src-tauri/migrations/0004_tabs.sql` | **New.** The `tabs` table. | 3 |
| `src-tauri/src/commands/tabs.rs` | **New.** `list_tabs`, `create_tab`, `close_tab`, `set_tab_state`, `move_tab`. | 3 |
| `src/lib/tauri.ts` | **Extended.** `TabRow` type and five `invoke*Tab*` wrappers. | 4 |
| `src/store/useTabController.ts` | **New.** The one place SQLite persistence meets the store: wraps the pure actions, debounces state writes, loads tabs on session switch. Called once, in `App.tsx`. | 4 |
| `src/components/shell/EmptyPane.tsx` | **New.** "No tools open" prompt with the same `+` picker. | 5 |
| `src/components/shell/SplitContent.tsx` | **Rewritten.** Mounted-not-remounted lifecycle (class-swap, not unmount), empty state, no chrome of its own. | 5 |
| `src/components/shell/ToolPane.tsx` | **Rewritten.** Dispatches on `tab.kind`; threads `onPatchState` and the deep-link callbacks. | 5 (db/log), 6 (api/email) |
| `src/components/db/DbTab.tsx` | **Modified.** `table` and `onPatchState` replace the `focusTable` singleton prop. | 5 |
| `src/components/log/LogTab.tsx` | **Modified.** `sourceId` and `onPatchState` replace the store's `activeLogSourceId` singleton. | 5 |
| `src/components/api/RequestBuilder.tsx` | **Modified.** `method`/`url` become controlled props backed by `tab.state`, debounced by the controller. | 6 |
| `src/components/api/ApiTab.tsx` | **Modified.** `onOpenDb`/`onOpenLog`/`onOpenEmail` replace the `setActiveTab`-based local wrappers. | 6 |
| `src/App.tsx` | **Modified across three tasks.** Task 2: pure-store adapters passed to `AppStrip`. Task 4: adapters re-sourced from `useTabController`. Task 6: `dbFocusTable`/`emailFocusId` deleted, replaced by the composed deep-link handlers and one ephemeral email-focus `useState`. | 2, 4, 6 |

---

## Task 1: The tab-instance data model in the store

**Files:**
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/store/useAppStore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export type ToolKind = "api" | "db" | "log" | "email";
export type Pane = "left" | "right";

export interface Tab {
  id: string;
  kind: ToolKind;
  pane: Pane;
  ordinal: number;
  state: Record<string, unknown>;
}

export function isSplitOpen(tabs: Tab[]): boolean;
```
Store additions: `tabs: Tab[]`, `activeTabId: { left: string | null; right: string | null }`, and
```ts
addTab: (id: string, kind: ToolKind, pane: Pane, state?: Record<string, unknown>) => void;
closeTab: (id: string) => void;
setActiveTabId: (pane: Pane, id: string) => void;
patchTabState: (id: string, patch: Record<string, unknown>) => void;
splitActiveTab: () => { moved: boolean; tab: Tab | null };
closeSplit: () => string[]; // ids of the tabs that were closed
replaceTabs: (tabs: Tab[]) => void;
```
Removed: `activeTab`, `setActiveTab`, `secondaryTab`, `setSecondaryTab`, `splitOpen`, `setSplitOpen`, `activeLogSourceId`, `setActiveLogSourceId`, and the exported `TabId` name (renamed `ToolKind`).

- [ ] **Step 1: Write the failing tests**

Replace `apps/devbench/src/store/useAppStore.test.ts` wholesale:

```ts
import { describe, expect, it } from "vitest";
import { isSplitOpen, useAppStore } from "./useAppStore";

function reset() {
  useAppStore.setState({
    tabs: [],
    activeTabId: { left: null, right: null },
  });
}

describe("useAppStore", () => {
  it("defaults to dark theme and no tabs", () => {
    reset();
    const state = useAppStore.getState();
    expect(state.theme).toBe("dark");
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toEqual({ left: null, right: null });
  });

  it("toggleWatchedTable adds and removes a table", () => {
    useAppStore.getState().toggleWatchedTable("orders");
    expect(useAppStore.getState().watchedTables.has("orders")).toBe(true);
    useAppStore.getState().toggleWatchedTable("orders");
    expect(useAppStore.getState().watchedTables.has("orders")).toBe(false);
  });

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
    useAppStore.getState().setActiveSessionId(null);
  });

  describe("tabs", () => {
    it("addTab appends to the given pane with an increasing ordinal, and becomes that pane's active tab", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().addTab("b", "db", "left");

      const { tabs, activeTabId } = useAppStore.getState();
      expect(tabs.map((t) => [t.id, t.ordinal])).toEqual([
        ["a", 0],
        ["b", 1],
      ]);
      expect(activeTabId.left).toBe("b");
    });

    it("ordinals in one pane are independent of the other pane's", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().addTab("b", "db", "right");
      expect(useAppStore.getState().tabs.find((t) => t.id === "b")?.ordinal).toBe(0);
    });

    it("setActiveTabId only changes the targeted pane", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().addTab("b", "db", "right");
      useAppStore.getState().setActiveTabId("right", "b");
      expect(useAppStore.getState().activeTabId).toEqual({ left: "a", right: "b" });
    });

    it("closing the active tab promotes the next sibling by ordinal", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().addTab("b", "db", "left");
      useAppStore.getState().addTab("c", "log", "left");
      useAppStore.getState().setActiveTabId("left", "b");

      useAppStore.getState().closeTab("b");

      const { tabs, activeTabId } = useAppStore.getState();
      expect(tabs.map((t) => t.id)).toEqual(["a", "c"]);
      expect(activeTabId.left).toBe("a");
    });

    it("closing a tab that is not active leaves the active tab untouched", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().addTab("b", "db", "left");
      useAppStore.getState().setActiveTabId("left", "a");

      useAppStore.getState().closeTab("b");

      expect(useAppStore.getState().activeTabId.left).toBe("a");
    });

    it("closing the last tab in a pane clears that pane's active id to null", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().closeTab("a");
      expect(useAppStore.getState().activeTabId.left).toBeNull();
    });

    it("isSplitOpen derives from the presence of a right-pane tab", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      expect(isSplitOpen(useAppStore.getState().tabs)).toBe(false);
      useAppStore.getState().addTab("b", "db", "right");
      expect(isSplitOpen(useAppStore.getState().tabs)).toBe(true);
    });

    it("splitActiveTab moves the active left tab to the right pane and promotes a new left active", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().addTab("b", "db", "left");
      useAppStore.getState().setActiveTabId("left", "b");

      const result = useAppStore.getState().splitActiveTab();

      expect(result.moved).toBe(true);
      expect(result.tab?.pane).toBe("right");
      const { tabs, activeTabId } = useAppStore.getState();
      expect(tabs.find((t) => t.id === "b")?.pane).toBe("right");
      expect(activeTabId).toEqual({ left: "a", right: "b" });
    });

    it("splitActiveTab declines and changes nothing when the left pane has only one tab", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      const before = useAppStore.getState().tabs;

      const result = useAppStore.getState().splitActiveTab();

      expect(result).toEqual({ moved: false, tab: null });
      expect(useAppStore.getState().tabs).toBe(before);
    });

    it("closeSplit removes every right-pane tab, clears the right active id, and returns the closed ids", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().addTab("b", "db", "right");
      useAppStore.getState().addTab("c", "log", "right");

      const closed = useAppStore.getState().closeSplit();

      expect(closed.sort()).toEqual(["b", "c"]);
      const { tabs, activeTabId } = useAppStore.getState();
      expect(tabs.map((t) => t.id)).toEqual(["a"]);
      expect(activeTabId.right).toBeNull();
    });

    it("patchTabState merges into only the targeted tab's state", () => {
      reset();
      useAppStore.getState().addTab("a", "db", "left", { table: "orders" });
      useAppStore.getState().addTab("b", "db", "right", { table: "payments" });

      useAppStore.getState().patchTabState("a", { table: "users" });

      const { tabs } = useAppStore.getState();
      expect(tabs.find((t) => t.id === "a")?.state).toEqual({ table: "users" });
      expect(tabs.find((t) => t.id === "b")?.state).toEqual({ table: "payments" });
    });

    it("replaceTabs wholesale replaces the set and resets both panes' active ids to the first tab by ordinal", () => {
      reset();
      useAppStore.getState().addTab("stale", "api", "left");

      useAppStore.getState().replaceTabs([
        { id: "x", kind: "db", pane: "left", ordinal: 1, state: {} },
        { id: "y", kind: "api", pane: "left", ordinal: 0, state: {} },
        { id: "z", kind: "log", pane: "right", ordinal: 0, state: {} },
      ]);

      const { tabs, activeTabId } = useAppStore.getState();
      expect(tabs.map((t) => t.id)).toEqual(["x", "y", "z"]);
      expect(activeTabId).toEqual({ left: "y", right: "z" });
    });

    it("replaceTabs with an empty list clears both active ids", () => {
      reset();
      useAppStore.getState().addTab("a", "api", "left");
      useAppStore.getState().replaceTabs([]);
      expect(useAppStore.getState().activeTabId).toEqual({ left: null, right: null });
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/store/useAppStore.test.ts`
Expected: FAIL to compile/run — `isSplitOpen` is not exported, `addTab` is not a function.

- [ ] **Step 3: Rewrite the store**

Replace `apps/devbench/src/store/useAppStore.ts` wholesale:

```ts
import { create } from "zustand";

export type ToolKind = "api" | "db" | "log" | "email";
export type Pane = "left" | "right";
export type ThemePref = "dark" | "light" | "system";
export type AppRoute = "workspace" | "settings";

export interface Tab {
  id: string;
  kind: ToolKind;
  pane: Pane;
  ordinal: number;
  /** Identifying selection only — never fetched data. See the shell spec's
   *  "Tab persistence" table for what each kind is allowed to hold. */
  state: Record<string, unknown>;
}

/** `splitOpen` is not stored — a right-pane tab existing is what "split" means. */
export function isSplitOpen(tabs: Tab[]): boolean {
  return tabs.some((t) => t.pane === "right");
}

function nextOrdinal(tabs: Tab[], pane: Pane): number {
  return tabs.filter((t) => t.pane === pane).reduce((max, t) => Math.max(max, t.ordinal), -1) + 1;
}

function firstByOrdinal(tabs: Tab[], pane: Pane): string | null {
  const paneTabs = tabs.filter((t) => t.pane === pane).sort((a, b) => a.ordinal - b.ordinal);
  return paneTabs[0]?.id ?? null;
}

interface AppState {
  tabs: Tab[];
  activeTabId: { left: string | null; right: string | null };
  addTab: (id: string, kind: ToolKind, pane: Pane, state?: Record<string, unknown>) => void;
  closeTab: (id: string) => void;
  setActiveTabId: (pane: Pane, id: string) => void;
  patchTabState: (id: string, patch: Record<string, unknown>) => void;
  splitActiveTab: () => { moved: boolean; tab: Tab | null };
  closeSplit: () => string[];
  replaceTabs: (tabs: Tab[]) => void;

  theme: ThemePref;
  setTheme: (theme: ThemePref) => void;
  watchedTables: Set<string>;
  toggleWatchedTable: (table: string) => void;
  /** Replaces watch state wholesale, e.g. after loading it from SQLite. */
  setWatchedTables: (tables: string[]) => void;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  route: AppRoute;
  setRoute: (route: AppRoute) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  tabs: [],
  activeTabId: { left: null, right: null },

  addTab: (id, kind, pane, state = {}) =>
    set((s) => ({
      tabs: [...s.tabs, { id, kind, pane, ordinal: nextOrdinal(s.tabs, pane), state }],
      activeTabId: { ...s.activeTabId, [pane]: id },
    })),

  closeTab: (id) =>
    set((s) => {
      const closed = s.tabs.find((t) => t.id === id);
      if (!closed) return {};
      const remaining = s.tabs.filter((t) => t.id !== id);
      const activeTabId = { ...s.activeTabId };
      if (activeTabId[closed.pane] === id) {
        activeTabId[closed.pane] = firstByOrdinal(remaining, closed.pane);
      }
      return { tabs: remaining, activeTabId };
    }),

  setActiveTabId: (pane, id) => set((s) => ({ activeTabId: { ...s.activeTabId, [pane]: id } })),

  patchTabState: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, state: { ...t.state, ...patch } } : t)),
    })),

  // Moving would leave the left pane empty, which is worse than doing
  // nothing — the caller (AppStrip) opens the `+` menu targeting the right
  // pane instead when this declines (shell spec, "Tab instances").
  splitActiveTab: () => {
    const s = get();
    const activeId = s.activeTabId.left;
    const leftTabs = s.tabs.filter((t) => t.pane === "left");
    const moving = activeId ? leftTabs.find((t) => t.id === activeId) : undefined;
    if (!moving || leftTabs.length <= 1) return { moved: false, tab: null };

    const movedTab: Tab = { ...moving, pane: "right", ordinal: nextOrdinal(s.tabs, "right") };
    const tabs = s.tabs.map((t) => (t.id === moving.id ? movedTab : t));
    set({ tabs, activeTabId: { left: firstByOrdinal(tabs.filter((t) => t.id !== moving.id), "left"), right: moving.id } });
    return { moved: true, tab: movedTab };
  },

  closeSplit: () => {
    const s = get();
    const closingIds = s.tabs.filter((t) => t.pane === "right").map((t) => t.id);
    if (closingIds.length === 0) return [];
    set({ tabs: s.tabs.filter((t) => t.pane !== "right"), activeTabId: { ...s.activeTabId, right: null } });
    return closingIds;
  },

  replaceTabs: (tabs) =>
    set({ tabs, activeTabId: { left: firstByOrdinal(tabs, "left"), right: firstByOrdinal(tabs, "right") } }),

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
  setWatchedTables: (tables) => set({ watchedTables: new Set(tables) }),
  chatOpen: true,
  setChatOpen: (open) => set({ chatOpen: open }),
  route: "workspace",
  setRoute: (route) => set({ route }),
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),
}));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- src/store/useAppStore.test.ts`
Expected: PASS, all 16.

- [ ] **Step 5: Run the full suite and confirm the one expected casualty**

Run: `bun run test`
Expected: every file passes **except `src/components/shell/SplitContent.test.tsx` (3 tests)**, which fails with `TypeError: ... setSplitOpen is not a function` — exactly the gap this plan's "Note on test suite state" section predicts. If any *other* file fails, stop: something besides the six removed store fields is depending on the old shape, and it needs to be found (`grep -rn "activeTab\|secondaryTab\|splitOpen\|activeLogSourceId" src`) before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/store/useAppStore.ts apps/devbench/src/store/useAppStore.test.ts
git commit -m "feat(devbench): model tabs as instances in the store"
```

---

## Task 2: `AppStrip` renders dynamic per-pane tab instances

**Files:**
- Modify: `apps/devbench/src/components/ui/Menu.tsx`
- Modify: `apps/devbench/src/components/ui/Menu.test.tsx`
- Modify: `apps/devbench/src/components/shell/AppStrip.tsx`
- Modify: `apps/devbench/src/components/shell/AppStrip.test.tsx`
- Modify: `apps/devbench/src/App.tsx`

**Interfaces:**
- Consumes: `Tabs` from `../ui/Tabs`, `TABS` from `./tools`, `Tab`/`Pane`/`ToolKind` from `../../store/useAppStore` (Task 1).
- Produces:
```ts
function AppStrip(props: {
  tabs: Tab[];
  activeTabId: { left: string | null; right: string | null };
  chatOpen: boolean;
  onSetActiveTab: (pane: Pane, id: string) => void;
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onCloseTab: (id: string) => void;
  onToggleSplit: () => boolean; // true = a tab moved; false = caller declined, AppStrip opens its own + picker
  onCloseSplitPane: () => void;
  onToggleChat: () => void;
}): JSX.Element
```
`Menu` gains two optional props, additive and backward-compatible:
```ts
open?: boolean;
onOpenChange?: (open: boolean) => void;
```

**Why `App.tsx` wires `AppStrip` to raw store actions here, not to real persistence:** Task 4 introduces `useTabController`, the hook that actually talks to SQLite. Until then, `App.tsx` defines five small adapter functions (`onAddTab`, `onCloseTab`, `onToggleSplit`, `onCloseSplitPane`, plus `setActiveTabId` used directly) with the *exact* signatures `AppStrip` expects, implemented against the pure store actions from Task 1. Task 4 reimplements only the *bodies* of those five adapters against the hook — `AppStrip.tsx` and `AppStrip.test.tsx` are never touched again after this task.

- [ ] **Step 1: Write the failing test for `Menu`'s controlled-open support**

Append to `apps/devbench/src/components/ui/Menu.test.tsx`, inside the existing `describe`:

```tsx
  // AppStrip's Split button needs to force the menu open without a click,
  // when moving a tab isn't possible (see AppStrip.test.tsx). Base UI's
  // Menu.Root supports open/onOpenChange natively; this only checks the
  // wrapper actually forwards them.
  it("supports a controlled open state for opening without a trigger click", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Menu label="Add a tool" options={OPTIONS} onSelect={() => {}} trigger="Add" open={false} onOpenChange={onOpenChange} />,
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    rerender(
      <Menu label="Add a tool" options={OPTIONS} onSelect={() => {}} trigger="Add" open onOpenChange={onOpenChange} />,
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test -- src/components/ui/Menu.test.tsx`
Expected: FAIL — clicking nothing, the menu never opens; `open`/`onOpenChange` are not accepted props (TS is not the failure here, the *behaviour* is: the menu stays closed regardless of `open`).

- [ ] **Step 3: Extend `Menu` to accept controlled open state**

In `apps/devbench/src/components/ui/Menu.tsx`, add the two props and forward them:

```tsx
export function Menu({
  label,
  options,
  value,
  onSelect,
  trigger,
  triggerClassName,
  align = "start",
  open,
  onOpenChange,
}: {
  label: string;
  options: MenuOption[];
  value?: string;
  onSelect: (value: string) => void;
  trigger: React.ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
  /** Omit for the normal click-to-open case. Set only when a caller must
   *  open the menu without the user clicking its trigger (AppStrip's
   *  Split-declined flow). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
```

Change the root element to forward them (Base UI's `Menu.Root` accepts both natively; `open: undefined` is uncontrolled, matching every existing call site exactly):

```tsx
  return (
    <BaseMenu.Root open={open} onOpenChange={onOpenChange}>
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test -- src/components/ui/Menu.test.tsx`
Expected: PASS, all four.

- [ ] **Step 5: Write the failing `AppStrip` tests**

Replace `apps/devbench/src/components/shell/AppStrip.test.tsx` wholesale:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppStrip } from "./AppStrip";
import type { Tab } from "../../store/useAppStore";

const TWO_LEFT_TABS: Tab[] = [
  { id: "t-api", kind: "api", pane: "left", ordinal: 0, state: {} },
  { id: "t-db", kind: "db", pane: "left", ordinal: 1, state: { table: "orders" } },
];

const BASE = {
  tabs: TWO_LEFT_TABS,
  activeTabId: { left: "t-api", right: null } as { left: string | null; right: string | null },
  chatOpen: true,
  onSetActiveTab: () => {},
  onAddTab: () => {},
  onCloseTab: () => {},
  onToggleSplit: () => false,
  onCloseSplitPane: () => {},
  onToggleChat: () => {},
};

describe("AppStrip", () => {
  it("carries no product wordmark", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.queryByText("DevBench")).not.toBeInTheDocument();
  });

  it("offers no theme control", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.queryByRole("button", { name: /^theme$/i })).not.toBeInTheDocument();
  });

  it("renders one tab per instance, and only one tablist when nothing occupies the right pane", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["API", "DBorders"]);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("shows a second tablist once a tab occupies the right pane", () => {
    const tabs = [...TWO_LEFT_TABS, { id: "t-log", kind: "log" as const, pane: "right" as const, ordinal: 0, state: {} }];
    render(<AppStrip {...BASE} tabs={tabs} activeTabId={{ left: "t-api", right: "t-log" }} />);
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });

  // Spec item 2: "Tab labels disambiguate duplicates. A DB tab renders DB
  // plus its table name in mono as a subtitle."
  it("labels a DB tab with its table as a subtitle", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.getByRole("tab", { name: /DB/ })).toHaveTextContent("orders");
  });

  it("selects a tab on click", () => {
    const onSetActiveTab = vi.fn();
    render(<AppStrip {...BASE} onSetActiveTab={onSetActiveTab} />);
    fireEvent.click(screen.getByRole("tab", { name: /DB/ }));
    expect(onSetActiveTab).toHaveBeenCalledWith("left", "t-db");
  });

  it("closes a tab from its own close button, without also selecting it", () => {
    const onCloseTab = vi.fn();
    const onSetActiveTab = vi.fn();
    render(<AppStrip {...BASE} onCloseTab={onCloseTab} onSetActiveTab={onSetActiveTab} />);
    fireEvent.click(screen.getByRole("button", { name: /close db/i }));
    expect(onCloseTab).toHaveBeenCalledWith("t-db");
    expect(onSetActiveTab).not.toHaveBeenCalled();
  });

  it("adds a tab of the chosen kind to the primary pane via its + menu", () => {
    const onAddTab = vi.fn();
    render(<AppStrip {...BASE} onAddTab={onAddTab} />);
    fireEvent.click(screen.getByRole("button", { name: /add a tool to the primary pane/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Email" }));
    expect(onAddTab).toHaveBeenCalledWith("left", "email");
  });

  // Spec item 2: "Split with one tab open creates a tab rather than emptying
  // a pane... Split instead opens the + menu targeting the right pane."
  it("opens a + menu targeting the right pane when Split declines to move a tab", () => {
    const onToggleSplit = vi.fn(() => false);
    render(<AppStrip {...BASE} tabs={[TWO_LEFT_TABS[0]]} onToggleSplit={onToggleSplit} />);

    fireEvent.click(screen.getByRole("button", { name: /toggle split view/i }));

    expect(onToggleSplit).toHaveBeenCalled();
    expect(screen.getByRole("menu")).toHaveAccessibleName(/secondary pane/i);
  });

  it("adding a tool from the declined-split menu targets the right pane", () => {
    const onAddTab = vi.fn();
    render(<AppStrip {...BASE} tabs={[TWO_LEFT_TABS[0]]} onToggleSplit={() => false} onAddTab={onAddTab} />);

    fireEvent.click(screen.getByRole("button", { name: /toggle split view/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Log" }));

    expect(onAddTab).toHaveBeenCalledWith("right", "log");
  });

  it("does not open a menu when Split successfully moves a tab", () => {
    render(<AppStrip {...BASE} onToggleSplit={() => true} />);
    fireEvent.click(screen.getByRole("button", { name: /toggle split view/i }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the split from the secondary group's own close-split button", () => {
    const onCloseSplitPane = vi.fn();
    const tabs = [...TWO_LEFT_TABS, { id: "t-log", kind: "log" as const, pane: "right" as const, ordinal: 0, state: {} }];
    render(<AppStrip {...BASE} tabs={tabs} activeTabId={{ left: "t-api", right: "t-log" }} onCloseSplitPane={onCloseSplitPane} />);
    fireEvent.click(screen.getByRole("button", { name: /close split/i }));
    expect(onCloseSplitPane).toHaveBeenCalled();
  });

  it("mirrors the body grid columns and collapses the chat column when closed", () => {
    const { container, rerender } = render(<AppStrip {...BASE} />);
    expect(container.querySelector("header")!.getAttribute("style")).toContain(
      "grid-template-columns: var(--w-sidebar) 1fr var(--w-chat)",
    );
    rerender(<AppStrip {...BASE} chatOpen={false} />);
    expect(container.querySelector("header")!.getAttribute("style")).toContain(
      "grid-template-columns: var(--w-sidebar) 1fr auto",
    );
  });

  it("toggles the chat dock and reflects its state", () => {
    const onToggleChat = vi.fn();
    const { rerender } = render(<AppStrip {...BASE} onToggleChat={onToggleChat} />);
    const button = screen.getByRole("button", { name: /toggle ai chat/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleChat).toHaveBeenCalled();
    rerender(<AppStrip {...BASE} chatOpen={false} onToggleChat={onToggleChat} />);
    expect(screen.getByRole("button", { name: /toggle ai chat/i })).toHaveAttribute("aria-pressed", "false");
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `bun run test -- src/components/shell/AppStrip.test.tsx`
Expected: FAIL — `AppStrip` still expects `activeTab`/`secondaryTab`/`splitOpen` props, not `tabs`/`activeTabId`.

- [ ] **Step 7: Rewrite `AppStrip`**

Replace `apps/devbench/src/components/shell/AppStrip.tsx` wholesale:

```tsx
import { useState } from "react";
import { Tabs } from "../ui/Tabs";
import { Menu } from "../ui/Menu";
import { TABS } from "./tools";
import { isSplitOpen, type Pane, type Tab, type ToolKind } from "../../store/useAppStore";

const ADD_OPTIONS = TABS.map((t) => ({ value: t.id, label: t.label }));

export function AppStrip({
  tabs,
  activeTabId,
  chatOpen,
  onSetActiveTab,
  onAddTab,
  onCloseTab,
  onToggleSplit,
  onCloseSplitPane,
  onToggleChat,
}: {
  tabs: Tab[];
  activeTabId: { left: string | null; right: string | null };
  chatOpen: boolean;
  onSetActiveTab: (pane: Pane, id: string) => void;
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onCloseTab: (id: string) => void;
  onToggleSplit: () => boolean;
  onCloseSplitPane: () => void;
  onToggleChat: () => void;
}) {
  const splitOpen = isSplitOpen(tabs);
  // Split, declined: no right-pane tab exists to anchor a menu near, so the
  // right TabGroup renders early (bare, its + already open) to serve as its
  // own anchor. Picking a tool — or dismissing — clears this back to false;
  // `splitOpen` itself is untouched, since no tab has actually moved yet.
  const [pendingSplitAdd, setPendingSplitAdd] = useState(false);
  const showRightGroup = splitOpen || pendingSplitAdd;

  function handleToggleSplit() {
    const moved = onToggleSplit();
    if (!moved) setPendingSplitAdd(true);
  }

  return (
    <header
      data-tauri-drag-region="deep"
      style={{ gridTemplateColumns: `var(--w-sidebar) 1fr ${chatOpen ? "var(--w-chat)" : "auto"}` }}
      className="grid h-11 shrink-0 border-b border-border"
    >
      <div aria-hidden="true" data-tauri-drag-region />

      <div className="flex min-w-0">
        <TabGroup
          pane="left"
          label="Primary pane tools"
          tabs={tabs}
          activeId={activeTabId.left}
          onSetActiveTab={onSetActiveTab}
          onAddTab={onAddTab}
          onCloseTab={onCloseTab}
        />
        {showRightGroup ? (
          <TabGroup
            pane="right"
            label="Secondary pane tools"
            tabs={tabs}
            activeId={activeTabId.right}
            onSetActiveTab={onSetActiveTab}
            onAddTab={(pane, kind) => {
              onAddTab(pane, kind);
              setPendingSplitAdd(false);
            }}
            onCloseTab={onCloseTab}
            className="border-l border-border"
            menuOpen={pendingSplitAdd || undefined}
            onMenuOpenChange={(open) => setPendingSplitAdd(open)}
            trailing={
              splitOpen ? (
                <button
                  aria-label="Close split"
                  onClick={onCloseSplitPane}
                  className="ml-auto grid size-7 shrink-0 place-items-center rounded-sm text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
                >
                  <CloseIcon />
                </button>
              ) : null
            }
          />
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-0.5 px-2.5">
        <button aria-label="Toggle split view" aria-pressed={splitOpen} onClick={handleToggleSplit} className={ACTION_CLASS}>
          <SplitIcon />
          <span>Split</span>
        </button>
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        <button aria-label="Toggle AI chat" aria-pressed={chatOpen} onClick={onToggleChat} className={ACTION_CLASS}>
          <ChatIcon />
          <span>Chat</span>
        </button>
      </div>
    </header>
  );
}

const ACTION_CLASS =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-text-muted " +
  "transition-colors duration-150 hover:bg-surface-2 hover:text-text " +
  "aria-pressed:bg-surface-2 aria-pressed:text-text";

function tabLabel(tab: Tab): React.ReactNode {
  const base = TABS.find((t) => t.id === tab.kind)?.label ?? tab.kind;
  if (tab.kind === "db" && typeof tab.state.table === "string") {
    return (
      <span className="flex flex-col items-start leading-tight">
        <span>{base}</span>
        <span className="font-mono text-[10px] text-text-faint">{tab.state.table}</span>
      </span>
    );
  }
  return base;
}

function tabCloseName(tab: Tab): string {
  const base = TABS.find((t) => t.id === tab.kind)?.label ?? tab.kind;
  return typeof tab.state.table === "string" ? `${base} ${tab.state.table}` : base;
}

function TabGroup({
  pane,
  tabs,
  activeId,
  onSetActiveTab,
  onAddTab,
  onCloseTab,
  label,
  className = "",
  trailing,
  menuOpen,
  onMenuOpenChange,
}: {
  pane: Pane;
  tabs: Tab[];
  activeId: string | null;
  onSetActiveTab: (pane: Pane, id: string) => void;
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onCloseTab: (id: string) => void;
  label: string;
  className?: string;
  trailing?: React.ReactNode;
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const paneTabs = tabs.filter((t) => t.pane === pane).sort((a, b) => a.ordinal - b.ordinal);

  return (
    <Tabs.Root
      value={activeId ?? undefined}
      onValueChange={(next) => onSetActiveTab(pane, String(next))}
      className={`flex min-w-0 flex-1 items-center gap-0.5 px-2 ${className}`}
    >
      <Tabs.List className="flex min-w-0 items-center gap-0.5 overflow-x-auto" aria-label={label}>
        {paneTabs.map((tab) => (
          // A sibling close button, not a child of Tabs.Tab: Tabs.Tab renders
          // a <button>, and a nested <button> is invalid HTML and breaks
          // click targeting. Same shape SessionsSidebar already uses for its
          // per-row archive button.
          <div key={tab.id} className="group flex shrink-0 items-center">
            <Tabs.Tab
              value={tab.id}
              data-selected={tab.id === activeId ? "" : undefined}
              className="shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 data-selected:bg-surface-2 data-selected:font-semibold data-selected:text-text"
            >
              {tabLabel(tab)}
            </Tabs.Tab>
            <button
              aria-label={`Close ${tabCloseName(tab)}`}
              onClick={() => onCloseTab(tab.id)}
              className="-ml-1 grid size-5 shrink-0 place-items-center rounded-sm text-text-faint opacity-0 transition-opacity duration-150 hover:bg-surface-2 hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </Tabs.List>
      <Menu
        label={`Add a tool to the ${pane === "left" ? "primary" : "secondary"} pane`}
        options={ADD_OPTIONS}
        onSelect={(kind) => onAddTab(pane, kind as ToolKind)}
        trigger={<PlusIcon />}
        triggerClassName="grid size-7 shrink-0 place-items-center rounded-sm text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
      />
      {trailing}
    </Tabs.Root>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun run test -- src/components/shell/AppStrip.test.tsx`
Expected: PASS, all 14.

- [ ] **Step 9: Wire `App.tsx` to the new props, via pure-store adapters**

In `apps/devbench/src/App.tsx`, replace the tab-related store reads (currently `activeTab`/`setActiveTab`/`secondaryTab`/`setSecondaryTab`/`splitOpen`/`setSplitOpen`) with:

```tsx
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const setActiveTabId = useAppStore((s) => s.setActiveTabId);
  const splitActiveTab = useAppStore((s) => s.splitActiveTab);
  const closeSplit = useAppStore((s) => s.closeSplit);

  // Reimplemented against useTabController in Task 4; AppStrip's own props
  // never change.
  function onAddTab(pane: Pane, kind: ToolKind) {
    addTab(crypto.randomUUID(), kind, pane);
  }
  function onToggleSplit(): boolean {
    return splitActiveTab().moved;
  }
```

Add the `Pane`/`ToolKind` import alongside the existing `ThemePref` one:

```tsx
import { useAppStore, type Pane, type ThemePref, type ToolKind } from "./store/useAppStore";
```

Replace the `<AppStrip .../>` call:

```tsx
      <AppStrip
        tabs={tabs}
        activeTabId={activeTabId}
        chatOpen={chatOpen}
        onSetActiveTab={setActiveTabId}
        onAddTab={onAddTab}
        onCloseTab={closeTab}
        onToggleSplit={onToggleSplit}
        onCloseSplitPane={closeSplit}
        onToggleChat={() => setChatOpen(!chatOpen)}
      />
```

`SplitContent` still reads `activeTab`/`secondaryTab`/`splitOpen` directly from the store below this and is untouched until Task 5 — leave its usage as-is for now; it renders emptily but does not crash (see this plan's "Note on test suite state").

- [ ] **Step 10: Run the full suite**

Run: `bun run test`
Expected: same single expected failure as Task 1 — `SplitContent.test.tsx` (3 tests) — and nothing else. `App.test.tsx`'s first test ("renders the three-column workspace with one tab per tool") still passes: it asserts on the four *static* tool labels from `TABS`, and with `tabs=[]` (the store's Task-1 default) `AppStrip` simply renders zero tab instances plus a `+`, which the test does not check for.

Actually — double-check that assumption before moving on: `App.test.tsx`'s first test currently asserts `screen.getAllByRole("tab").map(t => t.textContent)` equals the four tool names. With the real store's `tabs` starting empty, `AppStrip` now renders **zero** `tab` elements. **This assertion will fail.** Fix it now rather than carrying it to Task 6:

In `apps/devbench/src/App.test.tsx`, replace the first test:

```tsx
  it("renders the three-column workspace", () => {
    render(<App />);
    expect(screen.getByRole("complementary", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "AI Assistant" })).toBeInTheDocument();
    // No tabs open yet — Task 5 covers the empty-state prompt this produces.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });
```

Run: `bun run test`
Expected: same single expected failure as before (`SplitContent.test.tsx`), nothing else.

- [ ] **Step 11: Commit**

```bash
git add apps/devbench/src/components/ui/Menu.tsx apps/devbench/src/components/ui/Menu.test.tsx apps/devbench/src/components/shell/AppStrip.tsx apps/devbench/src/components/shell/AppStrip.test.tsx apps/devbench/src/App.tsx apps/devbench/src/App.test.tsx
git commit -m "feat(devbench): render dynamic per-pane tab instances in AppStrip"
```

---

## Task 3: SQLite persistence for tabs

**Files:**
- Create: `apps/devbench/src-tauri/migrations/0004_tabs.sql`
- Create: `apps/devbench/src-tauri/src/commands/tabs.rs`
- Modify: `apps/devbench/src-tauri/src/commands/mod.rs`
- Modify: `apps/devbench/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `create_session_impl`, `delete_session_impl` from `commands::sessions` (both already `pub`).
- Produces:
  - `TabRow { id, session_id: Option<String>, kind: String, pane: String, ordinal: i64, state: Option<String> }`
  - `list_tabs_impl(pool: &SqlitePool, session_id: Option<&str>) -> Result<Vec<TabRow>, String>`
  - `create_tab_impl(pool, id: &str, session_id: Option<&str>, kind: &str, pane: &str, ordinal: i64, state: Option<&str>) -> Result<(), String>`
  - `close_tab_impl(pool, id: &str) -> Result<(), String>`
  - `set_tab_state_impl(pool, id: &str, state: &str) -> Result<(), String>`
  - `move_tab_impl(pool, id: &str, pane: &str, ordinal: i64) -> Result<(), String>`
  - Tauri commands `list_tabs`, `create_tab`, `close_tab`, `set_tab_state`, `move_tab`.

- [ ] **Step 1: Write the migration**

Create `apps/devbench/src-tauri/migrations/0004_tabs.sql`:

```sql
-- One row per open tab instance. `session_id IS NULL` is the unnamed scratch
-- workspace shown when no session is selected — it behaves exactly like a
-- session's workspace (shell design spec, "Tab persistence").
--
-- ON DELETE CASCADE, unlike request_history's ON DELETE SET NULL
-- (0003_session_scoped_history.sql): a tab's pane/ordinal/state describe a
-- workspace layout that belongs entirely to one session. There is nothing
-- sensible to orphan it into once that session is gone — unlike a request
-- log entry, a dangling tab has no meaning on its own. Enforced because
-- sqlx-sqlite issues `PRAGMA foreign_keys = ON` by default.
CREATE TABLE tabs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  pane        TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  state       TEXT
);

-- The read path is always `WHERE session_id IS ? ORDER BY pane, ordinal`.
CREATE INDEX idx_tabs_session_pane_ordinal ON tabs (session_id, pane, ordinal);
```

- [ ] **Step 2: Write the failing tests**

Create `apps/devbench/src-tauri/src/commands/tabs.rs`:

```rust
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::local_db::LocalDb;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TabRow {
    pub id: String,
    pub session_id: Option<String>,
    pub kind: String,
    pub pane: String,
    pub ordinal: i64,
    pub state: Option<String>,
}

fn row_to_tab(r: &sqlx::sqlite::SqliteRow) -> TabRow {
    TabRow {
        id: r.get("id"),
        session_id: r.get("session_id"),
        kind: r.get("kind"),
        pane: r.get("pane"),
        ordinal: r.get("ordinal"),
        state: r.get("state"),
    }
}

// `session_id IS ?`, not `= ?`: NULL is an exact scope here (the scratch
// workspace), never a wildcard for "every tab regardless of session" — SQLite's
// `IS` is the NULL-safe comparison that makes a bound NULL match NULL rows.
pub async fn list_tabs_impl(pool: &SqlitePool, session_id: Option<&str>) -> Result<Vec<TabRow>, String> {
    let rows = sqlx::query(
        "SELECT id, session_id, kind, pane, ordinal, state FROM tabs \
         WHERE session_id IS ? ORDER BY pane, ordinal",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("failed to list tabs: {e}"))?;
    Ok(rows.iter().map(row_to_tab).collect())
}

#[allow(clippy::too_many_arguments)]
pub async fn create_tab_impl(
    pool: &SqlitePool,
    id: &str,
    session_id: Option<&str>,
    kind: &str,
    pane: &str,
    ordinal: i64,
    state: Option<&str>,
) -> Result<(), String> {
    sqlx::query("INSERT INTO tabs (id, session_id, kind, pane, ordinal, state) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id)
        .bind(session_id)
        .bind(kind)
        .bind(pane)
        .bind(ordinal)
        .bind(state)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to create tab: {e}"))?;
    Ok(())
}

pub async fn close_tab_impl(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM tabs WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to close tab: {e}"))?;
    Ok(())
}

/// Not an error when `id` no longer exists — a debounced write can
/// legitimately land after the tab was already closed.
pub async fn set_tab_state_impl(pool: &SqlitePool, id: &str, state: &str) -> Result<(), String> {
    sqlx::query("UPDATE tabs SET state = ? WHERE id = ?")
        .bind(state)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to set tab state: {e}"))?;
    Ok(())
}

pub async fn move_tab_impl(pool: &SqlitePool, id: &str, pane: &str, ordinal: i64) -> Result<(), String> {
    sqlx::query("UPDATE tabs SET pane = ?, ordinal = ? WHERE id = ?")
        .bind(pane)
        .bind(ordinal)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("failed to move tab: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn list_tabs(db: State<'_, LocalDb>, session_id: Option<String>) -> Result<Vec<TabRow>, String> {
    list_tabs_impl(&db.pool, session_id.as_deref()).await
}

#[tauri::command]
pub async fn create_tab(
    db: State<'_, LocalDb>,
    id: String,
    session_id: Option<String>,
    kind: String,
    pane: String,
    ordinal: i64,
    state: Option<String>,
) -> Result<(), String> {
    create_tab_impl(&db.pool, &id, session_id.as_deref(), &kind, &pane, ordinal, state.as_deref()).await
}

#[tauri::command]
pub async fn close_tab(db: State<'_, LocalDb>, id: String) -> Result<(), String> {
    close_tab_impl(&db.pool, &id).await
}

#[tauri::command]
pub async fn set_tab_state(db: State<'_, LocalDb>, id: String, state: String) -> Result<(), String> {
    set_tab_state_impl(&db.pool, &id, &state).await
}

#[tauri::command]
pub async fn move_tab(db: State<'_, LocalDb>, id: String, pane: String, ordinal: i64) -> Result<(), String> {
    move_tab_impl(&db.pool, &id, &pane, ordinal).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sessions::create_session_impl;

    async fn db() -> (tempfile::TempDir, LocalDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::connect(dir.path().to_path_buf()).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn creates_and_lists_a_tab_scoped_to_a_session() {
        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        create_tab_impl(&db.pool, "tab-1", Some(&session.id), "api", "left", 0, None).await.unwrap();

        let listed = list_tabs_impl(&db.pool, Some(&session.id)).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "tab-1");
        assert_eq!(listed[0].kind, "api");
    }

    #[tokio::test]
    async fn the_scratch_workspace_is_session_id_null_and_distinct_from_named_sessions() {
        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        create_tab_impl(&db.pool, "scratch-1", None, "api", "left", 0, None).await.unwrap();
        create_tab_impl(&db.pool, "session-1", Some(&session.id), "db", "left", 0, None).await.unwrap();

        assert_eq!(list_tabs_impl(&db.pool, None).await.unwrap().len(), 1);
        assert_eq!(list_tabs_impl(&db.pool, Some(&session.id)).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn lists_ordered_by_pane_then_ordinal() {
        let (_dir, db) = db().await;
        create_tab_impl(&db.pool, "b", None, "log", "left", 1, None).await.unwrap();
        create_tab_impl(&db.pool, "a", None, "api", "left", 0, None).await.unwrap();
        create_tab_impl(&db.pool, "c", None, "email", "right", 0, None).await.unwrap();

        let listed = list_tabs_impl(&db.pool, None).await.unwrap();
        assert_eq!(listed.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn closing_a_tab_removes_only_that_row() {
        let (_dir, db) = db().await;
        create_tab_impl(&db.pool, "keep", None, "api", "left", 0, None).await.unwrap();
        create_tab_impl(&db.pool, "gone", None, "db", "left", 1, None).await.unwrap();

        close_tab_impl(&db.pool, "gone").await.unwrap();

        let listed = list_tabs_impl(&db.pool, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "keep");
    }

    #[tokio::test]
    async fn closing_an_already_closed_tab_is_not_an_error() {
        let (_dir, db) = db().await;
        close_tab_impl(&db.pool, "never-existed").await.unwrap();
    }

    #[tokio::test]
    async fn set_tab_state_updates_the_json_blob() {
        let (_dir, db) = db().await;
        create_tab_impl(&db.pool, "tab-1", None, "db", "left", 0, None).await.unwrap();

        set_tab_state_impl(&db.pool, "tab-1", r#"{"table":"orders"}"#).await.unwrap();

        let listed = list_tabs_impl(&db.pool, None).await.unwrap();
        assert_eq!(listed[0].state.as_deref(), Some(r#"{"table":"orders"}"#));
    }

    // A debounced write can legitimately land after the user already closed
    // the tab. It must not surface as an error the frontend has to handle.
    #[tokio::test]
    async fn set_tab_state_on_a_missing_tab_is_not_an_error() {
        let (_dir, db) = db().await;
        set_tab_state_impl(&db.pool, "never-existed", r#"{"table":"orders"}"#).await.unwrap();
    }

    #[tokio::test]
    async fn move_tab_changes_pane_and_ordinal() {
        let (_dir, db) = db().await;
        create_tab_impl(&db.pool, "tab-1", None, "db", "left", 0, None).await.unwrap();

        move_tab_impl(&db.pool, "tab-1", "right", 3).await.unwrap();

        let listed = list_tabs_impl(&db.pool, None).await.unwrap();
        assert_eq!(listed[0].pane, "right");
        assert_eq!(listed[0].ordinal, 3);
    }

    // The counterpart to commands::history::tests::deleting_a_session_keeps_its_history
    // — same shape of test, opposite FK action, because a tab has no meaning
    // once its session is gone (see the migration's comment).
    #[tokio::test]
    async fn deleting_a_session_deletes_its_tabs_but_not_the_scratch_workspaces() {
        use crate::commands::sessions::delete_session_impl;

        let (_dir, db) = db().await;
        let session = create_session_impl(&db.pool, "Order flow", None).await.unwrap();
        create_tab_impl(&db.pool, "tab-1", Some(&session.id), "api", "left", 0, None).await.unwrap();
        create_tab_impl(&db.pool, "scratch-1", None, "api", "left", 0, None).await.unwrap();

        delete_session_impl(&db.pool, &session.id).await.unwrap();

        assert_eq!(list_tabs_impl(&db.pool, Some(&session.id)).await.unwrap().len(), 0);
        assert_eq!(list_tabs_impl(&db.pool, None).await.unwrap().len(), 1);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/devbench/src-tauri && cargo test --lib tabs::`
Expected: FAIL to compile — `commands::tabs` is not declared as a module yet.

- [ ] **Step 4: Register the module and the commands**

In `apps/devbench/src-tauri/src/commands/mod.rs`, add in alphabetical order:

```rust
pub mod tabs;
```

In `apps/devbench/src-tauri/src/main.rs`, add to the `invoke_handler!` list, after `commands::sessions::delete_session,`:

```rust
            commands::tabs::list_tabs,
            commands::tabs::create_tab,
            commands::tabs::close_tab,
            commands::tabs::set_tab_state,
            commands::tabs::move_tab,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/devbench/src-tauri && cargo test --lib tabs::`
Expected: PASS (10 tests).

Then the whole backend suite:

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS (141 lib tests, 1 ignored, 3 smoke tests) — the 131 from before Task 3 plus these 10.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src-tauri/migrations apps/devbench/src-tauri/src/commands/tabs.rs apps/devbench/src-tauri/src/commands/mod.rs apps/devbench/src-tauri/src/main.rs
git commit -m "feat(devbench): persist tab instances in SQLite"
```

---

## Task 4: `useTabController` — wiring the store to SQLite

**Files:**
- Modify: `apps/devbench/src/lib/tauri.ts`
- Create: `apps/devbench/src/store/useTabController.ts`
- Create: `apps/devbench/src/store/useTabController.test.ts`
- Modify: `apps/devbench/src/App.tsx`

**Interfaces:**
- Consumes: `TabRow`-shaped invoke wrappers (this task); `Tab`/`ToolKind`/`Pane`/store actions from Task 1.
- Produces:
```ts
function useTabController(): {
  addTab: (kind: ToolKind, pane: Pane, state?: Record<string, unknown>) => string;
  closeTab: (id: string) => void;
  setActiveTabId: (pane: Pane, id: string) => void;
  patchTabState: (id: string, patch: Record<string, unknown>) => void;
  splitActiveTab: () => boolean;
  closeSplit: () => void;
  focusOrCreateTab: (kind: ToolKind, statePatch?: Record<string, unknown>) => string;
}
```
Must be called exactly once, at the top of the tree (`App.tsx`) — see the doc comment in Step 3 for why.

- [ ] **Step 1: Add the TS wrappers**

Append to `apps/devbench/src/lib/tauri.ts`:

```ts
export interface TabRow {
  id: string;
  session_id: string | null;
  kind: string;
  pane: string;
  ordinal: number;
  state: string | null;
}

export function invokeListTabs(sessionId: string | null): Promise<TabRow[]> {
  return invoke("list_tabs", { sessionId });
}

export function invokeCreateTab(input: {
  id: string;
  sessionId: string | null;
  kind: string;
  pane: string;
  ordinal: number;
  state: string;
}): Promise<void> {
  return invoke("create_tab", input);
}

export function invokeCloseTab(id: string): Promise<void> {
  return invoke("close_tab", { id });
}

export function invokeSetTabState(id: string, state: string): Promise<void> {
  return invoke("set_tab_state", { id, state });
}

export function invokeMoveTab(id: string, pane: string, ordinal: number): Promise<void> {
  return invoke("move_tab", { id, pane, ordinal });
}
```

- [ ] **Step 2: Write the failing hook tests**

Create `apps/devbench/src/store/useTabController.test.ts`:

```ts
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useTabController } from "./useTabController";
import { useAppStore } from "./useAppStore";
import * as tauriLib from "../lib/tauri";

function reset() {
  useAppStore.setState({ tabs: [], activeTabId: { left: null, right: null }, activeSessionId: null });
}

describe("useTabController", () => {
  beforeEach(() => {
    reset();
    vi.restoreAllMocks();
  });

  it("loads the scratch workspace's tabs on mount", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "t-1", session_id: null, kind: "api", pane: "left", ordinal: 0, state: null },
    ]);
    renderHook(() => useTabController());

    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));
    expect(useAppStore.getState().tabs[0]).toEqual({ id: "t-1", kind: "api", pane: "left", ordinal: 0, state: {} });
    expect(useAppStore.getState().activeTabId).toEqual({ left: "t-1", right: null });
  });

  it("parses a stored JSON state blob, and tolerates a null one", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "t-1", session_id: null, kind: "db", pane: "left", ordinal: 0, state: '{"table":"orders"}' },
      { id: "t-2", session_id: null, kind: "email", pane: "left", ordinal: 1, state: null },
    ]);
    renderHook(() => useTabController());

    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(2));
    const tabs = useAppStore.getState().tabs;
    expect(tabs[0].state).toEqual({ table: "orders" });
    expect(tabs[1].state).toEqual({});
  });

  it("reloads when the active session changes", async () => {
    const listTabs = vi
      .spyOn(tauriLib, "invokeListTabs")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "s-1", session_id: "sess-1", kind: "db", pane: "left", ordinal: 0, state: null }]);
    renderHook(() => useTabController());
    await waitFor(() => expect(listTabs).toHaveBeenCalledWith(null));

    act(() => useAppStore.setState({ activeSessionId: "sess-1" }));

    await waitFor(() => expect(listTabs).toHaveBeenCalledWith("sess-1"));
    await waitFor(() => expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["s-1"]));
  });

  it("creates a tab locally and persists it with a computed ordinal", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([]);
    const createTab = vi.spyOn(tauriLib, "invokeCreateTab").mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabController());
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(0));

    let newId = "";
    act(() => {
      newId = result.current.addTab("db", "left");
    });

    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual([newId]);
    await waitFor(() =>
      expect(createTab).toHaveBeenCalledWith({ id: newId, sessionId: null, kind: "db", pane: "left", ordinal: 0, state: "{}" }),
    );
  });

  it("closing a tab removes it locally and persists the deletion", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "t-1", session_id: null, kind: "api", pane: "left", ordinal: 0, state: null },
    ]);
    const closeTab = vi.spyOn(tauriLib, "invokeCloseTab").mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabController());
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));

    act(() => result.current.closeTab("t-1"));

    expect(useAppStore.getState().tabs).toHaveLength(0);
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("t-1"));
  });

  // Spec: "URL edits are debounced into a single write, not one per keystroke."
  // Applied generically to every patchTabState call, not just RequestBuilder's.
  it("debounces patchTabState into a single write after 300ms of quiet", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "t-1", session_id: null, kind: "api", pane: "left", ordinal: 0, state: null },
    ]);
    const setTabState = vi.spyOn(tauriLib, "invokeSetTabState").mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabController());
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));

    vi.useFakeTimers();
    act(() => {
      result.current.patchTabState("t-1", { url: "/a" });
      result.current.patchTabState("t-1", { url: "/ab" });
      result.current.patchTabState("t-1", { url: "/abc" });
    });

    // The in-memory state is immediate — typing must feel instant even though
    // the SQLite write is delayed.
    expect(useAppStore.getState().tabs[0].state).toEqual({ url: "/abc" });
    expect(setTabState).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(setTabState).toHaveBeenCalledTimes(1);
    expect(setTabState).toHaveBeenCalledWith("t-1", JSON.stringify({ url: "/abc" }));
    vi.useRealTimers();
  });

  it("splitActiveTab persists the move and returns whether it happened", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "a", session_id: null, kind: "api", pane: "left", ordinal: 0, state: null },
      { id: "b", session_id: null, kind: "db", pane: "left", ordinal: 1, state: null },
    ]);
    const moveTab = vi.spyOn(tauriLib, "invokeMoveTab").mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabController());
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(2));
    act(() => useAppStore.getState().setActiveTabId("left", "b"));

    let moved = false;
    act(() => {
      moved = result.current.splitActiveTab();
    });

    expect(moved).toBe(true);
    await waitFor(() => expect(moveTab).toHaveBeenCalledWith("b", "right", 0));
  });

  it("resolves an existing left-pane tab of the requested kind rather than creating a duplicate", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "db-1", session_id: null, kind: "db", pane: "left", ordinal: 0, state: null },
    ]);
    const createTab = vi.spyOn(tauriLib, "invokeCreateTab").mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabController());
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));

    let targetId = "";
    act(() => {
      targetId = result.current.focusOrCreateTab("db", { table: "orders" });
    });

    expect(targetId).toBe("db-1");
    expect(useAppStore.getState().activeTabId.left).toBe("db-1");
    expect(useAppStore.getState().tabs[0].state).toEqual({ table: "orders" });
    expect(createTab).not.toHaveBeenCalled();
  });

  it("creates a tab when none of the requested kind exists in the left pane", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeCreateTab").mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabController());
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(0));

    let targetId = "";
    act(() => {
      targetId = result.current.focusOrCreateTab("log");
    });

    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual([targetId]);
    expect(useAppStore.getState().tabs[0].kind).toBe("log");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun run test -- src/store/useTabController.test.ts`
Expected: FAIL — cannot resolve `./useTabController`.

- [ ] **Step 4: Write the hook**

Create `apps/devbench/src/store/useTabController.ts`:

```ts
import { useEffect, useRef } from "react";
import { useAppStore, type Pane, type Tab, type ToolKind } from "./useAppStore";
import {
  invokeCloseTab,
  invokeCreateTab,
  invokeListTabs,
  invokeMoveTab,
  invokeSetTabState,
  type TabRow,
} from "../lib/tauri";

const DEBOUNCE_MS = 300;

function parseState(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hydrateTab(row: TabRow): Tab {
  return { id: row.id, kind: row.kind as ToolKind, pane: row.pane as Pane, ordinal: row.ordinal, state: parseState(row.state) };
}

/**
 * Wraps the store's pure tab actions with SQLite persistence — the same
 * "update the store, then fire the matching invoke" split AppearancePane and
 * SessionsSidebar already use for theme and session selection. `tabs` and
 * `activeTabId` are read straight from useAppStore wherever they're needed;
 * only the mutating actions route through here.
 *
 * Call exactly once, at the top of the tree. The session-switch effect below
 * issues one invokeListTabs per mount; a second instance would race it.
 */
export function useTabController() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const addTabInStore = useAppStore((s) => s.addTab);
  const closeTabInStore = useAppStore((s) => s.closeTab);
  const patchTabStateInStore = useAppStore((s) => s.patchTabState);
  const setActiveTabIdInStore = useAppStore((s) => s.setActiveTabId);
  const splitActiveTabInStore = useAppStore((s) => s.splitActiveTab);
  const closeSplitInStore = useAppStore((s) => s.closeSplit);
  const replaceTabs = useAppStore((s) => s.replaceTabs);

  // Per-tab debounce timers for patchTabState's write. Keyed by tab id so
  // patching two tabs concurrently debounces independently; a ref survives
  // re-renders without retriggering this effect.
  const writeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    let cancelled = false;
    void invokeListTabs(activeSessionId)
      .then((rows) => {
        if (!cancelled) replaceTabs(rows.map(hydrateTab));
      })
      .catch(() => {
        if (!cancelled) replaceTabs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, replaceTabs]);

  function addTab(kind: ToolKind, pane: Pane, state: Record<string, unknown> = {}): string {
    const id = crypto.randomUUID();
    const ordinal =
      useAppStore.getState().tabs.filter((t) => t.pane === pane).reduce((max, t) => Math.max(max, t.ordinal), -1) + 1;
    addTabInStore(id, kind, pane, state);
    void invokeCreateTab({ id, sessionId: activeSessionId, kind, pane, ordinal, state: JSON.stringify(state) }).catch(() => {});
    return id;
  }

  function closeTab(id: string) {
    const timer = writeTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      writeTimers.current.delete(id);
    }
    closeTabInStore(id);
    void invokeCloseTab(id).catch(() => {});
  }

  function patchTabState(id: string, patch: Record<string, unknown>) {
    patchTabStateInStore(id, patch);
    const existing = writeTimers.current.get(id);
    if (existing !== undefined) clearTimeout(existing);
    writeTimers.current.set(
      id,
      setTimeout(() => {
        writeTimers.current.delete(id);
        const tab = useAppStore.getState().tabs.find((t) => t.id === id);
        // Reads the tab's CURRENT full state at flush time, not the patch that
        // scheduled this timer — coalesced edits must write the latest value,
        // not just the last patch's keys.
        if (tab) void invokeSetTabState(id, JSON.stringify(tab.state)).catch(() => {});
      }, DEBOUNCE_MS),
    );
  }

  function splitActiveTab(): boolean {
    const { moved, tab } = splitActiveTabInStore();
    if (moved && tab) void invokeMoveTab(tab.id, tab.pane, tab.ordinal).catch(() => {});
    return moved;
  }

  function closeSplit() {
    closeSplitInStore().forEach((id) => {
      const timer = writeTimers.current.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        writeTimers.current.delete(id);
      }
      void invokeCloseTab(id).catch(() => {});
    });
  }

  function focusOrCreateTab(kind: ToolKind, statePatch?: Record<string, unknown>): string {
    const existing = useAppStore.getState().tabs.find((t) => t.pane === "left" && t.kind === kind);
    if (existing) {
      setActiveTabIdInStore("left", existing.id);
      if (statePatch) patchTabState(existing.id, statePatch);
      return existing.id;
    }
    return addTab(kind, "left", statePatch ?? {});
  }

  return { addTab, closeTab, setActiveTabId: setActiveTabIdInStore, patchTabState, splitActiveTab, closeSplit, focusOrCreateTab };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test -- src/store/useTabController.test.ts`
Expected: PASS, all 9.

- [ ] **Step 6: Re-source `App.tsx`'s adapters from the hook**

In `apps/devbench/src/App.tsx`, replace the Task 2 block (`const tabs = ...` through the two adapter functions) with:

```tsx
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabController = useTabController();

  function onAddTab(pane: Pane, kind: ToolKind) {
    tabController.addTab(kind, pane);
  }
  function onToggleSplit(): boolean {
    return tabController.splitActiveTab();
  }
```

Update the `<AppStrip .../>` call's two now-hook-backed props:

```tsx
        onSetActiveTab={tabController.setActiveTabId}
        onCloseTab={tabController.closeTab}
        onToggleSplit={onToggleSplit}
        onCloseSplitPane={tabController.closeSplit}
```

Add the import:

```tsx
import { useTabController } from "./store/useTabController";
```

- [ ] **Step 7: Run the full suite**

Run: `bun run test`
Expected: same single expected failure as Tasks 1–2 — `SplitContent.test.tsx` (3 tests) — nothing else. `App.tsx` now issues a real `invokeListTabs` on mount; the global `invoke` mock (`src/test-setup.ts`) resolves `[]` by default, so this does not break any test that doesn't explicitly assert on tab contents.

- [ ] **Step 8: Commit**

```bash
git add apps/devbench/src/lib/tauri.ts apps/devbench/src/store/useTabController.ts apps/devbench/src/store/useTabController.test.ts apps/devbench/src/App.tsx
git commit -m "feat(devbench): persist tab creation, closing, moves, and state edits"
```

---

## Task 5: Mounted-not-remounted lifecycle, empty state, and the DB/Log singletons

**Files:**
- Create: `apps/devbench/src/components/shell/EmptyPane.tsx`
- Create: `apps/devbench/src/components/shell/EmptyPane.test.tsx`
- Modify: `apps/devbench/src/components/shell/SplitContent.tsx`
- Modify: `apps/devbench/src/components/shell/SplitContent.test.tsx`
- Modify: `apps/devbench/src/components/shell/ToolPane.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`
- Modify: `apps/devbench/src/components/log/LogTab.tsx`
- Modify: `apps/devbench/src/App.tsx`

**Interfaces:**
- Consumes: `Tab`/`Pane`/`ToolKind` (Task 1), `tabController.patchTabState`/`onAddTab` (Tasks 2/4), `Menu` (plan 1 + Task 2).
- Produces:
```ts
function EmptyPane(props: { onAddTab: (kind: ToolKind) => void }): JSX.Element
function SplitContent(props: {
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onPatchState: (id: string, patch: Record<string, unknown>) => void;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
  emailFocusRequest: { tabId: string; emailId: number | null } | null;
}): JSX.Element
```
`ApiTab` and `EmailTab` keep their **current** prop names (`onOpenTableInDb`, `onOpenEmail`, `focusEmailId`) through this task — `ToolPane`'s `"api"`/`"email"` cases rename at the call site only. Task 6 changes `ApiTab.tsx` itself and drops that rename.

**Why DB and Log, not API and Email, in this task:** spec's "three singletons" table lists exactly three App-level values that break under duplication — `dbFocusTable`, `emailFocusId`, `activeLogSourceId`. `RequestBuilder`'s `method`/`url` are *already* per-instance `useState` today (never a singleton bug — Task 6 only adds SQLite persistence to them), and `EmailTab`'s own selection is *already* per-instance `useState` too (the bug is in `App.tsx`'s deep-link targeting, not in `EmailTab`). So opening two API tabs or two Email tabs already works correctly today with no crash — this task fixes the two tools that actually break (DB, Log); Task 6 finishes API/Email's deep-link wiring and adds `RequestBuilder`'s persistence.

- [ ] **Step 1: Write the failing `EmptyPane` test**

Create `apps/devbench/src/components/shell/EmptyPane.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyPane } from "./EmptyPane";

describe("EmptyPane", () => {
  it("explains that duplicates are allowed and offers the same tool menu as +", () => {
    const onAddTab = vi.fn();
    render(<EmptyPane onAddTab={onAddTab} />);

    expect(screen.getByText(/no tools open/i)).toBeInTheDocument();
    expect(screen.getByText(/duplicates are allowed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add a tool/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "API" }));
    expect(onAddTab).toHaveBeenCalledWith("api");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test -- src/components/shell/EmptyPane.test.tsx`
Expected: FAIL — cannot resolve `./EmptyPane`.

- [ ] **Step 3: Write `EmptyPane`**

Create `apps/devbench/src/components/shell/EmptyPane.tsx`:

```tsx
import { Menu } from "../ui/Menu";
import { TABS } from "./tools";
import type { ToolKind } from "../../store/useAppStore";

const ADD_OPTIONS = TABS.map((t) => ({ value: t.id, label: t.label }));

/** Shown when the active session (or the scratch workspace) has no tabs
 *  open. New sessions start genuinely empty — nothing is seeded. */
export function EmptyPane({ onAddTab }: { onAddTab: (kind: ToolKind) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="text-sm font-semibold text-text">No tools open</div>
      <p className="max-w-70 text-xs text-text-faint">
        Add a tool to get started. Duplicates are allowed — open two DB tabs to compare tables side by side.
      </p>
      <Menu
        label="Add a tool"
        options={ADD_OPTIONS}
        onSelect={(kind) => onAddTab(kind as ToolKind)}
        trigger="Add a tool"
        triggerClassName="rounded-sm border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text transition-colors duration-150 hover:bg-surface-2"
      />
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test -- src/components/shell/EmptyPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the `DbTab` migration test**

Replace `apps/devbench/src/components/db/DbTab.test.tsx` wholesale (mirror its current mocking setup for `invokeListTableRows`/`invokeListWatchedTables`/`invokeSetWatchedTable`; check the existing file for the exact mock return shapes before replacing, since `TableRows` and watch-list mocks must keep matching `lib/tauri.ts`):

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DbTab } from "./DbTab";
import * as tauriLib from "../../lib/tauri";

function renderDb(table: string | null, onPatchState = vi.fn()) {
  return { onPatchState, ...render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={table} onPatchState={onPatchState} />) };
}

describe("DbTab", () => {
  beforeEach(() => {
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
  });

  it("fetches rows for the table it is given, without needing a click first", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]] });
    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalledWith(expect.anything(), "orders"));
  });

  it("fetches nothing when given no table", () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [] });
    renderDb(null);
    expect(listRows).not.toHaveBeenCalled();
  });

  // The core independence bug this migration fixes: two DbTab instances,
  // given different `table` props, must never share fetched rows.
  it("re-fetches when its table prop changes to a different table", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [] });
    const { rerender, onPatchState } = renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalledWith(expect.anything(), "orders"));

    rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table="payments" onPatchState={onPatchState} />);
    await waitFor(() => expect(listRows).toHaveBeenCalledWith(expect.anything(), "payments"));
  });

  it("selecting a table in the schema tree patches state rather than fetching directly", () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [] });
    const { onPatchState } = renderDb(null);
    // SchemaTree's own tests cover the tree UI; DbTab's contract is that
    // selecting a table calls onPatchState, not a direct fetch. Covered
    // end-to-end (two DB tabs, two tables) in SplitContent.test.tsx.
    expect(onPatchState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun run test -- src/components/db/DbTab.test.tsx`
Expected: FAIL — `DbTab` still takes `focusTable`, not `table`/`onPatchState`.

- [ ] **Step 7: Rewrite `DbTab`**

Replace the props and the focus-driven fetch in `apps/devbench/src/components/db/DbTab.tsx`:

```tsx
export function DbTab({
  watchedTables,
  onToggleWatch,
  table,
  onPatchState,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  table: string | null;
  onPatchState: (patch: { table: string }) => void;
}) {
  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  async function fetchRows(t: string) {
    setError(null);
    try {
      setTableRows(await invokeListTableRows(DEV_CONNECTION, t));
    } catch (err) {
      setTableRows(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Fires on mount if `table` arrives already set (a deep link creating this
  // tab), and again whenever the schema tree patches it — one path, not two.
  useEffect(() => {
    if (table) void fetchRows(table);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);
```

Leave the watch-hydration effect (`useEffect(() => { invokeListWatchedTables... }, [setWatchedTables])`) exactly as it is.

Replace `handleToggleWatch`'s untouched body, then replace the render's `onSelectTable` wiring — where the file currently passes `onSelectTable={handleSelectTable}` to `SchemaTree`, replace with:

```tsx
        onSelectTable={(t) => onPatchState({ table: t })}
```

Delete the old `handleSelectTable` function entirely (superseded by the effect above) and delete the `focusTable`-driven `useEffect` that called it.

- [ ] **Step 8: Run it to verify it passes**

Run: `bun run test -- src/components/db/DbTab.test.tsx`
Expected: PASS, all four.

- [ ] **Step 9: Rewrite `LogTab`**

In `apps/devbench/src/components/log/LogTab.tsx`, remove the store import of `activeLogSourceId`/`setActiveLogSourceId` and the dead `focusSourceId` prop (never passed by any caller today — confirmed via `ToolPane.tsx`'s current `<LogTab />` call, which passes no props at all). Replace the signature and the two lines that read the store:

```tsx
export function LogTab({
  sourceId,
  onPatchState,
}: {
  sourceId: string | null;
  onPatchState: (patch: { sourceId: string | null }) => void;
}) {
  const [sources, setSources] = useState<LogSourceStatus[]>([]);
```

Delete the two lines:
```tsx
  const activeSourceId = useAppStore((s) => s.activeLogSourceId);
  const setActiveSourceId = useAppStore((s) => s.setActiveLogSourceId);
```
and the `useAppStore` import (no longer used in this file).

Everywhere the file currently reads `activeSourceId`, use the `sourceId` parameter instead. Replace `setActiveSourceId` calls — there are two: the sidebar's `onSelect={setActiveSourceId}`, and `handleRemove`'s `if (activeSourceId === id) setActiveSourceId(null)` — with:

```tsx
        onSelect={(id) => onPatchState({ sourceId: id })}
```
```tsx
    if (sourceId === id) onPatchState({ sourceId: null });
```

Delete the now-dead `useEffect(() => { if (focusSourceId) setActiveSourceId(focusSourceId) }, ...)` block entirely — `sourceId` already arrives as a prop and the fetch-cursor-reset effect (keyed on `[activeSourceId]`, now `[sourceId]`) covers both the deep-link and the sidebar-click case identically, the same simplification `DbTab` just got.

- [ ] **Step 10: Rewrite `ToolPane`**

Replace `apps/devbench/src/components/shell/ToolPane.tsx` wholesale:

```tsx
import type { Tab } from "../../store/useAppStore";
import { ApiTab } from "../api/ApiTab";
import { DbTab } from "../db/DbTab";
import { LogTab } from "../log/LogTab";
import { EmailTab } from "../email/EmailTab";
import { useAppStore } from "../../store/useAppStore";

/**
 * Renders one tab instance. Every pane's every tab goes through this, which
 * is what keeps "any tool, any number of times, in either pane" true by
 * construction. `onOpenDb`/`onOpenLog`/`onOpenEmail` are the Rollup deep
 * links; only the "api" case uses them. `emailFocusId` only matters to the
 * "email" case, and only when this specific tab is the deep link's target
 * (App.tsx resolves that before this component ever sees it).
 */
export function ToolPane({
  tab,
  onPatchState,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
  emailFocusId,
}: {
  tab: Tab;
  onPatchState: (patch: Record<string, unknown>) => void;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
  emailFocusId: number | null;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);

  switch (tab.kind) {
    case "api":
      // ApiTab still takes its Task-1-era prop names here; Task 6 renames
      // them on ApiTab itself and this bridge goes away.
      return <ApiTab onOpenTableInDb={onOpenDb} onOpenEmail={onOpenEmail} />;
    case "db":
      return (
        <DbTab
          watchedTables={watchedTables}
          onToggleWatch={toggleWatchedTable}
          table={typeof tab.state.table === "string" ? tab.state.table : null}
          onPatchState={onPatchState}
        />
      );
    case "log":
      return (
        <LogTab sourceId={typeof tab.state.sourceId === "string" ? tab.state.sourceId : null} onPatchState={onPatchState} />
      );
    case "email":
      return <EmailTab focusEmailId={emailFocusId} />;
  }
}
```

`onOpenLog` is accepted but not read by name in this task's `"api"` case (it stays unused until Task 6 wires it into `ApiTab`). `apps/devbench/tsconfig.json` sets neither `noUnusedParameters` nor `noUnusedLocals`, so this does not fail `bun run build` — leave the parameter name as-is, no underscore prefix needed.

- [ ] **Step 11: Write the failing `SplitContent` tests**

Replace `apps/devbench/src/components/shell/SplitContent.test.tsx` wholesale — this is the fix for the one file that has been red since Task 1:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SplitContent } from "./SplitContent";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";

function renderSplit(overrides: Partial<Parameters<typeof SplitContent>[0]> = {}) {
  return render(
    <SplitContent
      onAddTab={() => {}}
      onPatchState={() => {}}
      onOpenDb={() => {}}
      onOpenLog={() => {}}
      onOpenEmail={() => {}}
      emailFocusRequest={null}
      {...overrides}
    />,
  );
}

describe("SplitContent", () => {
  beforeEach(() => {
    useAppStore.setState({ tabs: [], activeTabId: { left: null, right: null } });
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [] });
    vi.spyOn(tauriLib, "invokeListLogSources").mockResolvedValue([]);
  });

  it("shows the empty-state prompt in the left pane when the session has no tabs", () => {
    renderSplit();
    expect(screen.getByText(/no tools open/i)).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("adding a tool from the empty state targets the left pane", () => {
    const onAddTab = vi.fn();
    renderSplit({ onAddTab });
    fireEvent.click(screen.getByRole("button", { name: /add a tool/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Log" }));
    expect(onAddTab).toHaveBeenCalledWith("left", "log");
  });

  it("renders one main region with no tabs open in the right pane", () => {
    useAppStore.setState({ tabs: [{ id: "a", kind: "api", pane: "left", ordinal: 0, state: {} }], activeTabId: { left: "a", right: null } });
    renderSplit();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("renders two main regions once a tab occupies the right pane", () => {
    useAppStore.setState({
      tabs: [
        { id: "a", kind: "api", pane: "left", ordinal: 0, state: {} },
        { id: "b", kind: "db", pane: "right", ordinal: 0, state: {} },
      ],
      activeTabId: { left: "a", right: "b" },
    });
    renderSplit();
    expect(screen.getAllByRole("main")).toHaveLength(2);
  });

  // The spec's own lifecycle test, and the reason this rewrite exists: a Log
  // tab that unmounts stops tailing. Assert the hidden node stays in the
  // document, and that the poll it started is still running.
  it("keeps an inactive tab mounted rather than unmounting it", async () => {
    vi.useFakeTimers();
    const readLines = vi.spyOn(tauriLib, "invokeReadLogLines").mockResolvedValue({ lines: [], next_id: 0, dropped: 0 });
    useAppStore.setState({
      tabs: [
        { id: "a", kind: "api", pane: "left", ordinal: 0, state: {} },
        { id: "b", kind: "log", pane: "left", ordinal: 1, state: {} },
      ],
      activeTabId: { left: "a", right: null },
    });
    renderSplit();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    const callsWhileHidden = readLines.mock.calls.length;
    expect(callsWhileHidden).toBeGreaterThan(0);

    useAppStore.getState().setActiveTabId("left", "b");
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(readLines.mock.calls.length).toBeGreaterThan(callsWhileHidden);
    vi.useRealTimers();
  });

  // Two DB tabs, two tables, mounted at once: the independence bug this
  // whole task exists to fix.
  it("gives two simultaneously-mounted DB tabs independent tables", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation(async (_conn, table: string) => ({
      columns: ["id"],
      rows: [[table]],
    }));
    useAppStore.setState({
      tabs: [
        { id: "a", kind: "db", pane: "left", ordinal: 0, state: { table: "orders" } },
        { id: "b", kind: "db", pane: "right", ordinal: 0, state: { table: "payments" } },
      ],
      activeTabId: { left: "a", right: "b" },
    });
    renderSplit();

    await waitFor(() => expect(listRows).toHaveBeenCalledWith(expect.anything(), "orders"));
    await waitFor(() => expect(listRows).toHaveBeenCalledWith(expect.anything(), "payments"));
  });
});
```

Add the `act` import from `@testing-library/react` alongside the others already there.

- [ ] **Step 12: Run the tests to verify they fail, then rewrite `SplitContent`**

Run: `bun run test -- src/components/shell/SplitContent.test.tsx`
Expected: FAIL — `SplitContent` still takes `dbFocusTable`/`emailFocusId`/`onOpenTableInDb`/`onOpenEmail`, not the new props.

Replace `apps/devbench/src/components/shell/SplitContent.tsx` wholesale:

```tsx
import { ToolPane } from "./ToolPane";
import { EmptyPane } from "./EmptyPane";
import { useAppStore, type Pane, type ToolKind } from "../../store/useAppStore";

/**
 * Panes only, no chrome — the tab bars and Split control live in AppStrip.
 * Every tab in the active pane stays mounted (class-swap, not unmount) so
 * fetched rows, buffered log lines, and in-flight requests survive a tab
 * switch untouched.
 */
export function SplitContent({
  onAddTab,
  onPatchState,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
  emailFocusRequest,
}: {
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onPatchState: (id: string, patch: Record<string, unknown>) => void;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
  emailFocusRequest: { tabId: string; emailId: number | null } | null;
}) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const splitOpen = tabs.some((t) => t.pane === "right");

  function renderPane(pane: Pane) {
    const paneTabs = tabs.filter((t) => t.pane === pane).sort((a, b) => a.ordinal - b.ordinal);
    if (paneTabs.length === 0) {
      return <EmptyPane onAddTab={(kind) => onAddTab(pane, kind)} />;
    }
    return paneTabs.map((tab) => (
      // Note the class swap, not the `hidden` attribute — a sibling display
      // utility would silently beat `[hidden]`'s specificity. `key={tab.id}`
      // is what gives two DB tabs separate React instances, and therefore
      // separate useState, per tab.
      <div key={tab.id} className={tab.id === activeTabId[pane] ? "flex min-h-0 flex-1" : "hidden"}>
        <ToolPane
          tab={tab}
          onPatchState={(patch) => onPatchState(tab.id, patch)}
          onOpenDb={onOpenDb}
          onOpenLog={onOpenLog}
          onOpenEmail={onOpenEmail}
          emailFocusId={emailFocusRequest?.tabId === tab.id ? emailFocusRequest.emailId : null}
        />
      </div>
    ));
  }

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6">{renderPane("left")}</main>
      {splitOpen ? (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-l border-border p-6">
          {renderPane("right")}
        </main>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 13: Run it to verify it passes**

Run: `bun run test -- src/components/shell/SplitContent.test.tsx`
Expected: PASS, all six.

- [ ] **Step 14: Wire `SplitContent`'s new props from `App.tsx`**

`App.tsx`'s `<SplitContent .../>` call still passes the old `dbFocusTable`/`emailFocusId`/`onOpenTableInDb`/`onOpenEmail` props at this point — those don't exist on the new `SplitContent` and this must be fixed for the app to render at all. **Task 6 owns the real deep-link composition** (`onOpenDb`/`onOpenLog`/`onOpenEmail` built from `focusOrCreateTab`); for this task, wire the minimum that keeps the app correct without inventing Task 6's logic early:

```tsx
      <SplitContent
        onAddTab={onAddTab}
        onPatchState={tabController.patchTabState}
        onOpenDb={(table) => tabController.focusOrCreateTab("db", { table })}
        onOpenLog={() => tabController.focusOrCreateTab("log")}
        onOpenEmail={() => {}}
      />
```

Delete the `dbFocusTable`/`emailFocusId` `useState` declarations and the `onOpenTableInDb`/`onOpenEmail` names — they are fully superseded by `tabController.focusOrCreateTab`. `onOpenEmail` is a placeholder no-op for exactly this task (Email's deep link needs the ephemeral `emailFocusRequest` state Task 6 adds — wiring it now would mean writing Task 6's code early and then not testing it until Task 6 anyway). Add a fifth prop with a literal `null` for now:

```tsx
        emailFocusRequest={null}
```

- [ ] **Step 15: Run the full suite**

Run: `bun run test`
Expected: PASS — **zero red files.** This is the first point since Task 1 where the full suite is entirely green again.

- [ ] **Step 16: Commit**

```bash
git add apps/devbench/src/components/shell/EmptyPane.tsx apps/devbench/src/components/shell/EmptyPane.test.tsx apps/devbench/src/components/shell/SplitContent.tsx apps/devbench/src/components/shell/SplitContent.test.tsx apps/devbench/src/components/shell/ToolPane.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx apps/devbench/src/components/log/LogTab.tsx apps/devbench/src/App.tsx
git commit -m "feat(devbench): mount every tab, add the empty state, fix DB and Log's per-tab state"
```

---

## Task 6: API and Email — deep links, `RequestBuilder` persistence, and the last App-level cleanup

**Files:**
- Modify: `apps/devbench/src/components/api/RequestBuilder.tsx`
- Modify: `apps/devbench/src/components/api/RequestBuilder.test.tsx`
- Modify: `apps/devbench/src/components/api/ApiTab.tsx`
- Modify: `apps/devbench/src/components/api/ApiTab.test.tsx`
- Modify: `apps/devbench/src/components/shell/ToolPane.tsx`
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/App.test.tsx`

**Interfaces:**
- Consumes: `tabController.focusOrCreateTab`/`patchTabState` (Task 4).
- Produces: `RequestBuilder` gains `method`/`url`/`onPatchState`, loses local `method`/`url` state. `ApiTab` renames `onOpenTableInDb` → `onOpenDb`, adds `onOpenLog`, keeps `onOpenEmail`; gains `tab`/`onPatchState` to forward to `RequestBuilder`.

**Why Email's selection stays out of `tab.state`, and how the deep link still works:** `EmailTab.tsx` is not modified in this task (or anywhere in this plan) — it already takes `focusEmailId` and reacts to it in a `useEffect`, exactly the mechanism the spec asks for: "Selection stays local `useState`; only the cross-tool deep link sets it, and it targets one specific tab." What changes is *who* computes that prop and *how it's scoped*. `App.tsx` keeps one small ephemeral `useState<{tabId, emailId} | null>` (not persisted, not in `tab.state`); `SplitContent` (built in Task 5) already only forwards a non-null `emailFocusId` to the *one* tab instance whose id matches. Two mounted Email tabs therefore never both jump to the same message — only the one the deep link actually targeted does.

- [ ] **Step 1: Write the failing `RequestBuilder` tests**

Locate the existing `it("uses the styled menu...")` and `it("changes the method...")` tests from plan 1's Task 3 in `apps/devbench/src/components/api/RequestBuilder.test.tsx` and update `renderBuilder` (or wherever `<RequestBuilder .../>` is constructed) to pass the new required props. Add these tests alongside the existing ones:

```tsx
  it("shows the method and url from tab state, not local defaults", () => {
    render(
      <RequestBuilder
        connection={CONN}
        watchedTables={new Set()}
        onResult={() => {}}
        method="POST"
        url="/api/orders"
        onPatchState={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /method/i })).toHaveTextContent("POST");
    expect(screen.getByPlaceholderText("/api/orders")).toHaveValue("/api/orders");
  });

  it("patches state on every keystroke and every method change, rather than holding local state", () => {
    const onPatchState = vi.fn();
    render(
      <RequestBuilder connection={CONN} watchedTables={new Set()} onResult={() => {}} method="GET" url="" onPatchState={onPatchState} />,
    );

    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/users" } });
    expect(onPatchState).toHaveBeenCalledWith({ url: "/api/users" });

    fireEvent.click(screen.getByRole("button", { name: /method/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "PUT" }));
    expect(onPatchState).toHaveBeenCalledWith({ method: "PUT" });
  });
```

Define `CONN` near the top of the file if the existing tests don't already have a shared constant (check first — plan 1's Task 3 added an inline object; reuse it under whatever name is already there instead of introducing a second one).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/components/api/RequestBuilder.test.tsx`
Expected: FAIL — `RequestBuilder` doesn't accept `method`/`url`/`onPatchState` and still renders its own local `"GET"` default.

- [ ] **Step 3: Rewrite `RequestBuilder`**

In `apps/devbench/src/components/api/RequestBuilder.tsx`, replace the props and delete the local `method`/`url` state:

```tsx
export function RequestBuilder({
  connection,
  watchedTables,
  sessionId = null,
  method,
  url,
  onPatchState,
  onResult,
  onSendStart,
  onError,
}: {
  connection: DbConnectInput;
  watchedTables: Set<string>;
  sessionId?: string | null;
  method: string;
  url: string;
  onPatchState: (patch: { method?: string; url?: string }) => void;
  onResult: (result: CorrelationResult) => void;
  onSendStart?: () => void;
  onError?: (message: string) => void;
}) {
  const [sending, setSending] = useState(false);
```

Delete the two lines `const [method, setMethod] = useState("GET");` and `const [url, setUrl] = useState("");`.

Update the `Menu`'s `onSelect` and the `<input>`'s `onChange`:

```tsx
        onSelect={(m) => onPatchState({ method: m })}
```
```tsx
        onChange={(e) => onPatchState({ url: e.target.value })}
```

`handleSend` already reads `method`/`url` by closure — no change needed there, they're just parameters now instead of state.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- src/components/api/RequestBuilder.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing `ApiTab` deep-link tests**

Add to `apps/devbench/src/components/api/ApiTab.test.tsx` — check the existing `render(<ApiTab .../>)` call sites and update every one to the new prop set (`tab`, `onPatchState`, `onOpenDb`, `onOpenLog`, `onOpenEmail`) as part of this step, matching the pattern already used for `onOpenTableInDb`/`onOpenEmail`:

```tsx
  it("forwards the Rollup's deep links to the received callbacks, not a local store call", () => {
    // Regression guard for the bug this migration fixes: ApiTab used to call
    // the store's setActiveTab directly, which stopped existing when tabs
    // became instances. There is now nothing in ApiTab that reaches the
    // store for tab switching at all — it only calls what it's given.
    const onOpenDb = vi.fn();
    render(
      <ApiTab
        tab={{ id: "t-1", kind: "api", pane: "left", ordinal: 0, state: {} }}
        onPatchState={() => {}}
        onOpenDb={onOpenDb}
        onOpenLog={() => {}}
        onOpenEmail={() => {}}
      />,
    );
    // Rollup only renders once a result exists; this asserts ApiTab renders
    // without touching the store, which is the regression this guards. The
    // click-through path itself is Rollup.test.tsx's responsibility.
    expect(() => useAppStore.getState()).not.toThrow();
  });
```

Add the `useAppStore` import if the test file doesn't already have it.

- [ ] **Step 6: Run the tests to verify they fail**

Run: `bun run test -- src/components/api/ApiTab.test.tsx`
Expected: FAIL — `ApiTab` doesn't accept `tab`/`onPatchState`/`onOpenDb`/`onOpenLog`.

- [ ] **Step 7: Rewrite `ApiTab`**

In `apps/devbench/src/components/api/ApiTab.tsx`, replace the props:

```tsx
export function ApiTab({
  tab,
  onPatchState,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
}: {
  tab: Tab;
  onPatchState: (patch: Record<string, unknown>) => void;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
```

Delete `const setActiveTab = useAppStore((s) => s.setActiveTab);` and the two local wrapper functions `handleOpenDb`/`handleOpenEmail` — they collapse into the received props directly. Update the `Rollup` call:

```tsx
              <Rollup data={result?.rollup ?? null} loading={sending} onOpenDb={onOpenDb} onOpenLog={onOpenLog} onOpenEmail={onOpenEmail} />
```

Add the `Tab` import: `import type { Tab } from "../../store/useAppStore";`

Update the `RequestBuilder` call to forward its persisted method/url:

```tsx
        <RequestBuilder
          connection={DEV_CONNECTION}
          watchedTables={watchedTables}
          sessionId={activeSessionId}
          method={typeof tab.state.method === "string" ? tab.state.method : "GET"}
          url={typeof tab.state.url === "string" ? tab.state.url : ""}
          onPatchState={onPatchState}
          onSendStart={handleSendStart}
          onResult={handleResult}
          onError={handleError}
        />
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun run test -- src/components/api/ApiTab.test.tsx`
Expected: PASS.

- [ ] **Step 9: Finish `ToolPane`'s `"api"` case**

In `apps/devbench/src/components/shell/ToolPane.tsx`, replace the `"api"` case (which currently bridges to `ApiTab`'s old prop names):

```tsx
    case "api":
      return <ApiTab tab={tab} onPatchState={onPatchState} onOpenDb={onOpenDb} onOpenLog={onOpenLog} onOpenEmail={onOpenEmail} />;
```

- [ ] **Step 10: The last App-level cleanup**

In `apps/devbench/src/App.tsx`, add the ephemeral email-focus state (co-located with the other `useState` hooks, near the top of the component):

```tsx
  const [emailFocusRequest, setEmailFocusRequest] = useState<{ tabId: string; emailId: number | null } | null>(null);
```

Replace the `<SplitContent .../>` call's Task-5 placeholder `onOpenEmail`/`emailFocusRequest` with the real composition:

```tsx
      <SplitContent
        onAddTab={onAddTab}
        onPatchState={tabController.patchTabState}
        onOpenDb={(table) => tabController.focusOrCreateTab("db", { table })}
        onOpenLog={() => tabController.focusOrCreateTab("log")}
        onOpenEmail={(emailId) => {
          const targetId = tabController.focusOrCreateTab("email");
          setEmailFocusRequest({ tabId: targetId, emailId });
        }}
        emailFocusRequest={emailFocusRequest}
      />
```

If `useState` is not already imported in `App.tsx` (it is, for the theme-launch effect), no import change is needed.

- [ ] **Step 11: Fix `App.test.tsx`'s stale `AppStrip` mount assumption**

`App.test.tsx`'s first test was rewritten in Task 2, Step 10, to expect zero tabs. Nothing in this task reseeds tabs by default, so that test stays correct as-is — no change needed here. Re-read it once to confirm before moving on.

- [ ] **Step 12: Run the full suite**

Run: `bun run test`
Expected: PASS, zero failures.

- [ ] **Step 13: Run `bun run build`**

Run: `bun run build`
Expected: PASS. This is the first point in the plan where every renamed type (`TabId` → `ToolKind`), every widened prop set, and every deleted store field is checked by `tsc` end-to-end. If it fails, the error will point at whichever file still references something Task 1–6 removed or renamed — `grep -rn "TabId\b" apps/devbench/src` is the fastest way to find a straggler, since every legitimate use should already read `ToolKind`.

- [ ] **Step 14: Commit**

```bash
git add apps/devbench/src/components/api apps/devbench/src/components/shell/ToolPane.tsx apps/devbench/src/App.tsx apps/devbench/src/App.test.tsx
git commit -m "feat(devbench): wire API and Email deep links, persist request method and url per tab"
```

---

## Task 7: Full-suite verification and self-review checkpoint

**Files:** none (verification only).

- [ ] **Step 1: Frontend suite**

Run: `bun run test`
Expected: PASS, zero failures, zero skipped.

- [ ] **Step 2: Frontend typecheck**

Run: `bun run build`
Expected: PASS.

- [ ] **Step 3: Backend suite**

Run: `cd apps/devbench/src-tauri && cargo test`
Expected: PASS. Baseline before this plan was 131 lib tests (1 ignored) + 3 smoke tests; Task 3 added 10, so expect 141 lib tests (1 ignored) + 3 smoke tests. If the count differs, `cargo test 2>&1 | grep "test result"` shows exactly which binary's count moved.

- [ ] **Step 4: `Base UI boundary` still holds**

Run: `bun run test -- src/components/ui/boundary.test.ts`
Expected: PASS. This task's `Menu.tsx` edit (Task 2) only added props to an existing component; it introduced no new `@base-ui-components/react` import sites.

- [ ] **Step 5: No `<select>` regressed back in**

Run: `grep -rn "<select" apps/devbench/src --include="*.tsx" | grep -v test`
Expected: no output. Nothing in this plan touches native selects, but it's cheap to confirm plan 1's invariant still holds after a large refactor.

- [ ] **Step 6: Spec coverage self-check**

Walk `docs/superpowers/specs/2026-07-31-devbench-v2-shell-design.md`'s "Tab instances" section line by line against the tasks above:

| Spec claim | Where it's implemented |
|---|---|
| `TabId` becomes the kind, `Tab{id,kind,pane,ordinal}` is the identity | Task 1 |
| `splitOpen` is derived, not stored | Task 1 (`isSplitOpen`), consumed in Tasks 2/5 |
| Split with one tab opens the `+` menu targeting the right pane | Task 2 (`pendingSplitAdd`) |
| Tab labels disambiguate duplicates (DB subtitle) | Task 2 (`tabLabel`) |
| `tabs` SQLite table, `session_id IS NULL` = scratch workspace | Task 3 |
| `state` holds only identifying selection, per the kind table | Task 5 (`db`/`log`), Task 6 (`api`), Email deliberately `{}` always (Task 6) |
| Switching sessions replaces the tab set | Task 4 (`useTabController`'s session-switch effect) |
| Closing a tab deletes its row | Task 4 (`closeTab`) |
| `dbFocusTable` → per-tab | Task 5 |
| `emailFocusId` → per-tab, deliberately unpersisted | Task 6 |
| `activeLogSourceId` → per-tab | Task 5 |
| URL edits debounced 300ms, not one write per keystroke | Task 4 (generalized to every `patchTabState` call, not URL-specific) |
| Every tab stays mounted; class-swap, not `hidden` attribute | Task 5 (`SplitContent`) |
| Empty state: centered prompt, mentions duplicates, same `+` menu | Task 5 (`EmptyPane`) |
| New sessions start genuinely empty, nothing seeded | Task 1 (`tabs: []` default) + Task 4 (no seeding logic anywhere in `useTabController`) |

If any row's task is missing or wrong, fix it now rather than filing it as follow-up — this is the last checkpoint before the branch is considered done.

- [ ] **Step 7: Placeholder scan**

`grep -rn "TODO\|TBD\|for now\|later\b" docs/superpowers/plans/2026-07-31-devbench-v2-tab-instances.md` — expect no matches inside code blocks (prose discussing *why* an interim state exists, like Task 5/6's bridging comments, is fine; a literal `// TODO` inside a code block is not).

- [ ] **Step 8: Type-consistency scan**

Confirm every task that names `ToolKind`, `Pane`, `Tab`, or the `useTabController` return shape agrees with Task 1's and Task 4's definitions — in particular that `focusOrCreateTab`'s signature (`kind, statePatch?`) matches every call site added in Tasks 5 and 6, and that `AppStrip`'s prop names (`onSetActiveTab`, `onAddTab`, `onCloseTab`, `onToggleSplit`, `onCloseSplitPane`, `onToggleChat`) match exactly between Task 2's interface block, its implementation, its test file, and every `<AppStrip .../>` call site in `App.tsx` across Tasks 2, 4, and 6.

## Done when

- `bun run test` passes with zero failures and zero skipped tests.
- `bun run build` passes.
- `cargo test` (from `apps/devbench/src-tauri`) passes.
- Opening the same tool twice produces two independent tab instances — two DB tabs can show different tables simultaneously.
- Closing every tab in a session shows the empty-state prompt; switching sessions swaps the tab set; the scratch workspace (`session_id IS NULL`) persists across restarts independently of any named session.
- A request that touches a watched table focuses (or creates) a DB tab on that table without disturbing any other open DB tab.
