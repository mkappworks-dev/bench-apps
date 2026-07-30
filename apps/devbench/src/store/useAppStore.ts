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
