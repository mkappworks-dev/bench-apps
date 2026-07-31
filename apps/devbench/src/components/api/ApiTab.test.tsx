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

  // The rollup narrates "what happened" for a fired request. Leaving it on
  // screen after switching sessions would attribute one investigation's
  // effects to another, while the history sidebar beside it shows a list
  // that does not contain the request being described.
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

    // Selecting a history entry populates the response pane. ResponseViewer
    // renders the body verbatim inside a <pre>, so the raw string matches.
    const historyButton = await screen.findByRole("button", { name: /\/api\/orders/ });
    fireEvent.click(historyButton);
    await waitFor(() => expect(screen.getByText('{"id":8841}')).toBeInTheDocument());

    useAppStore.getState().setActiveSessionId("sess-1");

    await waitFor(() => expect(screen.queryByText('{"id":8841}')).not.toBeInTheDocument());
  });

  // Not a tight race: a correlated send stays pending for the whole correlation
  // window — 5s by default, up to 60s — so firing a request and then switching
  // investigation while it collects is ordinary use.
  it("drops a send that resolves after the session it was fired in was left", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([]);
    const send = deferred<CorrelationResult>();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockReturnValue(send.promise);
    // Left pending: if the guard fails and the send is processed anyway, this
    // test should fail on its assertions rather than crash somewhere downstream.
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
    // And the pane is not stuck mid-send: the rollup only appears while a send
    // is outstanding or a result is displayed, and neither is true here.
    expect(screen.queryByText("What happened")).not.toBeInTheDocument();
  });

  // The late continuation is the sharper half: the correlation window resolves
  // long after the response did, and splices log lines and emails into whatever
  // result is on screen. Unguarded, one session's observed side effects get
  // attributed to a different request in a different investigation.
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
    // The current request's own window is still open, so its log slot is
    // pending rather than filled in with someone else's lines.
    expect(screen.getByTestId("rollup-log-pending")).toBeInTheDocument();
  });
});
