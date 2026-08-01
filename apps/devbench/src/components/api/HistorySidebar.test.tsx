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
    request_headers: [],
    request_body: null,
    response_headers: [],
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

  // Otherwise the previous session's rows stay visible AND clickable under
  // the new heading until the new read lands.
  it("drops the previous session's rows while the new session's read is in flight", async () => {
    const pending = deferred<HistoryEntry[]>();
    vi.spyOn(tauriLib, "invokeListHistory")
      .mockResolvedValueOnce([entry({ url: "/in-a", session_id: "sess-a" })])
      .mockReturnValueOnce(pending.promise);

    const { rerender } = render(<HistorySidebar onSelect={() => {}} sessionId="sess-a" />);
    await waitFor(() => expect(screen.getByText("/in-a")).toBeInTheDocument());

    rerender(<HistorySidebar onSelect={() => {}} sessionId="sess-b" />);

    expect(screen.queryByText("/in-a")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // Clearing `failed` at the top of the effect is only safe because the
  // `.catch` sets it again on a genuine failure.
  it("still reports a failure that happens after a successful read", async () => {
    const list = vi
      .spyOn(tauriLib, "invokeListHistory")
      .mockResolvedValueOnce([entry({ url: "/in-a", session_id: "sess-a" })]);

    const { rerender } = render(<HistorySidebar onSelect={() => {}} sessionId="sess-a" />);
    await waitFor(() => expect(screen.getByText("/in-a")).toBeInTheDocument());

    list.mockRejectedValueOnce(new Error("db is gone"));
    rerender(<HistorySidebar onSelect={() => {}} sessionId="sess-b" />);

    await waitFor(() => expect(screen.getByText("Couldn't load history.")).toBeInTheDocument());
  });

  it("explains an empty list differently inside a session than outside one", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);

    const { rerender } = render(<HistorySidebar onSelect={() => {}} sessionId="sess-1" />);
    await waitFor(() =>
      expect(screen.getByText("No requests fired in this session yet.")).toBeInTheDocument(),
    );

    rerender(<HistorySidebar onSelect={() => {}} sessionId={null} />);
    await waitFor(() => expect(screen.getByText("No requests yet.")).toBeInTheDocument());
  });

  // Two reads are in flight across a switch; if the older lands last it must
  // not overwrite the newer one.
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

    // The newer read lands first, then the one for the session we already left.
    second.resolve([entry({ id: "2", url: "/in-b", session_id: "sess-b" })]);
    await waitFor(() => expect(screen.getByText("/in-b")).toBeInTheDocument());

    await act(async () => {
      first.resolve([entry({ url: "/in-a", session_id: "sess-a" })]);
      await first.promise;
    });

    expect(screen.queryByText("/in-a")).not.toBeInTheDocument();
    expect(screen.getByText("/in-b")).toBeInTheDocument();
  });

  // PRODUCT.md principle 4: a failure to observe is never rendered as
  // "nothing happened".
  it("says it could not load rather than claiming there are no requests", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockRejectedValue(new Error("db is gone"));

    render(<HistorySidebar onSelect={() => {}} sessionId="sess-1" />);

    await waitFor(() => expect(screen.getByText("Couldn't load history.")).toBeInTheDocument());
    expect(screen.queryByText("No requests fired in this session yet.")).not.toBeInTheDocument();
  });
});
