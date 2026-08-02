import { create } from "zustand";

export type ToolKind = "api" | "db" | "log" | "email";
export type Pane = "left" | "right";
export type ThemePref = "dark" | "light" | "system";
export type AppRoute = "workspace" | "settings";
export type SettingsPane = "general" | "appearance" | "provider" | "connections" | "mcp" | "archive";

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
  /** Which section Settings opens on. Lives here rather than inside
   *  SettingsScreen so a deep link like the connection picker's "Manage
   *  connections…" can land on the pane it actually means. */
  settingsPane: SettingsPane;
  setSettingsPane: (pane: SettingsPane) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  activeConnectionId: string | null;
  setActiveConnectionId: (id: string | null) => void;
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
  settingsPane: "general",
  setSettingsPane: (settingsPane) => set({ settingsPane }),
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  activeConnectionId: null,
  setActiveConnectionId: (id) => set({ activeConnectionId: id }),
}));
