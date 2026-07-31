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
});
