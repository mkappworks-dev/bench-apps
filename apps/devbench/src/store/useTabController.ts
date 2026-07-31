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
