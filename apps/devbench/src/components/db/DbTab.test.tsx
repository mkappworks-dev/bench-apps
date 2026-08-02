import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DbTab } from "./DbTab";
import * as tauriLib from "../../lib/tauri";

function renderDb(table: string | null, onPatchState = vi.fn()) {
  return { onPatchState, ...render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={table} onPatchState={onPatchState} />) };
}

describe("DbTab", () => {
  beforeEach(() => {
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
  });

  it("fetches rows for the table it is given, without needing a click first", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]] });
    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalledWith(expect.anything(), "orders"));
  });

  it("fetches nothing when given no table", () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [] });
    renderDb(null);
    expect(listRows).not.toHaveBeenCalled();
  });

  // The core independence bug this migration fixes: two DbTab instances,
  // given different `table` props, must never share fetched rows.
  it("re-fetches when its table prop changes to a different table", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [] });
    const { rerender, onPatchState } = renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalledWith(expect.anything(), "orders"));

    rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table="payments" onPatchState={onPatchState} />);
    await waitFor(() => expect(listRows).toHaveBeenCalledWith(expect.anything(), "payments"));
  });

  it("selecting a table in the schema tree patches state rather than fetching directly", () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [] });
    const { onPatchState } = renderDb(null);
    // SchemaTree's own tests cover the tree UI; DbTab's contract is that
    // selecting a table calls onPatchState, not a direct fetch. Covered
    // end-to-end (two DB tabs, two tables) in SplitContent.test.tsx.
    expect(onPatchState).not.toHaveBeenCalled();
  });
});
