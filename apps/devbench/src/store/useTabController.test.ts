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

  it("leaves the store's tabs untouched when invokeListTabs rejects, rather than wiping to empty", async () => {
    useAppStore.setState({
      tabs: [{ id: "existing", kind: "api", pane: "left", ordinal: 0, state: {} }],
      activeTabId: { left: "existing", right: null },
    });
    vi.spyOn(tauriLib, "invokeListTabs").mockRejectedValue(new Error("db locked"));
    renderHook(() => useTabController());

    // Let the rejected promise's .catch handler run.
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().tabs).toEqual([{ id: "existing", kind: "api", pane: "left", ordinal: 0, state: {} }]);
    expect(useAppStore.getState().activeTabId).toEqual({ left: "existing", right: null });
  });

  it("drops rows with an invalid kind or pane instead of hydrating them", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "good", session_id: null, kind: "db", pane: "left", ordinal: 0, state: null },
      { id: "bad-kind", session_id: null, kind: "unknown-tool", pane: "left", ordinal: 1, state: null },
      { id: "bad-pane", session_id: null, kind: "api", pane: "middle", ordinal: 2, state: null },
    ]);
    renderHook(() => useTabController());

    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["good"]);
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

  it("closeSplit persists the deletion of every right-pane tab, and none from the left", async () => {
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "left-1", session_id: null, kind: "api", pane: "left", ordinal: 0, state: null },
      { id: "right-1", session_id: null, kind: "db", pane: "right", ordinal: 0, state: null },
      { id: "right-2", session_id: null, kind: "log", pane: "right", ordinal: 1, state: null },
    ]);
    const closeTab = vi.spyOn(tauriLib, "invokeCloseTab").mockResolvedValue(undefined);
    const { result } = renderHook(() => useTabController());
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(3));

    act(() => result.current.closeSplit());

    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["left-1"]);
    await waitFor(() => expect(closeTab).toHaveBeenCalledTimes(2));
    expect(closeTab).toHaveBeenCalledWith("right-1");
    expect(closeTab).toHaveBeenCalledWith("right-2");
    expect(closeTab).not.toHaveBeenCalledWith("left-1");
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
