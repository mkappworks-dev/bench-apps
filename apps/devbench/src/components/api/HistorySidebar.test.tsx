import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
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

  // Task 13: Email's "Sent by" chip deep-links here via `focusId`.
  it("selects the focused entry once it has loaded, mirroring a manual click", async () => {
    const onSelect = vi.fn();
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([entry({ id: "hist-1", url: "/api/checkout" })]);

    render(<HistorySidebar onSelect={onSelect} focusId="hist-1" />);

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "hist-1" })));
  });

  it("highlights the focused row", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([entry({ id: "hist-1", url: "/api/checkout" })]);

    render(<HistorySidebar onSelect={() => {}} focusId="hist-1" />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /checkout/ })).toHaveAttribute("aria-current", "true"),
    );
  });

  // A focusId can arrive before the initial fetch resolves — the effect must
  // retry once `entries` actually contains the match, not drop it silently.
  it("selects the focused entry even if it arrives before the fetch resolves", async () => {
    const pending = deferred<HistoryEntry[]>();
    const onSelect = vi.fn();
    vi.spyOn(tauriLib, "invokeListHistory").mockReturnValue(pending.promise);

    render(<HistorySidebar onSelect={onSelect} focusId="hist-1" />);
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve([entry({ id: "hist-1", url: "/api/checkout" })]);
      await pending.promise;
    });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "hist-1" }));
  });

  // Regression guard: firing a new request bumps `refreshKey`, which refetches
  // and gives `entries` a brand-new array reference. Without the consumed-ref
  // guard, that would re-run the focus effect and yank the user back to the
  // OLD linked entry every single time — a much worse bug than a stale
  // highlight, since it fights the user's current action.
  it("does not re-select the focused entry after a later refetch", async () => {
    const onSelect = vi.fn();
    const list = vi
      .spyOn(tauriLib, "invokeListHistory")
      .mockResolvedValue([entry({ id: "hist-1", url: "/api/checkout" })]);

    const { rerender } = render(<HistorySidebar onSelect={onSelect} focusId="hist-1" refreshKey={1} />);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));

    // Simulate firing a new request: refreshKey bumps and the refetch returns
    // a fresh array (new reference, same focused entry still present).
    list.mockResolvedValue([
      entry({ id: "hist-2", url: "/api/new-request" }),
      entry({ id: "hist-1", url: "/api/checkout" }),
    ]);
    rerender(<HistorySidebar onSelect={onSelect} focusId="hist-1" refreshKey={2} />);

    await waitFor(() => expect(screen.getByText("/api/new-request")).toBeInTheDocument());
    expect(onSelect).toHaveBeenCalledTimes(1);
    // Nothing on screen right now IS hist-1 (a live send is showing instead),
    // so the refetch clearing the stale highlight is correct, not a loss.
    expect(screen.getByRole("button", { name: /checkout/ })).toHaveAttribute("aria-current", "false");
  });

  // Reviewer finding: aria-current/highlight must track the actual selection,
  // not stay pinned to whatever focusId originally pointed at — otherwise a
  // manual click leaves the deep-linked row falsely marked "current".
  it("moves the highlight to a manually-clicked row, off the deep-linked one", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([
      entry({ id: "hist-1", url: "/api/checkout" }),
      entry({ id: "hist-2", url: "/api/refunds" }),
    ]);

    render(<HistorySidebar onSelect={() => {}} focusId="hist-1" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /checkout/ })).toHaveAttribute("aria-current", "true"),
    );

    fireEvent.click(screen.getByRole("button", { name: /refunds/ }));

    expect(screen.getByRole("button", { name: /refunds/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /checkout/ })).toHaveAttribute("aria-current", "false");
  });
});
