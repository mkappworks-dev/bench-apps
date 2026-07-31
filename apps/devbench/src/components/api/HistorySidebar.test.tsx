import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { HistorySidebar } from "./HistorySidebar";
import * as tauriLib from "../../lib/tauri";
import type { HistoryEntry } from "../../lib/tauri";

/** A promise whose settlement this test controls, so fetches can be landed out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  // Refetching is not enough on its own: two reads are in flight across a
  // session switch and nothing orders their resolution. If the older one lands
  // last it overwrites the newer, putting session A's requests under session
  // B's heading — the exact thing scoping exists to prevent.
  it("ignores a stale fetch that resolves after a newer one", async () => {
    const first = deferred<HistoryEntry[]>();
    const second = deferred<HistoryEntry[]>();
    const list = vi
      .spyOn(tauriLib, "invokeListHistory")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(<HistorySidebar onSelect={() => {}} sessionId="sess-a" />);
    rerender(<HistorySidebar onSelect={() => {}} sessionId="sess-b" />);
    expect(list).toHaveBeenCalledTimes(2);

    // The newer read lands first...
    second.resolve([entry({ id: "2", url: "/in-b", session_id: "sess-b" })]);
    await waitFor(() => expect(screen.getByText("/in-b")).toBeInTheDocument());

    // ...and only then does the read for the session we already left resolve.
    await act(async () => {
      first.resolve([entry({ url: "/in-a", session_id: "sess-a" })]);
      await first.promise;
    });

    expect(screen.queryByText("/in-a")).not.toBeInTheDocument();
    expect(screen.getByText("/in-b")).toBeInTheDocument();
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
