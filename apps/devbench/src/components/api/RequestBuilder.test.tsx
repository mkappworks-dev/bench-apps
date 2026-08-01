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
    // No `headers` key: RequestBuilder.tsx doesn't send one until Task 10 rewrites it.
    expect(tauriLib.invokeRunCorrelatedRequest).toHaveBeenCalledWith({
      request: { method: "GET", url: "/api/orders", body: undefined },
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
});
