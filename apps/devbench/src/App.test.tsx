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

  it("surfaces an unresolved rollback after its query tab has closed", () => {
    useAppStore.setState({ route: "workspace", queryRollbackFailures: {
      '["c1","q1"]': { queryId: "q1", connectionId: "c1", message: "uncertain transaction" },
    } });
    render(<App />);
    expect(screen.getByRole("alert")).toHaveTextContent("uncertain transaction");
    useAppStore.setState({ queryRollbackFailures: {} });
  });

  it("keeps rollback warnings visible in settings when their query tab is active", () => {
    useAppStore.setState({ route: "settings", tabs: [{ id: "qt", kind: "query", pane: "left", ordinal: 0, state: { queryId: "q1", connectionId: "c1" } }],
      activeTabId: { left: "qt", right: null }, queryRollbackFailures: {
        '["c1","q1"]': { queryId: "q1", connectionId: "c1", message: "uncertain transaction" },
      } });
    render(<App />);
    expect(screen.getByRole("alert")).toHaveTextContent("uncertain transaction");
    useAppStore.setState({ route: "workspace", tabs: [], activeTabId: { left: null, right: null }, queryRollbackFailures: {} });
  });

  it("renders the three-column workspace", () => {
    render(<App />);
    expect(screen.getByRole("complementary", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "AI Assistant" })).toBeInTheDocument();
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
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([
      { id: "c1", name: "Local Dev", engine: "postgres", host: "localhost", port: 5432, database: "devbench_test", username: "postgres", sslmode: "disable", has_password: true },
    ]);
    const listWatched = vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([
      { schema: "public", name: "orders" },
      { schema: "public", name: "users" },
    ]);

    render(<App />);

    await waitFor(() => {
      const watched = useAppStore.getState().watchedTables;
      expect(watched.has("public.orders")).toBe(true);
      expect(watched.has("public.users")).toBe(true);
    });
    expect(listWatched).toHaveBeenCalledWith("c1");

    useAppStore.getState().setWatchedTables([]);
    useAppStore.getState().setActiveConnectionId(null);
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
    useAppStore.getState().setRoute("workspace");
  });

  // Bug: LocalDb::connect failing used to panic main.rs, so the window never
  // opened at all. Now the DB error is surfaced as app state instead, and
  // must replace the workspace with a blocking explanation rather than
  // leaving the broken shell on screen or failing silently.
  it("renders the startup error screen instead of the workspace when the database failed to initialize", async () => {
    vi.spyOn(tauriLib, "invokeGetStartupStatus").mockResolvedValue({
      db_error: {
        db_path: "/tmp/devbench-test/devbench.db",
        error: "migration 5 was previously applied but has been modified",
      },
    });
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(settings);
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => expect(screen.getByText(/couldn't start/i)).toBeInTheDocument());
    expect(
      screen.getByText("migration 5 was previously applied but has been modified"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Sessions" })).not.toBeInTheDocument();
  });

  // Fix 4 end to end: the trash button lives in the query tab's OWN rail, so
  // deleting the saved query has to take the document with it. Left open, the
  // tab's name field and editor fall back to "" and cannot accept a
  // keystroke, and the row persists in SQLite across a restart.
  it("closes a query's tab when the query is deleted from the rail, and persists the close", async () => {
    vi.spyOn(tauriLib, "invokeGetStartupStatus").mockResolvedValue({ db_error: null });
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(settings);
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListTabs").mockResolvedValue([
      { id: "qt", session_id: null, kind: "query", pane: "left", ordinal: 0, state: '{"queryId":"q1","connectionId":"c1"}' },
    ]);
    vi.spyOn(tauriLib, "invokeDeleteSavedQuery").mockResolvedValue(undefined);
    const closeTab = vi.spyOn(tauriLib, "invokeCloseTab").mockResolvedValue(undefined);

    useAppStore.setState({
      activeConnectionId: "c1",
      savedQueries: [{ id: "q1", connection_id: "c1", name: "doomed", sql: "SELECT 1;", created_at: 1 }],
    });

    render(<App />);
    await waitFor(() => expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["qt"]));
    expect(screen.getByRole("textbox", { name: "Query name" })).toHaveValue("doomed");

    fireEvent.click(await screen.findByRole("button", { name: "Delete query doomed" }));

    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(0));
    expect(closeTab).toHaveBeenCalledWith("qt");
    expect(screen.queryByRole("textbox", { name: "Query name" })).not.toBeInTheDocument();

    useAppStore.setState({ activeConnectionId: null, savedQueries: [] });
  });

  it("renders the normal workspace, with no error screen, when the startup check reports no error", async () => {
    vi.spyOn(tauriLib, "invokeGetStartupStatus").mockResolvedValue({ db_error: null });
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(settings);
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);

    render(<App />);

    expect(screen.getByRole("complementary", { name: "Sessions" })).toBeInTheDocument();
    await waitFor(() => expect(tauriLib.invokeGetStartupStatus).toHaveBeenCalled());
    expect(screen.queryByText(/couldn't start/i)).not.toBeInTheDocument();
  });
});
