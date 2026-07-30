import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HistorySidebar } from "./HistorySidebar";
import * as tauriLib from "../../lib/tauri";

describe("HistorySidebar", () => {
  it("lists past requests with method, path, and status", async () => {
    vi.spyOn(tauriLib, "invokeListHistory").mockResolvedValue([
      {
        id: "1",
        method: "POST",
        url: "/api/orders",
        status_code: 200,
        response_body: "{}",
        duration_ms: 142,
        fired_at: "2026-07-30T14:02:11Z",
      },
    ]);

    render(<HistorySidebar onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByText("/api/orders")).toBeInTheDocument());
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
  });
});
