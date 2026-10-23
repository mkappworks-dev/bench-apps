import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestBuilder } from "./RequestBuilder";
import * as tauriLib from "../../lib/tauri";
import type { CorrelationResult } from "../../lib/tauri";

describe("RequestBuilder", () => {
  function Composer({ onResult }: { onResult: (result: CorrelationResult) => void }) {
    const [state, setState] = useState({ method: "GET", url: "" });
    return <RequestBuilder connectionId="c1" watchedTables={[]} onResult={onResult}
      {...state} onPatchState={(patch) => setState((prev) => ({ ...prev, ...patch }))} />;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires a correlated request against the watched tables and reports the result", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-1",
      response: { status_code: 201, headers: [], body: '{"id":8841}', duration_ms: 142 },
      table_diffs: [{ schema: "public", table: "orders", inserted: 1, updated: 0, deleted: 0 }],
      db_error: null,
      history_id: "hist-1",
    });

    render(
      <RequestBuilder
        connectionId="c1"
        watchedTables={[{ schema: "public", name: "orders" }]}
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
        response: { status_code: 201, headers: [], body: '{"id":8841}', duration_ms: 142 },
        table_diffs: [{ schema: "public", table: "orders", inserted: 1, updated: 0, deleted: 0 }],
        db_error: null,
        history_id: "hist-1",
      }),
    );
    expect(tauriLib.invokeRunCorrelatedRequest).toHaveBeenCalledWith({
      request: { method: "GET", url: "/api/orders", headers: [], body: undefined },
      connectionId: "c1",
      watchedTables: [{ schema: "public", name: "orders" }],
      sessionId: null,
    });
  });

  it("attributes the request to the active session", async () => {
    const invoked = vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-3",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
      history_id: "hist-3",
    });

    render(
      <RequestBuilder
        connectionId="c1"
        watchedTables={[]}
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
        watchedTables={[{ schema: "public", name: "orders" }]}
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
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
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
        watchedTables={[]}
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
          watchedTables={[]}
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
        watchedTables={[]}
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
      <RequestBuilder connectionId="c1" watchedTables={[]} onResult={() => {}} method="GET" url="" onPatchState={onPatchState} />,
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
        watchedTables={[]}
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

  it("assembles headers, resolved auth, and url params into the actual request payload", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-9",
      history_id: "hist-9",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });

    render(<Composer onResult={onResult} />);

    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders?status=pending" } });

    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    const [keyInput] = screen.getAllByPlaceholderText("key");
    const [valueInput] = screen.getAllByPlaceholderText("value");
    fireEvent.change(keyInput, { target: { value: "X-Debug" } });
    fireEvent.change(valueInput, { target: { value: "true" } });

    fireEvent.click(screen.getByText("Auth"));
    fireEvent.change(screen.getByLabelText("Auth type"), { target: { value: "bearer" } });
    fireEvent.change(screen.getByPlaceholderText("Bearer token"), { target: { value: "abc123" } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.url).toBe("/api/orders?status=pending");
    expect(call.request.headers).toEqual(
      expect.arrayContaining([
        { key: "X-Debug", value: "true" },
        { key: "Authorization", value: "Bearer abc123" },
      ]),
    );
  });

  it("excludes an unchecked header from the sent request", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-10",
      history_id: "hist-10",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });

    render(<Composer onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getAllByPlaceholderText("key")[0], { target: { value: "X-Debug" } });
    fireEvent.change(screen.getAllByPlaceholderText("value")[0], { target: { value: "true" } });
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.headers).toEqual([]);
  });

  it("sends undefined body when bodyType is none", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-11",
      history_id: "hist-11",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });
    render(<Composer onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.body).toBeUndefined();
  });

  it("sends the body text when bodyType is json", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-12",
      history_id: "hist-12",
      response: { status_code: 201, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });
    render(<Composer onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByText("Body"));
    fireEvent.change(screen.getByLabelText("Body type"), { target: { value: "json" } });
    fireEvent.change(screen.getByPlaceholderText("Raw request body"), { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.body).toBe('{"a":1}');
  });

  it("keeps params synchronized with the URL through persisted state patches", () => {
    const onPatchState = vi.fn();
    function PersistedComposer() {
      const [state, setState] = useState({ method: "GET", url: "/api/orders?status=pending" });
      return <RequestBuilder connectionId="c1" watchedTables={[]} onResult={() => {}}
        {...state} onPatchState={(patch) => {
          onPatchState(patch);
          setState((prev) => ({ ...prev, ...patch }));
        }} />;
    }
    render(<PersistedComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Params" }));
    expect(screen.getByPlaceholderText("key")).toHaveValue("status");
    expect(screen.getByPlaceholderText("value")).toHaveValue("pending");

    fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "paid" } });
    expect(onPatchState).toHaveBeenCalledWith({ url: "/api/orders?status=paid" });
    expect(screen.getByPlaceholderText("/api/orders")).toHaveValue("/api/orders?status=paid");

    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders?limit=2" } });
    expect(screen.getByPlaceholderText("key")).toHaveValue("limit");
    expect(screen.getByPlaceholderText("value")).toHaveValue("2");
  });

  it("keeps incomplete param rows editable while only persisting named params", async () => {
    const invoked = vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "draft", history_id: null, response: { status_code: 200, headers: [], body: "{}", duration_ms: 1 }, table_diffs: [], db_error: null,
    });
    render(<Composer onResult={() => {}} />);
    const url = screen.getByPlaceholderText("/api/orders");
    fireEvent.change(url, { target: { value: "/orders#frag" } });
    fireEvent.click(screen.getByText("Params"));
    fireEvent.click(screen.getByRole("button", { name: "Add param" }));
    const value = screen.getByPlaceholderText("value");
    fireEvent.change(value, { target: { value: "pending" } });
    const key = screen.getByPlaceholderText("key");
    fireEvent.change(key, { target: { value: "status" } });
    expect(url).toHaveValue("/orders?status=pending#frag");
    key.focus();
    fireEvent.change(key, { target: { value: "" } });
    expect(key).toHaveFocus();
    expect(value).toHaveValue("pending");
    expect(url).toHaveValue("/orders#frag");
    fireEvent.change(key, { target: { value: "status" } });
    fireEvent.click(screen.getByRole("button", { name: "Add param" }));
    expect(screen.getAllByPlaceholderText("key")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(invoked).toHaveBeenCalled());
    expect(invoked.mock.calls[0][0].request.url).toBe("/orders?status=pending#frag");
    fireEvent.change(url, { target: { value: "/other?limit=2" } });
    expect(screen.getAllByPlaceholderText("key")).toHaveLength(1);
    expect(screen.getByPlaceholderText("key")).toHaveValue("limit");
    fireEvent.change(url, { target: { value: "/orders?status=pending#frag" } });
    expect(screen.getAllByPlaceholderText("key")).toHaveLength(1);
  });

});
