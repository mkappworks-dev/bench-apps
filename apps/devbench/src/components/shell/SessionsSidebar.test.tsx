import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SessionsSidebar } from "./SessionsSidebar";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";

const sessions = [
  { id: "a", name: "Order flow debug", kind: "api", created_at: "", updated_at: "", archived_at: null },
  { id: "b", name: "Checkout API", kind: null, created_at: "", updated_at: "", archived_at: null },
];

describe("SessionsSidebar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.getState().setActiveSessionId(null);
  });

  it("lists sessions", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => expect(screen.getByText("Order flow debug")).toBeInTheDocument());
  });

  it("selects a session", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => screen.getByText("Checkout API"));
    fireEvent.click(screen.getByRole("button", { name: "Checkout API" }));
    expect(useAppStore.getState().activeSessionId).toBe("b");
  });

  // The spec is explicit: removing from the sidebar archives, it never deletes.
  it("archives rather than deletes when a session is removed", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    const archive = vi.spyOn(tauriLib, "invokeArchiveSession").mockResolvedValue(undefined);
    const del = vi.spyOn(tauriLib, "invokeDeleteSession").mockResolvedValue(undefined);
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => screen.getByText("Order flow debug"));
    fireEvent.click(screen.getByRole("button", { name: "Archive Order flow debug" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith("a"));
    expect(del).not.toHaveBeenCalled();
  });

  it("creates a session through the picker", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue([]);
    const create = vi
      .spyOn(tauriLib, "invokeCreateSession")
      .mockResolvedValue({ ...sessions[0], id: "new" });
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(screen.getByPlaceholderText("Order flow debug"), {
      target: { value: "Payment webhook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("Payment webhook"));
  });

  // The spec puts the ONE settings entry point at the bottom of this sidebar.
  it("offers the only settings entry point", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue([]);
    const onOpenSettings = vi.fn();
    render(<SessionsSidebar onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows an empty state rather than a bare list", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue([]);
    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument());
  });

  const storedSettings = {
    theme: "dark",
    correlation_window_ms: 5000,
    smtp_port: 1025,
    provider: "anthropic",
    model: "claude-opus-5",
    active_session_id: null as string | null,
  };

  it("restores the session the user was last in", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({
      ...storedSettings,
      active_session_id: "b",
    });

    render(<SessionsSidebar onOpenSettings={() => {}} />);

    await waitFor(() => expect(useAppStore.getState().activeSessionId).toBe("b"));
  });

  // A stored id can name an archived/deleted session; selecting it would
  // scope the app to something absent from the list.
  it("clears a stored session that is no longer active", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({
      ...storedSettings,
      active_session_id: "archived-or-deleted",
    });
    const setSetting = vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);

    render(<SessionsSidebar onOpenSettings={() => {}} />);

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("active_session_id", ""));
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });

  it("persists the session the user selects", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(storedSettings);
    const setSetting = vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);

    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => screen.getByText("Checkout API"));
    fireEvent.click(screen.getByRole("button", { name: "Checkout API" }));

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("active_session_id", "b"));
  });

  // `refresh()` runs again after create/archive; reconciliation must not
  // re-fire and overwrite the user's new selection with the launch value.
  it("does not re-apply the stored session after a later refresh", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({
      ...storedSettings,
      active_session_id: "a",
    });
    vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);
    vi.spyOn(tauriLib, "invokeCreateSession").mockResolvedValue({
      id: "c",
      name: "Fresh",
      kind: null,
      created_at: "",
      updated_at: "",
      archived_at: null,
    });

    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => expect(useAppStore.getState().activeSessionId).toBe("a"));

    // NewSessionDialog's input has no label (reached by placeholder); its
    // submit button reads "Create session", not "Create".
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(screen.getByPlaceholderText("Order flow debug"), {
      target: { value: "Fresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => expect(useAppStore.getState().activeSessionId).toBe("c"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useAppStore.getState().activeSessionId).toBe("c");
  });

  // `main.tsx` wraps the app in StrictMode, which double-invokes mount effects
  // in dev (refs survive it). `reconciled` collapses that to one settings read.
  it("reconciles only once under StrictMode's double-invoked effect", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    const getSettings = vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({
      ...storedSettings,
      active_session_id: "b",
    });

    render(
      <StrictMode>
        <SessionsSidebar onOpenSettings={() => {}} />
      </StrictMode>,
    );

    await waitFor(() => expect(useAppStore.getState().activeSessionId).toBe("b"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  // Settings can be unreadable (locked db); reconciliation must not take the
  // sidebar down with it or leak an unhandled rejection.
  it("stays unscoped and usable when settings cannot be read", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    vi.spyOn(tauriLib, "invokeGetSettings").mockRejectedValue(new Error("db locked"));

    render(<SessionsSidebar onOpenSettings={() => {}} />);

    await waitFor(() => expect(screen.getByText("Checkout API")).toBeInTheDocument());
    expect(useAppStore.getState().activeSessionId).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Checkout API" }));
    expect(useAppStore.getState().activeSessionId).toBe("b");
  });

  // A failed list load is not "no sessions exist" — conflating them would
  // clear a good stored id over a momentary failure.
  it("keeps a stored session when the session list fails to load", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockRejectedValue(new Error("db locked"));
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({
      ...storedSettings,
      active_session_id: "b",
    });
    const setSetting = vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);

    render(<SessionsSidebar onOpenSettings={() => {}} />);

    await waitFor(() => expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(setSetting).not.toHaveBeenCalledWith("active_session_id", "");
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });

  // The list renders before the settings read resolves, so a fast click can
  // land in that gap; reconciliation must not silently overwrite it.
  it("does not revert a selection made while settings are still loading", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    let resolveSettings!: (value: tauriLib.AppSettings) => void;
    vi.spyOn(tauriLib, "invokeGetSettings").mockReturnValue(
      new Promise<tauriLib.AppSettings>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);

    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => screen.getByText("Checkout API"));

    fireEvent.click(screen.getByRole("button", { name: "Checkout API" }));
    expect(useAppStore.getState().activeSessionId).toBe("b");

    // Settings arrive late, naming a different session — the click must win.
    resolveSettings({ ...storedSettings, active_session_id: "a" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useAppStore.getState().activeSessionId).toBe("b");
  });

  // Persisting is best-effort: a failed write must never roll back the
  // in-memory selection the view depends on.
  it("keeps the selection when persisting it fails", async () => {
    vi.spyOn(tauriLib, "invokeListSessions").mockResolvedValue(sessions);
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(storedSettings);
    vi.spyOn(tauriLib, "invokeSetSetting").mockRejectedValue(new Error("disk full"));

    render(<SessionsSidebar onOpenSettings={() => {}} />);
    await waitFor(() => screen.getByText("Checkout API"));
    fireEvent.click(screen.getByRole("button", { name: "Checkout API" }));

    expect(useAppStore.getState().activeSessionId).toBe("b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useAppStore.getState().activeSessionId).toBe("b");
  });
});
