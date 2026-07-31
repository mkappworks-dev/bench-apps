import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import App from "./App";
import { useAppStore } from "./store/useAppStore";
import * as tauriLib from "./lib/tauri";

const settings = {
  theme: "dark",
  correlation_window_ms: 5000,
  smtp_port: 1025,
  provider: "anthropic",
  model: "claude-opus-5",
};

describe("App shell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the three-column workspace with one tab per tool", () => {
    render(<App />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["API", "DB", "Log", "Email"]);
    expect(screen.getByRole("complementary", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "AI Assistant" })).toBeInTheDocument();
  });

  it("hides the chat dock when it is toggled off, without overlaying the content", () => {
    useAppStore.getState().setChatOpen(false);
    render(<App />);
    expect(screen.queryByRole("complementary", { name: "AI Assistant" })).not.toBeInTheDocument();
    useAppStore.getState().setChatOpen(true);
  });

  it("navigates to the settings screen", () => {
    useAppStore.getState().setRoute("settings");
    render(<App />);
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab").map((t) => t.textContent)).not.toContain("Email");
    useAppStore.getState().setRoute("workspace");
  });

  // Bug: watchedTables only ever hydrated inside DbTab, which only mounts
  // once the user visits the DB tab. A request fired from the default "api"
  // tab before that would correlate against an empty watch set even though
  // real watched tables are persisted in SQLite. App itself must hydrate
  // this on mount so the default tab is never out of sync with storage.
  it("hydrates watched tables on mount even while the default api tab is active", async () => {
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(settings);
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue(["orders", "users"]);

    render(<App />);

    await waitFor(() => {
      const watched = useAppStore.getState().watchedTables;
      expect(watched.has("orders")).toBe(true);
      expect(watched.has("users")).toBe(true);
    });

    useAppStore.getState().setWatchedTables([]);
  });

  // Bug: nothing at the app level ever called invokeGetSettings, so a
  // previously-persisted theme only became visible again once the user
  // navigated into Settings > General.
  it("hydrates the theme from persisted settings on mount", async () => {
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({ ...settings, theme: "light" });
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => expect(useAppStore.getState().theme).toBe("light"));

    useAppStore.getState().setTheme("dark");
  });

  // Bug: cycleTheme() (the TopBar button) only called setTheme locally, with
  // no backend persistence — so cycling the theme from the app's most common
  // entry point was silently lost on restart.
  it("persists the theme when cycled from the TopBar button", async () => {
    // Resolve the mount-time hydration to "light" (distinct from the "dark"
    // default) and wait for it to land before clicking, so the hydration
    // effect's setTheme() can't race with — and clobber — the click's.
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({ ...settings, theme: "light" });
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
    const setSetting = vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);

    render(<App />);
    await waitFor(() => expect(useAppStore.getState().theme).toBe("light"));

    // THEME_CYCLE is ["system", "dark", "light"]; from "light" the next is "system".
    fireEvent.click(screen.getByRole("button", { name: /theme:/i }));

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("theme", "system"));

    useAppStore.getState().setTheme("dark");
  });
});
