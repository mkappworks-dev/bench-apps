import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { HistorySidebar } from "./HistorySidebar";
import * as tauriLib from "../../lib/tauri";
import type { HistoryEntry } from "../../lib/tauri";

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "1",
    method: "POST",
    url: "/api/orders",
    status_code: 200,
    response_body: "{}",
    duration_ms: 142,
    fired_at: "2026-07-30T14:02:11Z",
    session_id: null,
    ...overrides,
  };
}

describe("HistorySidebar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists past requests with method, path, and status", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([entry()]);

    render(<HistorySidebar onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText("/api/orders")).toBeInTheDocument());
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
  });

  it("requests only the active session's history", async () => {
    const list = vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);

    render(<HistorySidebar onSelect={() => {}} sessionId="sess-1" />);

    await waitFor(() => expect(list).toHaveBeenCalledWith("sess-1"));
  });

  // Switching sessions has to refetch, or the sidebar keeps showing the
  // previous session's requests while claiming to be scoped to this one.
  it("refetches when the session changes", async () => {
    const list = vi
      .spyOn(tauriLib, "invokeListHistory")
      .mockResolvedValue([entry({ url: "/in-a", session_id: "sess-a" })]);

    const { rerender } = render(<HistorySidebar onSelect={() => {}} sessionId="sess-a" />);
    await waitFor(() => expect(screen.getByText("/in-a")).toBeInTheDocument());

    list.mockResolvedValue([entry({ id: "2", url: "/in-b", session_id: "sess-b" })]);
    rerender(<HistorySidebar onSelect={() => {}} sessionId="sess-b" />);

    await waitFor(() => expect(screen.getByText("/in-b")).toBeInTheDocument());
    expect(screen.queryByText("/in-a")).not.toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith("sess-b");
  });

  // Creating a session auto-selects it, so an empty scoped list is the very
  // first thing a new session shows. Rendering nothing at all there is
  // indistinguishable from a broken fetch.
  it("explains an empty list differently inside a session than outside one", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);

    const { rerender } = render(<HistorySidebar onSelect={() => {}} sessionId="sess-1" />);
    await waitFor(() =>
      expect(screen.getByText("No requests fired in this session yet.")).toBeInTheDocument(),
    );

    rerender(<HistorySidebar onSelect={() => {}} sessionId={null} />);
    await waitFor(() => expect(screen.getByText("No requests yet.")).toBeInTheDocument());
  });

  // PRODUCT.md principle 4: a failure to observe is never rendered as
  // "nothing happened". Adding empty-state copy makes this newly reachable —
  // before, a failed fetch rendered nothing at all, which was vague but did
  // not actively claim the user had fired no requests.
  it("says it could not load rather than claiming there are no requests", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockRejectedValue(new Error("db is gone"));

    render(<HistorySidebar onSelect={() => {}} sessionId="sess-1" />);

    await waitFor(() => expect(screen.getByText("Couldn't load history.")).toBeInTheDocument());
    expect(screen.queryByText("No requests fired in this session yet.")).not.toBeInTheDocument();
  });
});
