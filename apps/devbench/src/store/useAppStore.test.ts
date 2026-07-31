import { describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

describe("useAppStore", () => {
  it("defaults to the api tab and dark theme", () => {
    const state = useAppStore.getState();
    expect(state.activeTab).toBe("api");
    expect(state.theme).toBe("dark");
  });

  it("setActiveTab switches tabs", () => {
    useAppStore.getState().setActiveTab("db");
    expect(useAppStore.getState().activeTab).toBe("db");
  });

  it("toggleWatchedTable adds and removes a table", () => {
    useAppStore.getState().toggleWatchedTable("orders");
    expect(useAppStore.getState().watchedTables.has("orders")).toBe(true);
    useAppStore.getState().toggleWatchedTable("orders");
    expect(useAppStore.getState().watchedTables.has("orders")).toBe(false);
  });

  it("can switch to the log tab", () => {
    useAppStore.getState().setActiveTab("log");
    expect(useAppStore.getState().activeTab).toBe("log");
  });

  it("tracks the selected log source", () => {
    expect(useAppStore.getState().activeLogSourceId).toBeNull();
    useAppStore.getState().setActiveLogSourceId("src-1");
    expect(useAppStore.getState().activeLogSourceId).toBe("src-1");
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
  });
});
