import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestBuilder } from "./RequestBuilder";
import * as tauriLib from "../../lib/tauri";

describe("RequestBuilder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires a request with the entered URL and reports the result", async () => {
    const onResult = vi.fn();
    vi.spyOn(tauriLib, "invokeFireRequest").mockResolvedValue({
      status_code: 200,
      body: "{}",
      duration_ms: 12,
    });

    render(<RequestBuilder onResult={onResult} />);
    fireEvent.change(screen.getByPlaceholderText("/api/orders"), {
      target: { value: "/api/orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({
      status_code: 200,
      body: "{}",
      duration_ms: 12,
    }));
    expect(tauriLib.invokeFireRequest).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/orders",
      body: undefined,
    });
  });
});
