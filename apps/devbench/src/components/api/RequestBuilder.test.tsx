import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestBuilder } from "./RequestBuilder";
import * as tauriLib from "../../lib/tauri";
import type { CorrelationResult } from "../../lib/tauri";

describe("RequestBuilder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires a correlated request against the watched tables and reports the result", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-1",
      response: { status_code: 201, body: '{"id":8841}', duration_ms: 142 },
      table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
      db_error: null,
      history_id: "hist-1",
    });

    render(
      <RequestBuilder
        connectionId="c1"
        watchedTables={new Set(["orders"])}
        onResult={onResult}
        method="GET"
        url="/api/orders"
        onPatchState={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        correlation_id: "corr-1",
        response: { status_code: 201, body: '{"id":8841}', duration_ms: 142 },
        table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
        db_error: null,
        history_id: "hist-1",
      }),
    );
    expect(tauriLib.invokeRunCorrelatedRequest).toHaveBeenCalledWith({
      request: { method: "GET", url: "/api/orders", body: undefined },
      connectionId: "c1",
      watchedTables: ["orders"],
      sessionId: null,
    });
  });

  it("attributes the request to the active session", async () => {
    const invoked = vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-3",
      response: { status_code: 200, body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
      history_id: "hist-3",
    });

    render(
      <RequestBuilder
        connectionId="c1"
        watchedTables={new Set()}
        onResult={() => {}}
        sessionId="sess-1"
        method="GET"
        url="/api/orders"
        onPatchState={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(invoked).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-1" })),
    );
  });

  it("calls onSendStart synchronously before the correlated request resolves", async () => {
    const onResult = vi.fn();
    const onSendStart = vi.fn();
    let resolveRequest!: (value: CorrelationResult) => void;
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockReturnValue(
      new Promise<CorrelationResult>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    render(
      <RequestBuilder
        connectionId="c1"
        watchedTables={new Set(["orders"])}
        onResult={onResult}
        onSendStart={onSendStart}
        method="GET"
        url="/api/orders"
        onPatchState={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSendStart).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();

    resolveRequest({
      correlation_id: "corr-2",
      response: { status_code: 200, body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
      history_id: "hist-2",
    });
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
  });

  it("uses the styled menu rather than a native select for the method", () => {
    const { container } = render(
      <RequestBuilder
        connectionId="c1"
        watchedTables={new Set()}
        onResult={() => {}}
        method="GET"
        url=""
        onPatchState={() => {}}
      />,
    );
    expect(container.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: /method/i })).toBeInTheDocument();
  });

  it("changes the method through the menu, including PATCH", () => {
    // RequestBuilder is now a controlled component (no local method state), so
    // this needs a stateful wrapper — same shape ApiTab uses via onPatchState —
    // to see the menu selection reflected back in the display.
    function Wrapper() {
      const [method, setMethod] = useState("GET");
      return (
        <RequestBuilder
          connectionId="c1"
          watchedTables={new Set()}
          onResult={() => {}}
          method={method}
          url=""
          onPatchState={(patch) => {
            if (patch.method !== undefined) setMethod(patch.method);
          }}
        />
      );
    }
    render(<Wrapper />);
    fireEvent.click(screen.getByRole("button", { name: /method/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "PATCH" }));
    expect(screen.getByRole("button", { name: /method/i })).toHaveTextContent("PATCH");
  });

  it("shows the method and url from tab state, not local defaults", () => {
    render(
      <RequestBuilder
        connectionId="c1"
        watchedTables={new Set()}
        onResult={() => {}}
        method="POST"
        url="/api/orders"
        onPatchState={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /method/i })).toHaveTextContent("POST");
    expect(screen.getByPlaceholderText("/api/orders")).toHaveValue("/api/orders");
  });

  it("patches state on every keystroke and every method change, rather than holding local state", () => {
    const onPatchState = vi.fn();
    render(
      <RequestBuilder connectionId="c1" watchedTables={new Set()} onResult={() => {}} method="GET" url="" onPatchState={onPatchState} />,
    );

    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/users" } });
    expect(onPatchState).toHaveBeenCalledWith({ url: "/api/users" });

    fireEvent.click(screen.getByRole("button", { name: /method/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "PUT" }));
    expect(onPatchState).toHaveBeenCalledWith({ method: "PUT" });
  });

  // Honest no-op: sending with `connectionId: null` would reach the backend
  // with nothing to run the request against. The button reads as genuinely
  // unavailable rather than merely doing nothing when clicked.
  it("disables Send and never invokes the backend when no connection is selected", () => {
    const invoked = vi.spyOn(tauriLib, "invokeRunCorrelatedRequest");
    const onResult = vi.fn();
    render(
      <RequestBuilder
        connectionId={null}
        watchedTables={new Set()}
        onResult={onResult}
        method="GET"
        url="/api/orders"
        onPatchState={() => {}}
      />,
    );
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(invoked).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
