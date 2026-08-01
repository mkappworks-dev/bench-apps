import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiTab } from "./ApiTab";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";
import type { CorrelationResult } from "../../lib/tauri";

/** A promise whose settlement this test controls, standing in for a slow backend call. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sendResult(body: string): CorrelationResult {
  return {
    correlation_id: `corr-${body}`,
    response: { status_code: 201, body, duration_ms: 142 },
    table_diffs: [],
    db_error: null,
    history_id: `hist-${body}`,
  };
}

function logLine(id: number) {
  return {
    id,
    source_id: "src",
    captured_at_ms: 0,
    timestamp: null,
    level: null,
    message: `line ${id}`,
    raw: `line ${id}`,
  };
}

describe("ApiTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.getState().setActiveSessionId(null);
  });

  // Leaving the rollup up after a switch attributes one investigation's
  // effects to another.
  it("clears a displayed response when the active session changes", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([
      {
        id: "1",
        method: "POST",
        url: "/api/orders",
        status_code: 201,
        response_body: '{"id":8841}',
        duration_ms: 142,
        fired_at: "2026-07-30T14:02:11Z",
        session_id: null,
      },
    ]);

    render(<ApiTab onOpenTableInDb={() => {}} onOpenEmail={() => {}} />);

    // ResponseViewer renders the body verbatim inside a <pre>.
    const historyButton = await screen.findByRole("button", { name: /\/api\/orders/ });
    fireEvent.click(historyButton);
    await waitFor(() => expect(screen.getByText('{"id":8841}')).toBeInTheDocument());

    useAppStore.getState().setActiveSessionId("sess-1");

    await waitFor(() => expect(screen.queryByText('{"id":8841}')).not.toBeInTheDocument());
  });

  // A correlated send stays pending for the whole window (5s default, up to
  // 60), so switching investigation mid-collect is ordinary use.
  it("drops a send that resolves after the session it was fired in was left", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);
    const send = deferred<CorrelationResult>();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockReturnValue(send.promise);
    // Left pending: a guard failure should fail an assertion, not crash downstream.
    vi.spyOn(tauriLib, "invokeCollectCorrelationWindow").mockReturnValue(
      deferred<tauriLib.CorrelationWindowResult>().promise,
    );

    render(<ApiTab onOpenTableInDb={() => {}} onOpenEmail={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), {
      target: { value: "/api/orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    act(() => useAppStore.getState().setActiveSessionId("sess-1"));

    await act(async () => {
      send.resolve(sendResult('{"id":8841}'));
      await send.promise;
    });

    expect(screen.queryByText('{"id":8841}')).not.toBeInTheDocument();
    // Not stuck mid-send either: the rollup shows only while sending or displayed.
    expect(screen.queryByText("What happened")).not.toBeInTheDocument();
  });

  // The link Task 9/10 built (stamping request_id onto observed emails) is
  // dead unless the history id from the send actually reaches the window
  // call — a wiring gap that types alone would not catch.
  it("threads the send's history_id into the window collection call", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-1",
      response: { status_code: 201, body: '{"id":8841}', duration_ms: 142 },
      table_diffs: [],
      db_error: null,
      history_id: "hist-77",
    });
    const collectWindow = vi
      .spyOn(tauriLib, "invokeCollectCorrelationWindow")
      .mockResolvedValue({ log_lines: [], log_lines_truncated: false, emails: [], emails_truncated: false });

    render(<ApiTab onOpenTableInDb={() => {}} onOpenEmail={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), {
      target: { value: "/api/orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(collectWindow).toHaveBeenCalledWith("corr-1", "hist-77"));
  });

  // The window resolves long after the response, and unguarded would splice
  // one session's log lines/emails into whatever result is on screen.
  it("does not splice a left session's correlation window into the current one", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest")
      .mockResolvedValueOnce(sendResult('{"first":1}'))
      .mockResolvedValueOnce(sendResult('{"second":2}'));

    const windowA = deferred<tauriLib.CorrelationWindowResult>();
    const windowB = deferred<tauriLib.CorrelationWindowResult>();
    vi.spyOn(tauriLib, "invokeCollectCorrelationWindow")
      .mockReturnValueOnce(windowA.promise)
      .mockReturnValueOnce(windowB.promise);

    render(<ApiTab onOpenTableInDb={() => {}} onOpenEmail={() => {}} />);
    const url = screen.getByPlaceholderText("/api/orders");

    // Send one in the unscoped view; its window stays open.
    fireEvent.change(url, { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText('{"first":1}')).toBeInTheDocument());

    // Move to another investigation and fire a second request there.
    act(() => useAppStore.getState().setActiveSessionId("sess-1"));
    fireEvent.change(url, { target: { value: "/api/refunds" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText('{"second":2}')).toBeInTheDocument());

    // Only now does the first session's window close, carrying its log lines.
    await act(async () => {
      windowA.resolve({
        log_lines: [logLine(1), logLine(2), logLine(3)],
        log_lines_truncated: false,
        emails: [],
        emails_truncated: false,
      });
      await windowA.promise;
    });

    expect(screen.queryByText("3 lines")).not.toBeInTheDocument();
    // The current request's own window is still open, so its slot is pending.
    expect(screen.getByTestId("rollup-log-pending")).toBeInTheDocument();
  });

  // The session guard is blind to this: two sends in the SAME session both
  // pass it. Only `correlation_id` tells them apart, and fire-tweak-fire
  // inside the 5s window is the ordinary debugging loop, not an edge case.
  it("does not splice one request's correlation window into a later request in the same session", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest")
      .mockResolvedValueOnce(sendResult('{"first":1}'))
      .mockResolvedValueOnce(sendResult('{"second":2}'));

    const windowA = deferred<tauriLib.CorrelationWindowResult>();
    const windowB = deferred<tauriLib.CorrelationWindowResult>();
    vi.spyOn(tauriLib, "invokeCollectCorrelationWindow")
      .mockReturnValueOnce(windowA.promise)
      .mockReturnValueOnce(windowB.promise);

    render(<ApiTab onOpenTableInDb={() => {}} onOpenEmail={() => {}} />);
    const url = screen.getByPlaceholderText("/api/orders");

    fireEvent.change(url, { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText('{"first":1}')).toBeInTheDocument());

    // No session change anywhere in this test — same investigation throughout.
    fireEvent.change(url, { target: { value: "/api/refunds" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText('{"second":2}')).toBeInTheDocument());

    // The first request's window closes late, carrying its log lines.
    await act(async () => {
      windowA.resolve({
        log_lines: [logLine(1), logLine(2), logLine(3)],
        log_lines_truncated: false,
        emails: [],
        emails_truncated: false,
      });
      await windowA.promise;
    });

    expect(screen.queryByText("3 lines")).not.toBeInTheDocument();
    expect(screen.getByTestId("rollup-log-pending")).toBeInTheDocument();

    // And the second request's own window still fills its own slot — the fix
    // must drop the foreign window, not freeze the pane against every update.
    await act(async () => {
      windowB.resolve({
        log_lines: [logLine(9)],
        log_lines_truncated: false,
        emails: [],
        emails_truncated: false,
      });
      await windowB.promise;
    });

    expect(screen.getByText("1 line")).toBeInTheDocument();
  });
});
