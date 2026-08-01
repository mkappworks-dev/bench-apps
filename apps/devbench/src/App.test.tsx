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
  active_session_id: null,
};

describe("App shell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the three-column workspace", () => {
    render(<App />);
    expect(screen.getByRole("complementary", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "AI Assistant" })).toBeInTheDocument();
    // No tabs open yet — Task 5 covers the empty-state prompt this produces.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
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

  // The brand sits in both routes' top strips at the same offset, so navigating
  // into Settings must not drop it — that would read as the lockup flickering.
  it("keeps the brand lockup in the top strip on both routes", () => {
    const { unmount } = render(<App />);
    expect(screen.getByText("Dev Bench")).toBeInTheDocument();
    unmount();

    useAppStore.getState().setRoute("settings");
    render(<App />);
    expect(screen.getByText("Dev Bench")).toBeInTheDocument();
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

  // Bug: cycleTheme() only called setTheme locally, with no backend
  // persistence — so changing the theme was silently lost on restart. The
  // control moved to Settings > Appearance, but the bug class is identical.
  it("persists the theme when changed from Settings", async () => {
    // Resolve the mount-time hydration to "light" (distinct from the "dark"
    // default) and wait for it to land before clicking, so the hydration
    // effect's setTheme() can't race with — and clobber — the click's.
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({ ...settings, theme: "light" });
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
    const setSetting = vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);

    render(<App />);
    await waitFor(() => expect(useAppStore.getState().theme).toBe("light"));

    fireEvent.click(screen.getByRole("button", { name: /^settings$/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));

    fireEvent.click(screen.getByRole("button", { name: /theme/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "System" }));

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("theme", "system"));
    // The theme must actually be applied, not just stored.
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    useAppStore.getState().setTheme("dark");
  });
});
