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

const ORDERS = { schema: "public", name: "orders" };
const PAYMENTS = { schema: "public", name: "payments" };

function renderDb(table: tauriLib.QualifiedTable | string | null, onPatchState = vi.fn()) {
  return { onPatchState, ...render(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={table} onPatchState={onPatchState} />) };
}

// DbTab is a controlled component — `table` comes from the parent's tab
// state, changed only by calling `onPatchState`. This harness plays the
// parent's role so tests can drive a real table switch the way ToolPane
// does, instead of asserting on onPatchState in isolation.
function DbTabHarness({ initialTable }: { initialTable: tauriLib.QualifiedTable | null }) {
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
    localStorage.clear();
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(0);
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([]);
    useAppStore.getState().setActiveConnectionId("c1");
  });

  it("describes the selected table's columns once, with its schema", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });
    const describeColumns = vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([]);

    renderDb({ schema: "alt", name: "orders" });

    await waitFor(() =>
      expect(describeColumns).toHaveBeenCalledWith("c1", { schema: "alt", name: "orders" }),
    );
    // The schema does not change when the page or the filter does, so this is
    // fetched per table, not per query.
    expect(describeColumns).toHaveBeenCalledTimes(1);
  });

  // Slice 1 inferred the family from a sample value. A text column whose
  // values happen to be digits was offered `>` and `<`, which SQL will happily
  // run on text with results nobody wants.
  it("offers filter operators from the real column type, not from the values", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["ref_code"], rows: [["4821"]], pk_column: null,
    });
    const describeColumns = vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([
      {
        name: "ref_code",
        udt: "text",
        nullable: true,
        default_expr: null,
        is_identity: false,
        references: null,
      },
    ]);

    renderDb(ORDERS);
    await waitFor(() => expect(describeColumns).toHaveBeenCalled());
    await screen.findByText("4821");

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add filter" }));

    await waitFor(() => {
      const operators = screen.getByRole("combobox", { name: "Filter operator, condition 1" });
      expect([...operators.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
        "=", "≠", "contains", "starts with", "is null", "is not null",
      ]);
    });
  });

  it("fetches rows for the table it is given, without needing a click first", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: null });
    renderDb(ORDERS);
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        ORDERS,
        expect.objectContaining({ orderBy: [], offset: 0 }),
      ),
    );
  });

  it("fetches nothing when given no table", () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [], pk_column: null });
    renderDb(null);
    expect(listRows).not.toHaveBeenCalled();
  });

  it("fetches the selected table with its schema", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });

    renderDb({ schema: "alt", name: "orders" });

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        { schema: "alt", name: "orders" },
        expect.anything(),
      ),
    );
  });

  // A tab persisted before schemas existed stores a bare string. Resolving it
  // to public keeps the tab open across the upgrade instead of blanking it.
  it("reads a legacy bare table name as public", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });

    renderDb("orders");

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        { schema: "public", name: "orders" },
        expect.anything(),
      ),
    );
  });

  // The core independence bug this migration fixes: two DbTab instances,
  // given different `table` props, must never share fetched rows.
  it("re-fetches when its table prop changes to a different table", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [], pk_column: null });
    const { rerender, onPatchState } = renderDb(ORDERS);
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith("c1", ORDERS, expect.objectContaining({ offset: 0 })),
    );

    rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={PAYMENTS} onPatchState={onPatchState} />);
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith("c1", PAYMENTS, expect.objectContaining({ offset: 0 })),
    );
  });

  // Regression guard for a bug verified manually (freezing a column on
  // public.dup did not leak to alt.dup) but never pinned by a repeatable
  // test: the grid layout key must be scoped by schema, not table name
  // alone, or two same-named tables in different schemas would share one
  // saved layout. Asserts on localStorage keys and the pin button's
  // aria-pressed state only — not on layout geometry, which jsdom can't
  // give a meaningful answer for (see DataGrid.test.tsx).
  it("scopes the saved grid layout to schema, not table name alone", async () => {
    localStorage.clear();
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });

    const { rerender, onPatchState } = renderDb({ schema: "public", name: "dup" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Freeze id" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Freeze id" }));
    expect(screen.getByRole("button", { name: "Unfreeze id" })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("devbench.grid-layout.c1:public.dup")).toContain('"pinned":["id"]');

    rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={{ schema: "alt", name: "dup" }} onPatchState={onPatchState} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Freeze id" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Freeze id" })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("devbench.grid-layout.c1:alt.dup")).toBeNull();
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
    renderDb(ORDERS);
    expect(screen.getByText("Select a connection to browse its data.")).toBeInTheDocument();
    expect(listRows).not.toHaveBeenCalled();
  });

  it("sorts by clicking a column header, resetting to page 0", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["1", "pending"]],
      pk_column: "id",
    });

    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Sort by status" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c1",
        ORDERS,
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

    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    const sortButton = await screen.findByRole("button", { name: "Sort by status" });
    fireEvent.click(sortButton);
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ orderBy: [{ column: "status", descending: false, enabled: true }] })));
    fireEvent.click(sortButton);
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ orderBy: [{ column: "status", descending: true, enabled: true }] })));
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

    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ offset: 100 })),
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

    renderDb(ORDERS);
    expect(await screen.findByRole("button", { name: "Next page" })).toBeDisabled();
  });

  // Regression guard: GridToolbar's rows-per-page <select> calls
  // onLimitChange then onPageChange synchronously in one onChange. Both are
  // this render's DbTab closures; without a synchronously-updated ref for
  // "the limit to fetch with," onPageChange's own fetchRows call would still
  // read the PRE-change limit and — since it fires second — win the
  // requestId race, silently reverting the effective page size.
  it("changing rows per page fetches with the new limit, not the pre-change one", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(500);

    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.change(screen.getByRole("combobox", { name: "Rows per page" }), { target: { value: "250" } });

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ limit: 250, offset: 0 })),
    );
  });

  // The toolbar's rows-per-page control calls onLimitChange and then
  // onPageChange. Only the second may fetch: fetching from both bills every
  // page-size change two round trips (and two counts), and the first one's
  // result is thrown away by the requestId race anyway.
  it("changing rows per page issues exactly one row query and one count", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });
    const count = vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(500);

    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    listRows.mockClear();
    count.mockClear();

    // Both handlers run synchronously inside the change event, so the call
    // counts are already final here — no waitFor needed, and none that could
    // mask a second query arriving late.
    fireEvent.change(screen.getByRole("combobox", { name: "Rows per page" }), { target: { value: "250" } });

    expect(listRows).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
    expect(listRows).toHaveBeenCalledWith("c1", ORDERS, expect.objectContaining({ limit: 250, offset: 0 }));
  });

  it("sends the applied filter to both the row query and the count", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "paid"]], pk_column: "id",
    });
    const count = vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(1);

    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    // FilterPopover disambiguates per-row controls as "Filter column, condition
    // N" (a11y fix from an earlier task) — a plain-string match here would miss.
    fireEvent.change(screen.getByRole("combobox", { name: /^Filter column/ }), { target: { value: "status" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Filter value/ }), { target: { value: "paid" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const expected = [{ column: "status", op: "eq", value: "paid", enabled: true }];
    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ filter: expected, offset: 0 })),
    );
    expect(count).toHaveBeenLastCalledWith("c1", ORDERS, expected);
  });

  // A failing query is usually a filter the user just applied. Replacing the
  // whole grid with an error box takes the Filter popover away with it, and
  // switching tables becomes the only escape.
  it("keeps the toolbar reachable when a filter produces a server error", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "paid"]], pk_column: "id",
    });
    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    listRows.mockRejectedValueOnce(new Error("operator does not exist"));
    fireEvent.click(await screen.findByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Filter value/ }), { target: { value: "boom" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("operator does not exist");

    // The whole point: the user can still get back into the filter and undo it.
    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    fireEvent.click(screen.getByRole("button", { name: /remove condition/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ filter: [] })),
    );
  });

  // The backend derives `columns` from the first row, so zero matches means
  // zero columns — which must not empty the popovers' column pickers.
  it("keeps real column names in the popovers after a filter matches no rows", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "paid"]], pk_column: "id",
    });
    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());

    listRows.mockResolvedValue({ columns: [], rows: [], pk_column: "id" });
    fireEvent.click(await screen.findByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Filter value/ }), { target: { value: "nothing-matches" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(listRows).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    // Condition 2 is the freshly added one, which seeds itself from columns[0]
    // — the case that used to produce `{ column: undefined }`.
    const columnPicker = screen.getByRole("combobox", { name: "Filter column, condition 2" });
    expect(Array.from(columnPicker.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["id", "status"]);
    expect(columnPicker).toHaveValue("id");
  });

  it("derives the page count from the total, not from the fetched rows", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(250);

    renderDb(ORDERS);
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

    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Sort by status" }));
    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ orderBy: [{ column: "status", descending: false, enabled: true }] })),
    );

    await act(async () => {
      useAppStore.getState().setActiveConnectionId("c2");
    });

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c2",
        ORDERS,
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
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([ORDERS, PAYMENTS]);

    render(<DbTabHarness initialTable={ORDERS} />);
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ offset: 100 })));

    fireEvent.click(await screen.findByRole("button", { name: "Browse public.payments" }));

    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith(
        "c1",
        PAYMENTS,
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
      if (t.name === "orders") {
        return Promise.resolve({ columns: ["id"], rows: [["1"]], pk_column: "id" });
      }
      return new Promise<TableRows>((resolve) => {
        deferredPaymentsFetch.resolve = resolve;
      });
    });
    // orders spans multiple pages (Next enabled); payments' single row is
    // one page (Next ends up disabled once it loads).
    vi.spyOn(tauriLib, "invokeCountTableRows").mockImplementation((_conn, t) =>
      Promise.resolve(t.name === "orders" ? 150 : 1),
    );
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([ORDERS, PAYMENTS]);

    render(<DbTabHarness initialTable={ORDERS} />);
    await waitFor(() => expect(listRows).toHaveBeenCalledWith("c1", ORDERS, expect.anything()));
    expect(await screen.findByRole("button", { name: "Next page" })).not.toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Browse public.payments" }));

    // Still inside payments' loading window: orders' toolbar — and its Next
    // control, which described orders' pages, not payments' — must be gone,
    // not merely disabled-but-present-and-stale.
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(listRows).not.toHaveBeenCalledWith("c1", PAYMENTS, expect.objectContaining({ offset: 100 }));

    expect(deferredPaymentsFetch.resolve).not.toBeNull();
    deferredPaymentsFetch.resolve?.({ columns: ["id"], rows: [["1"]], pk_column: "id" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled());
    expect(listRows).toHaveBeenLastCalledWith("c1", PAYMENTS, expect.objectContaining({ orderBy: [], offset: 0 }));
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

    renderDb(ORDERS);
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

  const FK_META = [
    {
      name: "id",
      udt: "int4",
      nullable: false,
      default_expr: null,
      is_identity: true,
      references: null,
    },
    {
      name: "user_id",
      udt: "text",
      nullable: false,
      default_expr: null,
      is_identity: false,
      references: { schema: "public", table: "users", column: "id" },
    },
  ];

  function mockFkTable(rows: (string | null)[][] = [["1", "usr_88"]]) {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "user_id"], rows, pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue(FK_META);
  }

  // Spec §8: the icon marks a column with a target, and only such a column.
  it("shows a link icon only on cells in a column with a foreign key", async () => {
    mockFkTable();
    renderDb(ORDERS);

    const link = await screen.findByRole("button", { name: /public\.users\.id/ });
    expect(link).toBeInTheDocument();
    // One keyed column, one row: exactly one icon. `id` has no target.
    expect(screen.getAllByRole("button", { name: /Show referenced row/ })).toHaveLength(1);
  });

  it("shows no link icon on a NULL foreign key", async () => {
    mockFkTable([["1", null]]);
    renderDb(ORDERS);

    await screen.findByText("NULL");
    expect(screen.queryByRole("button", { name: /Show referenced row/ })).not.toBeInTheDocument();
  });

  // Regression guard for a bug caught in review: the describe_columns effect
  // cleared metadata only when there was no table at all, so on an A -> B
  // switch it left A's metadata in place until B's own describe_columns
  // resolved. If B's rows land first (as they do here, since B's
  // describe_columns is still pending), the grid painted B's data under A's
  // schema — a link icon claiming a foreign key B's column doesn't have.
  it("shows no link icon for a table switched to while its own metadata is still loading", async () => {
    const deferredPaymentsDescribe: { resolve: ((value: typeof FK_META) => void) | null } = { resolve: null };
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockImplementation((_conn, t) => {
      if (t.name === "orders") return Promise.resolve(FK_META);
      return new Promise((resolve) => {
        deferredPaymentsDescribe.resolve = resolve;
      });
    });
    vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation((_conn, t) => {
      if (t.name === "orders") {
        return Promise.resolve({ columns: ["id", "user_id"], rows: [["1", "usr_88"]], pk_column: "id" });
      }
      return Promise.resolve({ columns: ["id", "user_id"], rows: [["9", "no-fk-here"]], pk_column: "id" });
    });
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([ORDERS, PAYMENTS]);

    render(<DbTabHarness initialTable={ORDERS} />);
    await screen.findByRole("button", { name: /public\.users\.id/ });

    fireEvent.click(await screen.findByRole("button", { name: "Browse public.payments" }));

    // payments' rows have landed; its describe_columns call is still
    // in flight. Absent metadata must render, never orders' stale metadata.
    await screen.findByText("no-fk-here");
    expect(screen.queryByRole("button", { name: /Show referenced row/ })).not.toBeInTheDocument();

    // And once payments' own (FK-less) metadata does arrive, still nothing.
    await act(async () => {
      deferredPaymentsDescribe.resolve?.([]);
    });
    expect(screen.queryByRole("button", { name: /Show referenced row/ })).not.toBeInTheDocument();
  });

  it("fetches and shows the referenced row when the icon is clicked", async () => {
    mockFkTable();
    const referenced = vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id", "email"],
      rows: [["usr_88", "grace@example.com"]],
      pk_column: "id",
    });

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));

    // The referencing pair is what goes over the wire; the backend resolves
    // the target from the catalog.
    await waitFor(() =>
      expect(referenced).toHaveBeenCalledWith("c1", ORDERS, "user_id", "usr_88"),
    );
    expect(await screen.findByRole("dialog", { name: /public\.users/ })).toBeInTheDocument();
    expect(await screen.findByText("grace@example.com")).toBeInTheDocument();
  });

  // Spec §8: an unenforced or broken key states where the row is missing from.
  it("says no matching row when the key points nowhere", async () => {
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue(null);

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));

    expect(await screen.findByText("No matching row in public.users.")).toBeInTheDocument();
  });

  // Wiring-level guard: FkPopover.test.tsx only proves the component renders
  // whatever `error` prop it's handed — it can't catch openFk's own catch
  // block being changed to swallow the failure. If it were, the popover would
  // render the exact forbidden claim below ("No matching row"), reporting an
  // outage as a fact about the data, and every other FK test would still pass.
  it("reports a failed lookup as an error, never as a missing row", async () => {
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockRejectedValue(new Error("connection reset"));

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("connection reset");
    expect(screen.queryByText(/No matching row/)).not.toBeInTheDocument();
  });

  // Spec §8: "switches the grid to public.users with a pinned id = usr_88
  // filter, clearing sort, pins and hidden columns."
  it("jumps to the referenced table with a pinned filter on that row", async () => {
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id", "email"], rows: [["usr_88", "grace@example.com"]], pk_column: "id",
    });
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows");

    render(<DbTabHarness initialTable={ORDERS} />);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));
    await screen.findByRole("dialog", { name: /public\.users/ });
    fireEvent.click(screen.getByRole("button", { name: /open public\.users at this row/i }));

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        { schema: "public", name: "users" },
        expect.objectContaining({
          filter: [{ column: "id", op: "eq", value: "usr_88", enabled: true }],
          orderBy: [],
          offset: 0,
        }),
      ),
    );
  });

  // Layouts are keyed per table (gridLayout.ts, layoutKey above), so the
  // source table's pins and hidden columns never reach the target in the
  // first place — there is nothing for the jump to clear. A previous version
  // of handleJump cleared the *destination's* own saved pins/hidden anyway,
  // permanently wiping settings on a table the user never touched.
  it("leaves the destination table's saved layout alone", async () => {
    const seededLayout = { widths: { id: 200 }, order: ["email", "id"], pinned: ["id"], hidden: ["email"] };
    localStorage.setItem("devbench.grid-layout.c1:public.users", JSON.stringify(seededLayout));
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id", "email"], rows: [["usr_88", "grace@example.com"]], pk_column: "id",
    });
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows");

    render(<DbTabHarness initialTable={ORDERS} />);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));
    await screen.findByRole("dialog", { name: /public\.users/ });
    fireEvent.click(screen.getByRole("button", { name: /open public\.users at this row/i }));

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith("c1", { schema: "public", name: "users" }, expect.anything()),
    );

    // Widths, order, pinned and hidden all survive the jump exactly as
    // seeded — the jump must not touch stored layout at all.
    expect(JSON.parse(localStorage.getItem("devbench.grid-layout.c1:public.users")!)).toEqual(seededLayout);
  });

  // A self-referencing key does not change `table`, so the table-switch effect
  // never fires. Without the same-table branch the pinned filter is set on a
  // ref and then silently dropped.
  it("applies the pinned filter when the key points at the table already open", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "manager_id"], rows: [["e2", "e1"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([
      { name: "id", udt: "text", nullable: false, default_expr: null, is_identity: false, references: null },
      {
        name: "manager_id", udt: "text", nullable: true, default_expr: null, is_identity: false,
        references: { schema: "public", table: "orders", column: "id" },
      },
    ]);
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id"], rows: [["e1"]], pk_column: "id",
    });
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows");

    render(<DbTabHarness initialTable={ORDERS} />);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));
    await screen.findByRole("dialog", { name: /public\.orders/ });
    fireEvent.click(screen.getByRole("button", { name: /open public\.orders at this row/i }));

    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith(
        "c1",
        ORDERS,
        expect.objectContaining({
          filter: [{ column: "id", op: "eq", value: "e1", enabled: true }],
        }),
      ),
    );
  });

  // A cross-table jump would close the popover just by unmounting its row
  // (the table-switch effect nulls tableRows out from under it) even if
  // handleJump's own closeFk() call were deleted — that doesn't exercise the
  // thing being guarded. The same-table branch never unmounts anything: only
  // its own closeFk() call closes the popover, so this is where the guard
  // actually bites.
  it("closes the popover when a same-table jump lands", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "manager_id"], rows: [["e2", "e1"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([
      { name: "id", udt: "text", nullable: false, default_expr: null, is_identity: false, references: null },
      {
        name: "manager_id", udt: "text", nullable: true, default_expr: null, is_identity: false,
        references: { schema: "public", table: "orders", column: "id" },
      },
    ]);
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id"], rows: [["e1"]], pk_column: "id",
    });

    render(<DbTabHarness initialTable={ORDERS} />);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));
    await screen.findByRole("dialog", { name: /public\.orders/ });
    fireEvent.click(screen.getByRole("button", { name: /open public\.orders at this row/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /public\.orders/ })).not.toBeInTheDocument(),
    );
  });

  // Regression guard: only closeFk's own call sites (onClose, handleJump, the
  // table-switch effect) used to close a popover — a filter/sort/page/limit/
  // refresh swaps tableRows without ever clearing it first, so a popover left
  // anchored to its old rowIndex would silently repaint onto whatever row
  // lands at that index in the new results, with a stale onJump bound to the
  // wrong cell's value.
  it("closes the popover when the underlying query changes", async () => {
    mockFkTable([
      ["1", "usr_88"],
      ["2", "usr_99"],
    ]);
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue({
      columns: ["id"], rows: [["usr_99"]], pk_column: "id",
    });

    renderDb(ORDERS);
    const links = await screen.findAllByRole("button", { name: /Show referenced row/ });
    fireEvent.click(links[1]);
    await screen.findByRole("dialog", { name: /public\.users/ });

    fireEvent.click(screen.getByRole("button", { name: "Sort by id" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /public\.users/ })).not.toBeInTheDocument(),
    );
  });

  describe("query console", () => {
    it("opens and closes the query console via the toggle button, without hiding Browse", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: "id" });

      renderDb(ORDERS);
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

      renderDb(ORDERS);
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

      renderDb(ORDERS);
      await waitFor(() => screen.getByText("pending"));

      fireEvent.click(screen.getByText("pending"));
      const input = await screen.findByDisplayValue("pending");
      fireEvent.change(input, { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));

      await waitFor(() => expect(preview).toHaveBeenCalledWith("c1", ORDERS, "id", "1", "status", "shipped"));
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

      renderDb(ORDERS);
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

      renderDb(PAYMENTS);
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

      renderDb(ORDERS);
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

      renderDb(ORDERS);
      await waitFor(() => screen.getByText("NULL"));

      fireEvent.click(screen.getByText("NULL"));
      const input = await screen.findByRole("textbox", { name: /^Edit / });
      expect(input).toBeEnabled();
      expect(input).toHaveValue("");
      expect(screen.queryByRole("checkbox", { name: "NULL" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
      await waitFor(() => expect(preview).toHaveBeenCalledWith("c1", ORDERS, "id", "1", "status", null));
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

      const { rerender, onPatchState } = renderDb(ORDERS);
      await waitFor(() => screen.getByText("pending"));
      fireEvent.click(screen.getByText("pending"));
      fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
      await screen.findByRole("button", { name: "Rollback edit" });

      rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={PAYMENTS} onPatchState={onPatchState} />);

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

      renderDb(ORDERS);
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

      renderDb(ORDERS);
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

        renderDb(ORDERS);
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
          rows: [["1", t.name === "orders" ? "pending" : "waiting"]],
          pk_column: "id",
        }));
        const deferredPreview: { resolve: ((v: QueryPreview) => void) | null } = { resolve: null };
        vi.spyOn(tauriLib, "invokePreviewCellEdit").mockImplementation(
          () => new Promise<QueryPreview>((resolve) => (deferredPreview.resolve = resolve)),
        );
        const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

        const { rerender, onPatchState } = renderDb(ORDERS);
        await waitFor(() => screen.getByText("pending"));
        fireEvent.click(screen.getByText("pending"));
        fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
        // Still in flight — no preview UI exists yet to abandon.
        expect(screen.queryByRole("button", { name: "Commit edit" })).not.toBeInTheDocument();

        rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={PAYMENTS} onPatchState={onPatchState} />);
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
          rows: [["1", t.name === "orders" ? "pending" : "waiting"]],
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

        const { rerender, onPatchState } = renderDb(ORDERS);
        await waitFor(() => screen.getByText("pending"));
        fireEvent.click(screen.getByText("pending"));
        fireEvent.change(await screen.findByDisplayValue("pending"), { target: { value: "shipped" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
        fireEvent.click(await screen.findByRole("button", { name: "Commit edit" }));

        rerender(<DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={PAYMENTS} onPatchState={onPatchState} />);
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

        renderDb(ORDERS);
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

        const { unmount } = renderDb(ORDERS);
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

  it("opens the insert panel on the table whose toolbar was used", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
    });
    vi.spyOn(tauriLib, "invokeDescribeColumns").mockResolvedValue([
      { name: "id", udt: "int4", nullable: false, default_expr: null, is_identity: true, references: null },
      { name: "status", udt: "text", nullable: false, default_expr: null, is_identity: false, references: null },
    ]);

    renderDb(ORDERS);
    await screen.findByRole("button", { name: "Insert" });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(useAppStore.getState().dockPanel).toBe("insert");
    expect(useAppStore.getState().insertTarget?.table).toEqual(ORDERS);
    // The panel builds its fields from these, so an empty list here would be a
    // silently blank form rather than a visible failure.
    expect(useAppStore.getState().insertTarget?.columns.map((c) => c.name)).toEqual(["id", "status"]);
  });

  it("shows the Pending button only once something is staged, and opens the panel", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
    });
    useAppStore.getState().discardAllPending();

    renderDb(ORDERS);
    // DataGrid's role is "table" (see DataGrid.tsx), not "grid" — waiting on
    // it is just this test's way of letting the initial row fetch settle.
    await screen.findByRole("table");
    // Hidden entirely when empty: it must never advertise a state that does
    // not exist (spec §3). Matched by "Pending <count>", not just a leading
    // "pending" — the row's own status value is "pending" too, and that cell
    // is itself a button (see DbTab.tsx's editable-cell button).
    expect(screen.queryByRole("button", { name: /^pending \d/i })).toBeNull();

    act(() => {
      useAppStore.getState().stagePendingUpdate({
        kind: "update", table: ORDERS, pk_column: "id", pk_value: "1",
        column: "status", old_value: "pending", new_value: "shipped",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Pending 1" }));
    expect(useAppStore.getState().dockPanel).toBe("pending");
  });
});
