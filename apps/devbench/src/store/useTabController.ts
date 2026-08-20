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

/** Every kind ToolPane can render — deliberately NOT `TABS`, which is the +
 *  menu's offer list. A query tab is opened from the rail rather than created
 *  from the menu, but it still has to survive a restart like every other tab.
 *  Keyed by `ToolKind` rather than listed in an array so that adding a sixth
 *  kind fails to compile here, instead of silently dropping that kind's tabs
 *  on the next restart — the bug this constant already exists to fix once. */
const RENDERABLE_KINDS: Record<ToolKind, true> = { api: true, db: true, log: true, email: true, query: true };

// A row with an unrecognized kind/pane can't be trusted to render — ToolPane's
// switch has no default case for a bad kind (React throws), and a bad pane
// value silently drops the tab from both AppStrip and SplitContent. Rather
// than trust the cast, reject the row before it enters the store.
function hydrateTab(row: TabRow): Tab | null {
  if (!Object.hasOwn(RENDERABLE_KINDS, row.kind)) return null;
  if (!isValidPane(row.pane)) return null;
  return { id: row.id, kind: row.kind as ToolKind, pane: row.pane, ordinal: row.ordinal, state: parseState(row.state) };
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
        if (!cancelled) replaceTabs(rows.map(hydrateTab).filter((t): t is Tab => t !== null));
      })
      .catch(() => {
        // Leave the store untouched — a failed read (locked DB, IPC error) is
        // not evidence this session has zero tabs. Replacing with [] would
        // wipe a stale-but-real tab set and render as EmptyPane's "No tools
        // open", indistinguishable from genuine emptiness.
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

  /** `match` narrows the lookup past tab kind. Query tabs need it: two saved
   *  queries are two tabs, so a kind-only search would focus whichever one
   *  happened to be first regardless of which query was clicked. */
  function focusOrCreateTab(
    kind: ToolKind,
    statePatch?: Record<string, unknown>,
    match?: (tab: Tab) => boolean,
  ): string {
    const existing = useAppStore
      .getState()
      .tabs.find((t) => t.pane === "left" && t.kind === kind && (match ? match(t) : true));
    if (existing) {
      setActiveTabIdInStore("left", existing.id);
      // A `match` means the tab was found BY its state, so that state is its
      // identity — patching it here would rewrite the thing just matched on.
      // Deep links pass no matcher and still patch: focusing the DB tab and
      // aiming it at a table is the whole point there.
      if (statePatch && !match) patchTabState(existing.id, statePatch);
      return existing.id;
    }
    return addTab(kind, "left", statePatch ?? {});
  }

  return { addTab, closeTab, setActiveTabId: setActiveTabIdInStore, patchTabState, splitActiveTab, closeSplit, focusOrCreateTab };
}
