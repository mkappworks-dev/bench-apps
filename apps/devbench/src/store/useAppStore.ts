import { create } from "zustand";
import type { QualifiedTable } from "../lib/tauri";
import type { ColumnInfo } from "../components/db/grid/columnMeta";
import { tableKey } from "../lib/tableIdentity";
import {
  discardAt,
  removeEntries,
  stageUpdate,
  toggleDelete,
  type PendingChange,
  type UpdateChange,
} from "../lib/pendingChanges";

export type ToolKind = "api" | "db" | "log" | "email";
export type Pane = "left" | "right";
export type ThemePref = "dark" | "light" | "system";
export type AppRoute = "workspace" | "settings";
export type SettingsPane = "general" | "appearance" | "provider" | "connections" | "mcp" | "archive";
/** Spec §1: the right dock holds one of three occupants at a time. Closing a
 *  panel returns to chat; `chatOpen` still governs whether the dock is open at
 *  all, so AppStrip's existing toggle keeps working unchanged. */
export type DockPanel = "chat" | "pending" | "insert";

/** What the Insert panel builds its form from. Published by the toolbar button
 *  that opens the panel, because the dock renders outside `SplitContent` and
 *  cannot reach into a tab's state. Switching tables afterwards does NOT
 *  retarget an open panel: a staged insert belongs to the table it was written
 *  for, and the panel's head names it. */
export interface InsertTarget {
  connectionId: string;
  table: QualifiedTable;
  columns: ColumnInfo[];
}

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
  /** The same watch set as `watchedTables`, kept as real `QualifiedTable`
   *  objects rather than derived `"schema.name"` keys — for wire payloads
   *  (e.g. `run_correlated_request`) that need the actual identity, not a
   *  string a Postgres identifier could legally contain a dot inside. */
  watchedTableList: QualifiedTable[];
  toggleWatchedTable: (table: QualifiedTable) => void;
  /** Replaces watch state wholesale, e.g. after loading it from SQLite. */
  setWatchedTables: (tables: QualifiedTable[]) => void;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  dockPanel: DockPanel;
  setDockPanel: (panel: DockPanel) => void;
  insertTarget: InsertTarget | null;
  setInsertTarget: (target: InsertTarget | null) => void;
  /** True from the moment Apply is sent until its outcome has been reported.
   *  Apply is the one round trip left in the write path, so it is the one
   *  place where the dock can be torn down out from under an answer that is
   *  still coming — `setChatOpen` and `setDockPanel` refuse to do that while
   *  this is set, so a conflict always has a panel to land in. */
  applyInFlight: boolean;
  setApplyInFlight: (inFlight: boolean) => void;
  /** Bumped once per Apply that actually committed. The grid lives in a tab
   *  and Apply happens in the dock, so this is how a written commit reaches
   *  every mounted DbTab — including a split pane's, whose rows are equally
   *  stale. A counter rather than a boolean: two applies in a row are two
   *  distinct events, and a flag would need resetting. */
  applyGeneration: number;
  bumpApplyGeneration: () => void;
  /** Spec §10: global, not per-tab. It can hold changes to several tables from
   *  several tabs, and Apply commits them together. */
  pending: PendingChange[];
  stagePendingUpdate: (entry: UpdateChange) => void;
  togglePendingDelete: (
    connectionId: string,
    table: QualifiedTable,
    pkColumn: string,
    pkValue: string,
  ) => void;
  addPendingInsert: (
    connectionId: string,
    table: QualifiedTable,
    values: Record<string, string | null>,
  ) => void;
  discardPendingAt: (index: number) => void;
  /** Drops exactly these entries, by identity. Apply's successful path uses
   *  it instead of `discardAllPending` so a change staged during the round
   *  trip is not thrown away with the ones that were actually written. */
  removePendingEntries: (entries: PendingChange[]) => void;
  discardAllPending: () => void;
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
  watchedTableList: [],
  toggleWatchedTable: (table) =>
    set((state) => {
      const key = tableKey(table);
      const watching = !state.watchedTables.has(key);
      const nextSet = new Set(state.watchedTables);
      if (watching) nextSet.add(key);
      else nextSet.delete(key);
      const nextList = watching
        ? [...state.watchedTableList, table]
        : state.watchedTableList.filter((t) => tableKey(t) !== key);
      return { watchedTables: nextSet, watchedTableList: nextList };
    }),
  setWatchedTables: (tables) =>
    set({
      watchedTables: new Set(tables.map(tableKey)),
      watchedTableList: tables,
    }),
  chatOpen: true,
  // Both dock setters are no-ops while an Apply is in flight, so every route
  // that could unmount the Pending panel — its own ✕, AppStrip's dock toggle,
  // the grid's Insert button — is closed by one invariant rather than by each
  // caller remembering to check. The panel's ✕ and the dock toggle also render
  // themselves disabled, so this is the floor, not the whole story.
  setChatOpen: (open) => set((s) => (s.applyInFlight && !open ? {} : { chatOpen: open })),
  dockPanel: "chat",
  setDockPanel: (dockPanel) =>
    set((s) => (s.applyInFlight && dockPanel !== "pending" ? {} : { dockPanel })),
  insertTarget: null,
  setInsertTarget: (insertTarget) => set({ insertTarget }),
  applyInFlight: false,
  setApplyInFlight: (applyInFlight) => set({ applyInFlight }),
  applyGeneration: 0,
  bumpApplyGeneration: () => set((s) => ({ applyGeneration: s.applyGeneration + 1 })),
  pending: [],
  stagePendingUpdate: (entry) => set((s) => ({ pending: stageUpdate(s.pending, entry) })),
  togglePendingDelete: (connectionId, table, pkColumn, pkValue) =>
    set((s) => ({ pending: toggleDelete(s.pending, connectionId, table, pkColumn, pkValue) })),
  // Inserts are always appended: two inserts into one table are two rows, so
  // there is nothing here to upsert against.
  addPendingInsert: (connectionId, table, values) =>
    set((s) => ({
      pending: [...s.pending, { kind: "insert", connection_id: connectionId, table, values }],
    })),
  discardPendingAt: (index) => set((s) => ({ pending: discardAt(s.pending, index) })),
  removePendingEntries: (entries) =>
    set((s) => ({ pending: removeEntries(s.pending, entries) })),
  discardAllPending: () => set({ pending: [] }),
  route: "workspace",
  // Settings replaces the entire workspace, dock included — a third way to
  // unmount the panel an Apply's outcome is coming back to, alongside the
  // dock toggle and the panel's own ✕. Same invariant, same reason.
  setRoute: (route) => set((s) => (s.applyInFlight && route !== "workspace" ? {} : { route })),
  settingsPane: "general",
  setSettingsPane: (settingsPane) => set({ settingsPane }),
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  activeConnectionId: null,
  setActiveConnectionId: (id) => set({ activeConnectionId: id }),
}));
