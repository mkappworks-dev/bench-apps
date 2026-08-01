import { useState } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { DbTab } from "./DbTab";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";
import type { TableRows } from "../../lib/tauri";

// DbTab renders DataGrid, which virtualizes rows via TanStack Virtual. jsdom
// gives every element a height of 0, which makes the virtualizer compute a
// zero-row viewport (see DataGrid.test.tsx for the same fix).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => {} };
  };
});

function renderDb(table: string | null, onPatchState = vi.fn()) {
  return { onPatchState, ...render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={table} onPatchState={onPatchState} />) };
}

// DbTab is a controlled component — `table` comes from the parent's tab
// state, changed only by calling `onPatchState`. This harness plays the
// parent's role so tests can drive a real table switch the way ToolPane
// does, instead of asserting on onPatchState in isolation.
function DbTabHarness({ initialTable }: { initialTable: string | null }) {
  const [table, setTable] = useState(initialTable);
  return (
    <DbTab
      watchedTables={new Set()}
      onToggleWatch={() => {}}
      table={table}
      onPatchState={(patch) => setTable(patch.table)}
    />
  );
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
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        "orders",
        expect.objectContaining({ orderByColumn: null, orderByDesc: false, offset: 0 }),
      ),
    );
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
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith("c1", "orders", expect.objectContaining({ offset: 0 })),
    );

    rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table="payments" onPatchState={onPatchState} />);
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith("c1", "payments", expect.objectContaining({ offset: 0 })),
    );
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

  it("sorts by clicking a column header, resetting to page 0", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["1", "pending"]],
      pk_column: "id",
    });

    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Sort by status" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c1",
        "orders",
        expect.objectContaining({ orderByColumn: "status", orderByDesc: false, offset: 0 }),
      ),
    );
  });

  it("clicking the same column header again reverses sort direction", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["1", "pending"]],
      pk_column: "id",
    });

    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    const sortButton = await screen.findByRole("button", { name: "Sort by status" });
    fireEvent.click(sortButton);
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ orderByDesc: false })));
    fireEvent.click(sortButton);
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ orderByDesc: true })));
  });

  // The backend never returns a total count, so a request for PAGE_SIZE+1
  // rows is how hasNextPage is grounded in fact instead of guessed from "the
  // page came back full" — a table with exactly 100 rows would otherwise
  // show a Next button that leads nowhere.
  it("advances to the next page and requests the corresponding offset", async () => {
    const overfullPage = Array.from({ length: 101 }, (_, i) => [String(i)]);
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"],
      rows: overfullPage,
      pk_column: "id",
    });

    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ offset: 100 })),
    );
  });

  it("does not offer a next page when the fetch returns exactly a page's worth of rows", async () => {
    const exactPage = Array.from({ length: 100 }, (_, i) => [String(i)]);
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"],
      rows: exactPage,
      pk_column: "id",
    });

    renderDb("orders");
    expect(await screen.findByRole("button", { name: "Next" })).toBeDisabled();
  });

  // Same reasoning as a table switch, one level up: the table stays open but
  // its old sort/page no longer describe a request against the new connection.
  it("switching the active connection resets sort and page for the table that stays open", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["1", "pending"]],
      pk_column: "id",
    });

    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Sort by status" }));
    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ orderByColumn: "status" })),
    );

    await act(async () => {
      useAppStore.getState().setActiveConnectionId("c2");
    });

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c2",
        "orders",
        expect.objectContaining({ orderByColumn: null, offset: 0 }),
      ),
    );
  });

  it("selecting a different table resets sort and page", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"],
      rows: Array.from({ length: 101 }, (_, i) => [String(i)]),
      pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
      { schema: "public", name: "payments" },
    ]);

    render(<DbTabHarness initialTable="orders" />);
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ offset: 100 })));

    fireEvent.click(await screen.findByRole("button", { name: "Browse payments" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c1",
        "payments",
        expect.objectContaining({ orderByColumn: null, offset: 0 }),
      ),
    );
  });

  // Regression guard for a bug caught in review: the previous table's grid
  // (with its own hasNextPage and sort columns) stayed mounted and clickable
  // for the entire window between selecting a new table and that table's
  // first fetch resolving. A Next click landed during that window before
  // requested an offset against a table whose page 0 had never been fetched.
  // This interacts *during* the loading window rather than after
  // `waitFor`-settling it, which is the only way to catch this class of bug.
  it("makes the grid's Next control unavailable while switching to a table that hasn't loaded yet", async () => {
    const deferredPaymentsFetch: { resolve: ((value: TableRows) => void) | null } = { resolve: null };
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation((_conn, t) => {
      if (t === "orders") {
        return Promise.resolve({
          columns: ["id"],
          rows: Array.from({ length: 101 }, (_, i) => [String(i)]),
          pk_column: "id",
        });
      }
      return new Promise<TableRows>((resolve) => {
        deferredPaymentsFetch.resolve = resolve;
      });
    });
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
      { schema: "public", name: "payments" },
    ]);

    render(<DbTabHarness initialTable="orders" />);
    await waitFor(() => expect(listRows).toHaveBeenCalledWith("c1", "orders", expect.anything()));
    expect(await screen.findByRole("button", { name: "Next" })).not.toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Browse payments" }));

    // Still inside payments' loading window: orders' grid — and its Next
    // button, which described orders' pages, not payments' — must be gone,
    // not merely disabled-but-present-and-stale.
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(listRows).not.toHaveBeenCalledWith("c1", "payments", expect.objectContaining({ offset: 100 }));

    expect(deferredPaymentsFetch.resolve).not.toBeNull();
    deferredPaymentsFetch.resolve?.({ columns: ["id"], rows: [["1"]], pk_column: "id" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeDisabled());
    expect(listRows).toHaveBeenLastCalledWith("c1", "payments", expect.objectContaining({ orderByColumn: null, offset: 0 }));
  });

  // Regression guard for the race a naive implementation hits: firing a sort
  // click while a previous one is still in flight must not let the slower,
  // now-superseded response overwrite the newer one once it finally resolves.
  it("discards a slower in-flight fetch once a newer request has superseded it", async () => {
    // A plain closure variable reassigned only inside the nested Promise
    // executor gets over-narrowed to `null` by TS's flow analysis at the read
    // site below; a holder object sidesteps that.
    const deferredStatusFetch: { resolve: ((value: TableRows) => void) | null } = { resolve: null };
    vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation((_conn, _table, opts) => {
      if (opts?.orderByColumn === "status") {
        return new Promise<TableRows>((resolve) => {
          deferredStatusFetch.resolve = resolve;
        });
      }
      if (opts?.orderByColumn === "id") {
        return Promise.resolve({ columns: ["id", "status"], rows: [["1", "by-id"]], pk_column: "id" });
      }
      return Promise.resolve({ columns: ["id", "status"], rows: [["1", "unsorted"]], pk_column: "id" });
    });

    renderDb("orders");
    await waitFor(() => expect(screen.getByText("unsorted")).toBeInTheDocument());

    fireEvent.click(await screen.findByRole("button", { name: "Sort by status" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sort by id" }));
    await waitFor(() => expect(screen.getByText("by-id")).toBeInTheDocument());

    expect(deferredStatusFetch.resolve).not.toBeNull();
    deferredStatusFetch.resolve?.({ columns: ["id", "status"], rows: [["1", "STALE-status"]], pk_column: "id" });
    await Promise.resolve();

    expect(screen.queryByText("STALE-status")).not.toBeInTheDocument();
    expect(screen.getByText("by-id")).toBeInTheDocument();
  });
});
