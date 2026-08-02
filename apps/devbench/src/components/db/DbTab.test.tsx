import { useState } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { DbTab } from "./DbTab";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";
import type { TableRows, QueryPreview } from "../../lib/tauri";

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
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(0);
    useAppStore.getState().setActiveConnectionId("c1");
  });

  it("fetches rows for the table it is given, without needing a click first", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: null });
    renderDb("orders");
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        "orders",
        expect.objectContaining({ orderBy: [], offset: 0 }),
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
        expect.objectContaining({ orderBy: [{ column: "status", descending: false, enabled: true }], offset: 0 }),
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
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ orderBy: [{ column: "status", descending: false, enabled: true }] })));
    fireEvent.click(sortButton);
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ orderBy: [{ column: "status", descending: true, enabled: true }] })));
  });

  // Page count now comes from a separate invokeCountTableRows call, fired
  // alongside the row fetch rather than derived from how many rows came back.
  it("advances to the next page and requests the corresponding offset", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"],
      rows: [["1"]],
      pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(150);

    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));

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
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(100);

    renderDb("orders");
    expect(await screen.findByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("sends the applied filter to both the row query and the count", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "paid"]], pk_column: "id",
    });
    const count = vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(1);

    renderDb("orders");
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    // FilterPopover disambiguates per-row controls as "Filter column, condition
    // N" (a11y fix from an earlier task) — a plain-string match here would miss.
    fireEvent.change(screen.getByRole("combobox", { name: /^Filter column/ }), { target: { value: "status" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter value" }), { target: { value: "paid" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const expected = [{ column: "status", op: "eq", value: "paid", enabled: true }];
    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ filter: expected, offset: 0 })),
    );
    expect(count).toHaveBeenLastCalledWith("c1", "orders", expected);
  });

  it("derives the page count from the total, not from the fetched rows", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(250);

    renderDb("orders");
    // 250 rows at 100 per page is 3 pages.
    expect(await screen.findByText("of 3")).toBeInTheDocument();
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
      expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ orderBy: [{ column: "status", descending: false, enabled: true }] })),
    );

    await act(async () => {
      useAppStore.getState().setActiveConnectionId("c2");
    });

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c2",
        "orders",
        expect.objectContaining({ orderBy: [], offset: 0 }),
      ),
    );
  });

  it("selecting a different table resets sort and page", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"],
      rows: [["1"]],
      pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(150);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
      { schema: "public", name: "payments" },
    ]);

    render(<DbTabHarness initialTable="orders" />);
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", "orders", expect.objectContaining({ offset: 100 })));

    fireEvent.click(await screen.findByRole("button", { name: "Browse payments" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c1",
        "payments",
        expect.objectContaining({ orderBy: [], offset: 0 }),
      ),
    );
  });

  // Regression guard for a bug caught in review: the previous table's grid
  // (with its own toolbar and sort columns) stayed mounted and clickable
  // for the entire window between selecting a new table and that table's
  // first fetch resolving. A Next click landed during that window before
  // requested an offset against a table whose page 0 had never been fetched.
  // This interacts *during* the loading window rather than after
  // `waitFor`-settling it, which is the only way to catch this class of bug.
  it("makes the grid's Next control unavailable while switching to a table that hasn't loaded yet", async () => {
    const deferredPaymentsFetch: { resolve: ((value: TableRows) => void) | null } = { resolve: null };
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation((_conn, t) => {
      if (t === "orders") {
        return Promise.resolve({ columns: ["id"], rows: [["1"]], pk_column: "id" });
      }
      return new Promise<TableRows>((resolve) => {
        deferredPaymentsFetch.resolve = resolve;
      });
    });
    // orders spans multiple pages (Next enabled); payments' single row is
    // one page (Next ends up disabled once it loads).
    vi.spyOn(tauriLib, "invokeCountTableRows").mockImplementation((_conn, t) =>
      Promise.resolve(t === "orders" ? 150 : 1),
    );
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
      { schema: "public", name: "payments" },
    ]);

    render(<DbTabHarness initialTable="orders" />);
    await waitFor(() => expect(listRows).toHaveBeenCalledWith("c1", "orders", expect.anything()));
    expect(await screen.findByRole("button", { name: "Next page" })).not.toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Browse payments" }));

    // Still inside payments' loading window: orders' toolbar — and its Next
    // control, which described orders' pages, not payments' — must be gone,
    // not merely disabled-but-present-and-stale.
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(listRows).not.toHaveBeenCalledWith("c1", "payments", expect.objectContaining({ offset: 100 }));

    expect(deferredPaymentsFetch.resolve).not.toBeNull();
    deferredPaymentsFetch.resolve?.({ columns: ["id"], rows: [["1"]], pk_column: "id" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled());
    expect(listRows).toHaveBeenLastCalledWith("c1", "payments", expect.objectContaining({ orderBy: [], offset: 0 }));
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
      if (opts?.orderBy?.[0]?.column === "status") {
        return new Promise<TableRows>((resolve) => {
          deferredStatusFetch.resolve = resolve;
        });
      }
      if (opts?.orderBy?.[0]?.column === "id") {
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

  describe("query console", () => {
    it("opens and closes the query console via the toggle button, without hiding Browse", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: "id" });

      renderDb("orders");
      await waitFor(() => screen.getByText("1"));

      expect(screen.queryByPlaceholderText("SELECT * FROM orders LIMIT 10;")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Query console" }));

      expect(await screen.findByPlaceholderText("SELECT * FROM orders LIMIT 10;")).toBeInTheDocument();
      // Browse's own grid keeps rendering the whole time the console is
      // open — it's a sibling panel, not a mode that replaces the grid.
      expect(screen.getByText("1")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Query console" }));
      await waitFor(() =>
        expect(screen.queryByPlaceholderText("SELECT * FROM orders LIMIT 10;")).not.toBeInTheDocument(),
      );
    });

    // Real production path for the hazard the task brief calls out: closing
    // the drawer unmounts QueryConsole (DbTab only renders it while
    // consoleOpen). An uncommitted preview left open at that moment holds a
    // real transaction and row lock that must not leak for the sweep's full
    // ~2-minute window just because the drawer was toggled shut — this
    // proves the actual DbTab wiring exercises that cleanup, not just the
    // isolated QueryConsole unit tests.
    it("closing the console with an open, uncommitted preview rolls it back", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: "id" });
      vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });
      const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

      renderDb("orders");
      await waitFor(() => screen.getByText("1"));
      fireEvent.click(screen.getByRole("button", { name: "Query console" }));
      const textarea = await screen.findByPlaceholderText("SELECT * FROM orders LIMIT 10;");
      fireEvent.change(textarea, { target: { value: "UPDATE orders SET status = 'x'" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      await screen.findByRole("button", { name: "Commit" });

      fireEvent.click(screen.getByRole("button", { name: "Query console" }));

      await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
    });
  });

  describe("inline cell editing", () => {
    it("clicking an editable cell shows an input; previewing shows a diff; committing updates the grid", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"],
        rows: [["1", "pending"]],
        pk_column: "id",
      });
      const preview = vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });
      const commit = vi.spyOn(tauriLib, "invokeCommitPreview").mockResolvedValue(undefined);

      renderDb("orders");
      await waitFor(() => screen.getByText("pending"));

      fireEvent.click(screen.getByText("pending"));
      const input = await screen.findByDisplayValue("pending");
      fireEvent.change(input, { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));

      await waitFor(() => expect(preview).toHaveBeenCalledWith("c1", "orders", "id", "1", "status", "shipped"));
      expect(await screen.findByText("shipped")).toBeInTheDocument();
      expect(screen.getByText("pending")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Commit edit" }));

      await waitFor(() => expect(commit).toHaveBeenCalledWith("p1"));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Commit edit" })).not.toBeInTheDocument());
    });

    it("rolling back an edit discards the draft and calls rollback_preview", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"],
        rows: [["1", "pending"]],
        pk_column: "id",
      });
      vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });
      const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

      renderDb("orders");
      await waitFor(() => screen.getByText("pending"));

      fireEvent.click(screen.getByText("pending"));
      fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
      await screen.findByRole("button", { name: "Rollback edit" });

      fireEvent.click(screen.getByRole("button", { name: "Rollback edit" }));

      await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
      expect(await screen.findByText("pending")).toBeInTheDocument();
    });

    it("cells are not clickable to edit when the table has no single-column primary key", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["tenant_id", "item_id"],
        rows: [["t1", "i1"]],
        pk_column: null,
      });

      renderDb("payments");
      await waitFor(() => screen.getByText("t1"));

      fireEvent.click(screen.getByText("t1"));
      expect(screen.queryByRole("textbox", { name: /^Edit / })).not.toBeInTheDocument();
      expect(screen.getByText(/No single-column primary key/)).toBeInTheDocument();
    });

    // The backend renders an unstringifiable value as this literal marker
    // (distinct from NULL) — editing it would mean overwriting something the
    // user never actually saw, PK or no PK.
    it("cells showing <unsupported type> are not editable even when the table has a primary key", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status", "payload"],
        rows: [["1", "pending", "<unsupported type>"]],
        pk_column: "id",
      });

      renderDb("orders");
      await waitFor(() => screen.getByText("<unsupported type>"));

      // Prove editing works at all in this row first — an ordinary cell in
      // the same row must open — so the assertion below can't pass simply
      // because nothing in the row is editable yet.
      fireEvent.click(screen.getByText("pending"));
      expect(await screen.findByDisplayValue("pending")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));

      fireEvent.click(screen.getByText("<unsupported type>"));
      expect(screen.queryByRole("textbox", { name: /^Edit / })).not.toBeInTheDocument();
    });

    // NULL and "" are different values on the wire (preview_cell_edit takes
    // `value: string | null`), so opening a NULL cell must not silently turn
    // it into an empty string. The editor carries no NULL control — an
    // untouched draft simply stays null all the way to the request.
    it("editing a NULL cell previews null rather than an empty string when the draft is untouched", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"],
        rows: [["1", null]],
        pk_column: "id",
      });
      const preview = vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });

      renderDb("orders");
      await waitFor(() => screen.getByText("NULL"));

      fireEvent.click(screen.getByText("NULL"));
      const input = await screen.findByRole("textbox", { name: /^Edit / });
      expect(input).toBeEnabled();
      expect(input).toHaveValue("");
      expect(screen.queryByRole("checkbox", { name: "NULL" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
      await waitFor(() => expect(preview).toHaveBeenCalledWith("c1", "orders", "id", "1", "status", null));
    });

    // This is the design point the task brief calls out explicitly: an open
    // preview is a live transaction (and row lock) on the user's database.
    // Navigating away from it must roll it back, not just drop the local
    // state and leak the transaction until the ~2-minute sweep catches it.
    it("switching tables while a preview is open rolls back the abandoned preview instead of leaking it", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"],
        rows: [["1", "pending"]],
        pk_column: "id",
      });
      vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });
      const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

      const { rerender, onPatchState } = renderDb("orders");
      await waitFor(() => screen.getByText("pending"));
      fireEvent.click(screen.getByText("pending"));
      fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
      await screen.findByRole("button", { name: "Rollback edit" });

      rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table="payments" onPatchState={onPatchState} />);

      await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
    });

    // Failure-honesty regression guard: a failed preview must not silently
    // discard the user's typed draft, and must not be indistinguishable from
    // a successful one.
    it("a failed preview reports the failure and keeps the draft editable rather than discarding it", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"],
        rows: [["1", "pending"]],
        pk_column: "id",
      });
      vi.spyOn(tauriLib, "invokePreviewCellEdit").mockRejectedValue(
        new Error("expected to match exactly 1 row by id = 1, matched 0"),
      );

      renderDb("orders");
      await waitFor(() => screen.getByText("pending"));
      fireEvent.click(screen.getByText("pending"));
      fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));

      expect(await screen.findByText(/matched 0/)).toBeInTheDocument();
      expect(screen.getByDisplayValue("shipped")).toBeInTheDocument();
    });

    // Failure-honesty regression guard, commit side: an expired preview (the
    // background sweep can beat the user to a commit) must read as neither
    // "committed" nor "nothing happened" — and must not blank the grid the
    // way the shared fetch-error state would.
    it("a failed commit reports the failure, does not apply the edit, and leaves the grid visible", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"],
        rows: [["1", "pending"]],
        pk_column: "id",
      });
      vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });
      vi.spyOn(tauriLib, "invokeCommitPreview").mockRejectedValue(new Error("no open preview with id p1"));

      renderDb("orders");
      await waitFor(() => screen.getByText("pending"));
      fireEvent.click(screen.getByText("pending"));
      fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
      await screen.findByRole("button", { name: "Commit edit" });

      fireEvent.click(screen.getByRole("button", { name: "Commit edit" }));

      expect(await screen.findByText(/expired/i)).toBeInTheDocument();
      // The failure banner sits beside the grid, not instead of it.
      expect(screen.getByRole("table")).toBeInTheDocument();
      // Dropped back into an editable draft, not silently committed or wiped.
      expect(screen.getByDisplayValue("shipped")).toBeInTheDocument();
    });

    // Review-round regression guards: none of the tests above ever interact
    // *during* a pending preview/commit request — every one of them awaits
    // settlement first. That's exactly what let a missing staleness guard on
    // these three handlers hide: fetchRows has always had one (requestIdRef);
    // previewEdit/commitEdit/rollbackEdit didn't. These four fire the second
    // action (or the navigation) before the first request's deferred promise
    // resolves, on purpose.
    describe("interacting while a preview/commit request is still in flight", () => {
      it("double-clicking Commit edit fires exactly one commit request and reports the true outcome", async () => {
        vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
          columns: ["id", "status"],
          rows: [["1", "pending"]],
          pk_column: "id",
        });
        vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
          preview_id: "p1",
          columns: [],
          rows: [],
          rows_affected: 1,
        });
        const deferredCommit: { resolve: (() => void) | null } = { resolve: null };
        const commit = vi
          .spyOn(tauriLib, "invokeCommitPreview")
          .mockImplementation(() => new Promise<void>((resolve) => (deferredCommit.resolve = resolve)));

        renderDb("orders");
        await waitFor(() => screen.getByText("pending"));
        fireEvent.click(screen.getByText("pending"));
        fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
        const commitButton = await screen.findByRole("button", { name: "Commit edit" });

        // Two clicks before the first's request resolves — the second must
        // land on an already-disabled button, not fire a second request.
        fireEvent.click(commitButton);
        fireEvent.click(commitButton);
        expect(commit).toHaveBeenCalledTimes(1);

        await act(async () => {
          deferredCommit.resolve?.();
          await Promise.resolve();
        });

        // The single commit succeeded — it must be reported as a success,
        // not clobbered by a phantom second response.
        await waitFor(() => expect(screen.queryByRole("button", { name: "Commit edit" })).not.toBeInTheDocument());
        expect(screen.getByText("shipped")).toBeInTheDocument();
        expect(screen.queryByText(/nothing was written/i)).not.toBeInTheDocument();
      });

      it("switching tables while Preview is in flight rolls back the preview once it lands, without resurrecting it on the new table", async () => {
        vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation(async (_conn, t) => ({
          columns: ["id", "status"],
          rows: [["1", t === "orders" ? "pending" : "waiting"]],
          pk_column: "id",
        }));
        const deferredPreview: { resolve: ((v: QueryPreview) => void) | null } = { resolve: null };
        vi.spyOn(tauriLib, "invokePreviewCellEdit").mockImplementation(
          () => new Promise<QueryPreview>((resolve) => (deferredPreview.resolve = resolve)),
        );
        const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

        const { rerender, onPatchState } = renderDb("orders");
        await waitFor(() => screen.getByText("pending"));
        fireEvent.click(screen.getByText("pending"));
        fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
        // Still in flight — no preview UI exists yet to abandon.
        expect(screen.queryByRole("button", { name: "Commit edit" })).not.toBeInTheDocument();

        rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table="payments" onPatchState={onPatchState} />);
        await waitFor(() => expect(screen.getByText("waiting")).toBeInTheDocument());

        // The request lands late, against a table the user has since left.
        await act(async () => {
          deferredPreview.resolve?.({ preview_id: "p1", columns: [], rows: [], rows_affected: 1 });
          await Promise.resolve();
        });

        await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
        expect(screen.queryByRole("button", { name: "Commit edit" })).not.toBeInTheDocument();
        expect(screen.getByText("waiting")).toBeInTheDocument();
      });

      it("switching tables while Commit is in flight does not replace the new table's grid with the old table's rows", async () => {
        vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation(async (_conn, t) => ({
          columns: ["id", "status"],
          rows: [["1", t === "orders" ? "pending" : "waiting"]],
          pk_column: "id",
        }));
        vi.spyOn(tauriLib, "invokePreviewCellEdit").mockResolvedValue({
          preview_id: "p1",
          columns: [],
          rows: [],
          rows_affected: 1,
        });
        const deferredCommit: { resolve: (() => void) | null } = { resolve: null };
        vi.spyOn(tauriLib, "invokeCommitPreview").mockImplementation(
          () => new Promise<void>((resolve) => (deferredCommit.resolve = resolve)),
        );

        const { rerender, onPatchState } = renderDb("orders");
        await waitFor(() => screen.getByText("pending"));
        fireEvent.click(screen.getByText("pending"));
        fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
        fireEvent.click(await screen.findByRole("button", { name: "Commit edit" }));

        rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table="payments" onPatchState={onPatchState} />);
        await waitFor(() => expect(screen.getByText("waiting")).toBeInTheDocument());

        // The commit lands after the switch — it did write "shipped" for
        // real on orders, but that must not overwrite payments' own grid.
        await act(async () => {
          deferredCommit.resolve?.();
          await Promise.resolve();
        });

        expect(screen.getByText("waiting")).toBeInTheDocument();
        expect(screen.queryByText("shipped")).not.toBeInTheDocument();
      });

      it("cancelling while Preview is in flight discards the draft and rolls the preview back once it lands, instead of resurrecting it", async () => {
        vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
          columns: ["id", "status"],
          rows: [["1", "pending"]],
          pk_column: "id",
        });
        const deferredPreview: { resolve: ((v: QueryPreview) => void) | null } = { resolve: null };
        vi.spyOn(tauriLib, "invokePreviewCellEdit").mockImplementation(
          () => new Promise<QueryPreview>((resolve) => (deferredPreview.resolve = resolve)),
        );
        const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

        renderDb("orders");
        await waitFor(() => screen.getByText("pending"));
        fireEvent.click(screen.getByText("pending"));
        fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview change" }));

        fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
        expect(screen.getByText("pending")).toBeInTheDocument();

        await act(async () => {
          deferredPreview.resolve?.({ preview_id: "p1", columns: [], rows: [], rows_affected: 1 });
          await Promise.resolve();
        });

        expect(rollback).toHaveBeenCalledWith("p1");
        expect(screen.queryByRole("button", { name: "Commit edit" })).not.toBeInTheDocument();
        expect(screen.getByText("pending")).toBeInTheDocument();
      });

      // The sharpest case: no component left to react at all. previewEdit is
      // a plain async function invoked from onClick — React unmounting the
      // component does not tear down that in-flight call or its continuation.
      // The stale-success branch has to recover using only editGenerationRef
      // (a plain ref, unaffected by unmount) and the rollback call itself —
      // no setState involved — since this is the one abandonment path with
      // no live component afterward to show a Rollback button on.
      it("unmounting while Preview is in flight rolls back the preview once it lands, with no live component to react to it", async () => {
        vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
          columns: ["id", "status"],
          rows: [["1", "pending"]],
          pk_column: "id",
        });
        const deferredPreview: { resolve: ((v: QueryPreview) => void) | null } = { resolve: null };
        vi.spyOn(tauriLib, "invokePreviewCellEdit").mockImplementation(
          () => new Promise<QueryPreview>((resolve) => (deferredPreview.resolve = resolve)),
        );
        const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

        const { unmount } = renderDb("orders");
        await waitFor(() => screen.getByText("pending"));
        fireEvent.click(screen.getByText("pending"));
        fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview change" }));

        unmount();

        await act(async () => {
          deferredPreview.resolve?.({ preview_id: "p1", columns: [], rows: [], rows_affected: 1 });
          await Promise.resolve();
        });

        expect(rollback).toHaveBeenCalledWith("p1");
      });
    });
  });
});
