import { create } from "zustand";

export type TabId = "api" | "db" | "log" | "email";
export type ThemePref = "dark" | "light" | "system";
export type AppRoute = "workspace" | "settings";

interface AppState {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  theme: ThemePref;
  setTheme: (theme: ThemePref) => void;
  watchedTables: Set<string>;
  toggleWatchedTable: (table: string) => void;
  /** Replaces watch state wholesale, e.g. after loading it from SQLite. */
  setWatchedTables: (tables: string[]) => void;
  /** Which log source the Log tab is showing; null means "all sources". */
  activeLogSourceId: string | null;
  setActiveLogSourceId: (id: string | null) => void;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  route: AppRoute;
  setRoute: (route: AppRoute) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  /** Whether the content area is split into two panes. Per-session UI state. */
  splitOpen: boolean;
  setSplitOpen: (open: boolean) => void;
  /** The tool shown in the second pane. `activeTab` remains the first pane. */
  secondaryTab: TabId;
  setSecondaryTab: (tab: TabId) => void;
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
  setWatchedTables: (tables) => set({ watchedTables: new Set(tables) }),
  activeLogSourceId: null,
  setActiveLogSourceId: (id) => set({ activeLogSourceId: id }),
  chatOpen: true,
  setChatOpen: (open) => set({ chatOpen: open }),
  route: "workspace",
  setRoute: (route) => set({ route }),
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  splitOpen: false,
  setSplitOpen: (open) => set({ splitOpen: open }),
  secondaryTab: "db",
  setSecondaryTab: (tab) => set({ secondaryTab: tab }),
}));
