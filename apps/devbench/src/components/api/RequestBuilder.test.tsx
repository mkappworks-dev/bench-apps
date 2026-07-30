import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestBuilder } from "./RequestBuilder";
import * as tauriLib from "../../lib/tauri";

const connection = { host: "localhost", port: 5432, database: "d", username: "u", password: "p" };

describe("RequestBuilder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires a correlated request against the watched tables and reports the result", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeRunCorrelatedRequest").mockResolvedValue({
      response: { status_code: 201, body: '{"id":8841}', duration_ms: 142 },
      table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
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
        response: { status_code: 201, body: '{"id":8841}', duration_ms: 142 },
        table_diffs: [{ table: "orders", inserted: 1, updated: 0, deleted: 0 }],
      }),
    );
    expect(tauriLib.invokeRunCorrelatedRequest).toHaveBeenCalledWith({
      request: { method: "GET", url: "/api/orders", body: undefined },
      connection,
      watchedTables: ["orders"],
    });
  });
});
