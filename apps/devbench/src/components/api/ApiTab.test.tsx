import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiTab } from "./ApiTab";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";

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
});
