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

function isValidPane(pane: string): pane is Pane {
  return pane === "left" || pane === "right";
}

// Keyed by `ToolKind`, not an array, so a sixth kind fails to compile here instead of silently losing its tabs on restart.
const RENDERABLE_KINDS: Record<ToolKind, true> = { api: true, db: true, log: true, email: true, query: true };

// ToolPane's switch has no default case (React throws on a bad kind), so an unrenderable row must be filtered here first.
function hydrateTab(row: TabRow): Tab | null {
  if (!Object.hasOwn(RENDERABLE_KINDS, row.kind)) return null;
  if (!isValidPane(row.pane)) return null;
  return { id: row.id, kind: row.kind as ToolKind, pane: row.pane, ordinal: row.ordinal, state: parseState(row.state) };
}

// Call exactly once, at the top of the tree — the session-switch effect below issues one invokeListTabs per mount, and a second instance would race it.
export function useTabController() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const addTabInStore = useAppStore((s) => s.addTab);
  const closeTabInStore = useAppStore((s) => s.closeTab);
  const patchTabStateInStore = useAppStore((s) => s.patchTabState);
  const setActiveTabIdInStore = useAppStore((s) => s.setActiveTabId);
  const splitActiveTabInStore = useAppStore((s) => s.splitActiveTab);
  const closeSplitInStore = useAppStore((s) => s.closeSplit);
  const replaceTabs = useAppStore((s) => s.replaceTabs);

  const writeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    let cancelled = false;
    void invokeListTabs(activeSessionId)
      .then((rows) => {
        if (!cancelled) replaceTabs(rows.map(hydrateTab).filter((t): t is Tab => t !== null));
      })
      .catch(() => {
        // A failed read (locked DB, IPC error) is not evidence of zero tabs; replacing
        // with [] would wipe a stale-but-real tab set and render as "No tools open".
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
        // Current full state at flush time, not the patch that scheduled this timer — coalesced edits must write the latest value.
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

  // Query tabs need `match` — two saved queries are two tabs, so a kind-only search would focus whichever came first.
  function focusOrCreateTab(
    kind: ToolKind,
    statePatch?: Record<string, unknown>,
    match?: (tab: Tab) => boolean,
  ): string {
    const candidates = useAppStore
      .getState()
      .tabs.filter((t) => t.kind === kind && (match ? match(t) : true));
    const existing = candidates.find((t) => t.pane === "left") ?? candidates[0];
    if (existing) {
      setActiveTabIdInStore(existing.pane, existing.id);
      // Found BY its state, so patching here would rewrite what was just matched on — deep links pass no matcher and still patch.
      if (statePatch && !match) patchTabState(existing.id, statePatch);
      return existing.id;
    }
    return addTab(kind, "left", statePatch ?? {});
  }

  return { addTab, closeTab, setActiveTabId: setActiveTabIdInStore, patchTabState, splitActiveTab, closeSplit, focusOrCreateTab };
}
