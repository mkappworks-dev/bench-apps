import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestBuilder } from "./RequestBuilder";
import * as tauriLib from "../../lib/tauri";
import type { CorrelationResult } from "../../lib/tauri";

const connection = { host: "localhost", port: 5432, database: "d", username: "u", password: "p" };

describe("RequestBuilder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires a correlated request against the watched tables and reports the result", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-1",
      response: { status_code: 201, headers: [], body: '{"id":8841}', duration_ms: 142 },
      table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
      db_error: null,
    });

    render(
      <RequestBuilder connection={connection} watchedTables={new Set(["orders"])} onResult={onResult} />,
    );
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), {
      target: { value: "/api/orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        correlation_id: "corr-1",
        response: { status_code: 201, headers: [], body: '{"id":8841}', duration_ms: 142 },
        table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
        db_error: null,
      }),
    );
    expect(tauriLib.invokeRunCorrelatedRequest).toHaveBeenCalledWith({
      request: { method: "GET", url: "/api/orders", headers: [], body: undefined },
      connection,
      watchedTables: ["orders"],
      sessionId: null,
    });
  });

  it("attributes the request to the active session", async () => {
    const invoked = vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-3",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });

    render(
      <RequestBuilder
        connection={connection}
        watchedTables={new Set()}
        onResult={() => {}}
        sessionId="sess-1"
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), {
      target: { value: "/api/orders" },
    });
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
        connection={connection}
        watchedTables={new Set(["orders"])}
        onResult={onResult}
        onSendStart={onSendStart}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), {
      target: { value: "/api/orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSendStart).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();

    resolveRequest({
      correlation_id: "corr-2",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
  });

  it("assembles headers, resolved auth, and url params into the actual request payload", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      correlation_id: "corr-9",
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });

    render(<RequestBuilder connection={connection} watchedTables={new Set()} onResult={onResult} />);

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
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });

    render(<RequestBuilder connection={connection} watchedTables={new Set()} onResult={onResult} />);
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
      response: { status_code: 200, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });
    render(<RequestBuilder connection={connection} watchedTables={new Set()} onResult={onResult} />);
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
      response: { status_code: 201, headers: [], body: "{}", duration_ms: 5 },
      table_diffs: [],
      db_error: null,
    });
    render(<RequestBuilder connection={connection} watchedTables={new Set()} onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), { target: { value: "/api/orders" } });
    fireEvent.click(screen.getByText("Body"));
    fireEvent.change(screen.getByLabelText("Body type"), { target: { value: "json" } });
    fireEvent.change(screen.getByPlaceholderText("Raw request body"), { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const call = (tauriLib.invokeRunCorrelatedRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.request.body).toBe('{"a":1}');
  });
});
