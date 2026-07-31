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
