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
});
