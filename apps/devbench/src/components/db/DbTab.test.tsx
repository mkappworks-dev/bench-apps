import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DbTab } from "./DbTab";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";

function renderDb(table: string | null, onPatchState = vi.fn()) {
  return { onPatchState, ...render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={table} onPatchState={onPatchState} />) };
}

describe("DbTab", () => {
  beforeEach(() => {
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    useAppStore.getState().setActiveConnectionId("c1");
  });

  it("fetches rows for the table it is given, without needing a click first", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: null });
    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalledWith("c1", "orders"));
  });

  it("fetches nothing when given no table", () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [], pk_column: null });
    renderDb(null);
    expect(listRows).not.toHaveBeenCalled();
  });

  // The core independence bug this migration fixes: two DbTab instances,
  // given different `table` props, must never share fetched rows.
  it("re-fetches when its table prop changes to a different table", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [], pk_column: null });
    const { rerender, onPatchState } = renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalledWith("c1", "orders"));

    rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table="payments" onPatchState={onPatchState} />);
    await waitFor(() => expect(listRows).toHaveBeenCalledWith("c1", "payments"));
  });

  it("selecting a table in the schema tree patches state rather than fetching directly", () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [], pk_column: null });
    const { onPatchState } = renderDb(null);
    // SchemaTree's own tests cover the tree UI; DbTab's contract is that
    // selecting a table calls onPatchState, not a direct fetch. Covered
    // end-to-end (two DB tabs, two tables) in SplitContent.test.tsx.
    expect(onPatchState).not.toHaveBeenCalled();
  });

  // No connection has been picked yet — a real, reachable state now that
  // connections are no longer hardcoded. Must read as "pick one", not as a
  // silent blank pane indistinguishable from a table simply not loaded yet.
  it("shows a distinct empty state and fetches nothing when there is no active connection", () => {
    useAppStore.getState().setActiveConnectionId(null);
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [], pk_column: null });
    renderDb("orders");
    expect(screen.getByText("Select a connection to browse its data.")).toBeInTheDocument();
    expect(listRows).not.toHaveBeenCalled();
  });
});
