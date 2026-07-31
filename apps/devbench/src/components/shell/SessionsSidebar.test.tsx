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

  // A stored id can name a session that has since been archived or hard
  // deleted. Selecting it anyway would leave the app scoped to a session
  // that is not in the list and cannot be deselected.
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

  // `refresh()` runs again after create and archive. Re-running
  // reconciliation there would overwrite whatever the user just selected
  // with the value read at launch.
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

    // NewSessionDialog's input has no label — it is reached by placeholder —
    // and its submit button reads "Create session", not "Create".
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(screen.getByPlaceholderText("Order flow debug"), {
      target: { value: "Fresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => expect(useAppStore.getState().activeSessionId).toBe("c"));
    // Give the refresh that follows creation time to settle, then confirm
    // reconciliation did not fire a second time and reset us to "a".
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useAppStore.getState().activeSessionId).toBe("c");
  });
});
