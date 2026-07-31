import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ArchivePane } from "./ArchivePane";
import * as tauriLib from "../../lib/tauri";

const archived = [
  {
    id: "a",
    name: "Payment webhook investigation",
    kind: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    archived_at: "2026-07-25T00:00:00Z",
  },
];

describe("ArchivePane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeRestoreSession").mockResolvedValue(undefined);
    vi.spyOn(tauriLib, "invokeDeleteSession").mockResolvedValue(undefined);
  });

  it("lists archived sessions", async () => {
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue(archived);
    render(<ArchivePane />);
    await waitFor(() => expect(screen.getByText("Payment webhook investigation")).toBeInTheDocument());
  });

  it("restores a session", async () => {
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue(archived);
    render(<ArchivePane />);
    await waitFor(() => screen.getByRole("button", { name: "Restore Payment webhook investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Payment webhook investigation" }));
    await waitFor(() => expect(tauriLib.invokeRestoreSession).toHaveBeenCalledWith("a"));
  });

  // Permanent deletion is the one destructive action in the app; it asks first.
  it("requires confirmation before deleting permanently", async () => {
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue(archived);
    render(<ArchivePane />);
    await waitFor(() => screen.getByRole("button", { name: /delete forever/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete forever/i }));
    expect(tauriLib.invokeDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByText(/this cannot be undone/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(tauriLib.invokeDeleteSession).toHaveBeenCalledWith("a"));
  });

  it("shows an empty state", async () => {
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue([]);
    render(<ArchivePane />);
    await waitFor(() => expect(screen.getByText(/nothing archived/i)).toBeInTheDocument());
  });
});
