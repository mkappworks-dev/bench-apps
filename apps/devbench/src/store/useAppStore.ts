import { create } from "zustand";

export type TabId = "api" | "db" | "log";
export type ThemePref = "dark" | "light" | "system";

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
}));
