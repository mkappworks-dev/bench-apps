import { useState } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { DbTab } from "./DbTab";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";
import type { TableRows } from "../../lib/tauri";
import { tableCountCache } from "../../lib/tableCountCache";

// jsdom gives every element a height of 0, which makes TanStack Virtual compute a zero-row viewport.
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
  return {
    onPatchState,
    ...render(
      <DbTab watchedTables={new Set()} onToggleWatch={() => {}} table={table} onPatchState={onPatchState} onOpenQuery={() => {}} onCloseQueryTabs={() => {}} />,
    ),
  };
}

function DbTabHarness({ initialTable }: { initialTable: tauriLib.QualifiedTable | null }) {
  const [table, setTable] = useState(initialTable);
  return (
    <DbTab
      watchedTables={new Set()}
      onToggleWatch={() => {}}
      table={table}
      onPatchState={(patch) => setTable(patch.table)}
      onOpenQuery={() => {}}
      onCloseQueryTabs={() => {}}
    />
  );
}

describe("DbTab", () => {
  beforeEach(() => {
    tableCountCache.invalidateConnection("c1");
    tableCountCache.invalidateConnection("c2");
    localStorage.clear();
    useAppStore.setState({ pending: [] });
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
    expect(describeColumns).toHaveBeenCalledTimes(1);
  });

  it("edits boolean-looking text as text while real boolean cells toggle", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "label", "paid"], column_types: ["int4", "text", "bool"],
      rows: [["1", "true", "false"]], pk_column: "id",
    });
    renderDb(ORDERS);
    const label = await screen.findByRole("button", { name: "true" });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(label);
    expect(screen.getByRole("textbox", { name: "Edit label" })).toHaveValue("true");
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "paid" }));
    expect(useAppStore.getState().pending).toEqual([expect.objectContaining({ column: "paid", old_value: "false", new_value: "true" })]);
  });

  it("reuses counts across paging and sorting, and invalidates them on Refresh", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: "id" });
    const count = vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(150);
    renderDb(ORDERS);
    await screen.findByText("of 2");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Page number" })).toHaveValue("2"));
    fireEvent.click(screen.getByRole("button", { name: "Sort by id" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Page number" })).toHaveValue("1"));
    expect(count).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(count).toHaveBeenCalledTimes(2));
  });

  it("shows rows while their count is pending and marks the page total unknown", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [["1"]], pk_column: "id" });
    let finish!: (count: number) => void;
    vi.spyOn(tauriLib, "invokeCountTableRows").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderDb(ORDERS);
    await screen.findByRole("table");
    expect(screen.getByText("of —")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await act(async () => { finish(150); });
    expect(screen.getByText("of 2")).toBeInTheDocument();
  });

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

  it("re-fetches when its table prop changes to a different table", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: ["id"], rows: [], pk_column: null });
    const { rerender, onPatchState } = renderDb(ORDERS);
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith("c1", ORDERS, expect.objectContaining({ offset: 0 })),
    );

    rerender(
      <DbTab
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        table={PAYMENTS}
        onPatchState={onPatchState}
        onOpenQuery={() => {}}
        onCloseQueryTabs={() => {}}
      />,
    );
    await waitFor(() =>
      expect(listRows).toHaveBeenCalledWith("c1", PAYMENTS, expect.objectContaining({ offset: 0 })),
    );
  });

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

    rerender(
      <DbTab
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        table={{ schema: "alt", name: "dup" }}
        onPatchState={onPatchState}
        onOpenQuery={() => {}}
        onCloseQueryTabs={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Freeze id" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Freeze id" })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("devbench.grid-layout.c1:alt.dup")).toBeNull();
  });

  it("selecting a table in the schema tree patches state rather than fetching directly", () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [], pk_column: null });
    const { onPatchState } = renderDb(null);
    expect(onPatchState).not.toHaveBeenCalled();
  });

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

  it("changing rows per page issues one row query and reuses its count", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id"], rows: [["1"]], pk_column: "id",
    });
    const count = vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(500);

    renderDb(ORDERS);
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    listRows.mockClear();
    count.mockClear();

    fireEvent.change(screen.getByRole("combobox", { name: "Rows per page" }), { target: { value: "250" } });

    expect(listRows).toHaveBeenCalledTimes(1);
    expect(count).not.toHaveBeenCalled();
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
    fireEvent.change(screen.getByRole("combobox", { name: /^Filter column/ }), { target: { value: "status" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Filter value/ }), { target: { value: "paid" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const expected = [{ column: "status", op: "eq", value: "paid", enabled: true }];
    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ filter: expected, offset: 0 })),
    );
    expect(count).toHaveBeenLastCalledWith("c1", ORDERS, expected);
  });

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

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    fireEvent.click(screen.getByRole("button", { name: /remove condition/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ filter: [] })),
    );
  });

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
    expect(await screen.findByText("of 3")).toBeInTheDocument();
  });

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
    vi.spyOn(tauriLib, "invokeCountTableRows").mockImplementation((_conn, t) =>
      Promise.resolve(t.name === "orders" ? 150 : 1),
    );
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([ORDERS, PAYMENTS]);

    render(<DbTabHarness initialTable={ORDERS} />);
    await waitFor(() => expect(listRows).toHaveBeenCalledWith("c1", ORDERS, expect.anything()));
    expect(await screen.findByRole("button", { name: "Next page" })).not.toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Browse public.payments" }));

    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(listRows).not.toHaveBeenCalledWith("c1", PAYMENTS, expect.objectContaining({ offset: 100 }));

    expect(deferredPaymentsFetch.resolve).not.toBeNull();
    deferredPaymentsFetch.resolve?.({ columns: ["id"], rows: [["1"]], pk_column: "id" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled());
    expect(listRows).toHaveBeenLastCalledWith("c1", PAYMENTS, expect.objectContaining({ orderBy: [], offset: 0 }));
  });

  it("discards a slower in-flight fetch once a newer request has superseded it", async () => {
    // A holder object avoids TS over-narrowing a closure variable reassigned only inside the Promise executor to `null`.
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

  it("shows a link icon only on cells in a column with a foreign key", async () => {
    mockFkTable();
    renderDb(ORDERS);

    const link = await screen.findByRole("button", { name: /public\.users\.id/ });
    expect(link).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Show referenced row/ })).toHaveLength(1);
  });

  it("shows no link icon on a NULL foreign key", async () => {
    mockFkTable([["1", null]]);
    renderDb(ORDERS);

    await screen.findByText("NULL");
    expect(screen.queryByRole("button", { name: /Show referenced row/ })).not.toBeInTheDocument();
  });

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

    await screen.findByText("no-fk-here");
    expect(screen.queryByRole("button", { name: /Show referenced row/ })).not.toBeInTheDocument();

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

    await waitFor(() =>
      expect(referenced).toHaveBeenCalledWith("c1", ORDERS, "user_id", "usr_88"),
    );
    expect(await screen.findByRole("dialog", { name: /public\.users/ })).toBeInTheDocument();
    expect(await screen.findByText("grace@example.com")).toBeInTheDocument();
  });

  it("says no matching row when the key points nowhere", async () => {
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockResolvedValue(null);

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));

    expect(await screen.findByText("No matching row in public.users.")).toBeInTheDocument();
  });

  it("reports a failed lookup as an error, never as a missing row", async () => {
    mockFkTable();
    vi.spyOn(tauriLib, "invokeGetReferencedRow").mockRejectedValue(new Error("connection reset"));

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: /Show referenced row/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("connection reset");
    expect(screen.queryByText(/No matching row/)).not.toBeInTheDocument();
  });

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
          filter: [{ column: "id", op: "eq_typed", value: "usr_88", enabled: true }],
          orderBy: [],
          offset: 0,
        }),
      ),
    );
  });

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

    expect(JSON.parse(localStorage.getItem("devbench.grid-layout.c1:public.users")!)).toEqual(seededLayout);
  });

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
          filter: [{ column: "id", op: "eq_typed", value: "e1", enabled: true }],
        }),
      ),
    );
  });

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

  describe("inline cell editing", () => {
    it("clicking an editable cell shows an input; accepting stages the change without writing it", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("pending"));

      const input = await screen.findByLabelText("Edit status");
      fireEvent.change(input, { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));

      expect(useAppStore.getState().pending).toEqual([
        {
          kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "status", old_value: "pending", new_value: "shipped",
        },
      ]);
    });

    it("renders a staged cell's pending value, marked as staged", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      await screen.findByText("pending");

      act(() => {
        useAppStore.getState().stagePendingUpdate({
          kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "status", old_value: "pending", new_value: "shipped",
        });
      });

      expect(await screen.findByText("shipped")).toBeTruthy();
      expect(screen.queryByText("pending")).toBeNull();
      expect(document.querySelector('[data-staged="true"]')).toBeTruthy();
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

    it("cells showing <unsupported type> are not editable even when the table has a primary key", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status", "payload"],
        rows: [["1", "pending", "<unsupported type>"]],
        pk_column: "id",
      });

      renderDb(ORDERS);
      await waitFor(() => screen.getByText("<unsupported type>"));

      fireEvent.click(screen.getByText("pending"));
      expect(await screen.findByDisplayValue("pending")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));

      fireEvent.click(screen.getByText("<unsupported type>"));
      expect(screen.queryByRole("textbox", { name: /^Edit / })).not.toBeInTheDocument();
    });

    it("stages null rather than an empty string when a NULL cell's draft is untouched", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", null]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("NULL"));
      await screen.findByLabelText("Edit status");
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));

      expect(useAppStore.getState().pending).toEqual([]);
    });

    it("stages a real value over a NULL cell", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", null]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("NULL"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));

      expect(useAppStore.getState().pending).toEqual([
        {
          kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "status", old_value: null, new_value: "shipped",
        },
      ]);
    });

    it("cancelling an edit discards the draft and stages nothing", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("pending"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));

      expect(useAppStore.getState().pending).toEqual([]);
      expect(screen.queryByLabelText("Edit status")).toBeNull();
      expect(screen.getByText("pending")).toBeTruthy();
    });

    it("typing a cell back to its stored value clears the pending change", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("pending"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "shipped" } });
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));
      expect(useAppStore.getState().pending).toHaveLength(1);

      fireEvent.click(await screen.findByText("shipped"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "pending" } });
      fireEvent.click(screen.getByRole("button", { name: "Stage change" }));

      expect(useAppStore.getState().pending).toEqual([]);
    });

    it("closes an open editor when an Apply lands and refetches", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });

      renderDb(ORDERS);
      fireEvent.click(await screen.findByText("pending"));
      await screen.findByLabelText("Edit status");

      act(() => {
        useAppStore.getState().removePendingEntries(useAppStore.getState().pending);
        useAppStore.getState().bumpApplyGeneration();
      });

      await waitFor(() => expect(screen.queryByLabelText("Edit status")).toBeNull());
    });

    it("refetches when an Apply lands, leaving the pending set non-empty", async () => {
      const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      await screen.findByRole("table");

      act(() => {
        useAppStore.getState().stagePendingUpdate({
          kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "status", old_value: "pending", new_value: "shipped",
        });
        useAppStore.getState().stagePendingUpdate({
          kind: "update", connection_id: "c2", table: ORDERS, pk_column: "id", pk_value: "2",
          column: "status", old_value: "pending", new_value: "failed",
        });
      });
      const before = listRows.mock.calls.length;

      act(() => {
        useAppStore.getState().removePendingEntries([useAppStore.getState().pending[0]]);
        useAppStore.getState().bumpApplyGeneration();
      });

      await waitFor(() => expect(listRows.mock.calls.length).toBeGreaterThan(before));
      expect(useAppStore.getState().pending).toHaveLength(1);
    });

    it("does not refetch or disturb an open editor when a staged entry is discarded", async () => {
      const list = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });

      renderDb(ORDERS);
      await screen.findByText("pending");

      act(() => {
        useAppStore.getState().stagePendingUpdate({
          kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "9",
          column: "status", old_value: "a", new_value: "b",
        });
      });

      fireEvent.click(await screen.findByText("pending"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "typed" } });
      const callsBefore = list.mock.calls.length;

      act(() => {
        useAppStore.setState({ pending: [] });
      });

      expect(list.mock.calls.length).toBe(callsBefore);
      expect((screen.getByLabelText("Edit status") as HTMLInputElement).value).toBe("typed");
    });

    it("refetches when an Apply lands, even with the pending count unchanged", async () => {
      const list = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });

      renderDb(ORDERS);
      await screen.findByText("pending");
      const callsBefore = list.mock.calls.length;

      act(() => {
        useAppStore.getState().bumpApplyGeneration();
      });

      await waitFor(() => expect(list.mock.calls.length).toBe(callsBefore + 1));
    });

    it("closes an open editor when the table changes underneath it", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation(async (_conn, t) => ({
        columns: ["id", "status"],
        rows: [["1", t.name === "orders" ? "pending" : "waiting"]],
        pk_column: "id",
      }));

      const { rerender, onPatchState } = renderDb(ORDERS);
      fireEvent.click(await screen.findByText("pending"));
      await screen.findByLabelText("Edit status");

      rerender(
        <DbTab
          watchedTables={new Set()}
          onToggleWatch={() => {}}
          table={PAYMENTS}
          onPatchState={onPatchState}
          onOpenQuery={() => {}}
          onCloseQueryTabs={() => {}}
        />,
      );

      expect(await screen.findByText("waiting")).toBeInTheDocument();
      expect(screen.queryByLabelText("Edit status")).toBeNull();
    });

    it("toggles a boolean in place and stages it, with no editor in between", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "paid"], column_types: ["int4", "bool"], rows: [["1", "false"]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      const box = (await screen.findByRole("checkbox", { name: "paid" })) as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(false);

      fireEvent.click(box);

      expect(useAppStore.getState().pending).toEqual([
        {
          kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "1",
          column: "paid", old_value: "false", new_value: "true",
        },
      ]);
      expect(screen.queryByLabelText("Edit paid")).toBeNull();
      expect((screen.getByRole("checkbox", { name: "paid" }) as HTMLInputElement).checked).toBe(true);
    });

    it("toggling a boolean twice leaves no pending change", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "paid"], column_types: ["int4", "bool"], rows: [["1", "false"]], pk_column: "id",
      });
      useAppStore.setState({ pending: [] });

      renderDb(ORDERS);
      const box = await screen.findByRole("checkbox", { name: "paid" });
      fireEvent.click(box);
      expect(useAppStore.getState().pending).toHaveLength(1);
      fireEvent.click(screen.getByRole("checkbox", { name: "paid" }));

      expect(useAppStore.getState().pending).toEqual([]);
    });

    it("renders a boolean read-only when the table has no single-column primary key", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "paid"], column_types: ["int4", "bool"], rows: [["1", "true"]], pk_column: null,
      });

      renderDb(ORDERS);
      const box = (await screen.findByRole("checkbox", { name: "paid" })) as HTMLInputElement;
      expect(box.disabled).toBe(true);
    });

    it("keeps NULL visually distinct from false in a boolean column", async () => {
      vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "paid"], column_types: ["int4", "bool"], rows: [["1", null], ["2", "false"]], pk_column: "id",
      });

      renderDb(ORDERS);
      expect(await screen.findByText("NULL")).toBeTruthy();
      expect(screen.getAllByRole("checkbox", { name: "paid" })).toHaveLength(1);
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
    expect(useAppStore.getState().insertTarget?.columns.map((c) => c.name)).toEqual(["id", "status"]);
  });

  it("shows the Pending button only once something is staged, and opens the panel", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
    });
    useAppStore.setState({ pending: [] });

    renderDb(ORDERS);
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /^pending \d/i })).toBeNull();

    act(() => {
      useAppStore.getState().stagePendingUpdate({
        kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "1",
        column: "status", old_value: "pending", new_value: "shipped",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Pending 1" }));
    expect(useAppStore.getState().dockPanel).toBe("pending");
  });

  it("stages a row delete and toggles it back off", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["42", "pending"]], pk_column: "id",
    });
    useAppStore.setState({ pending: [] });

    renderDb(ORDERS);
    fireEvent.click(await screen.findByRole("button", { name: "Stage delete of row 42" }));

    expect(useAppStore.getState().pending).toEqual([
      { kind: "delete", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "42" },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Undo staged delete of row 42" }));
    expect(useAppStore.getState().pending).toEqual([]);
  });

  it("names copy controls with the primary key column and value", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["status", "order_id"], rows: [["pending", "42"], ["paid", "99"]], pk_column: "order_id",
    });

    renderDb(ORDERS);

    expect(await screen.findByRole("button", { name: "Copy row order_id 42" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy row order_id 99" })).toBeInTheDocument();
  });

  it("uses page-aware copy labels when there is no primary key", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["status"], rows: [["pending"]], pk_column: null,
    });
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(150);

    renderDb(ORDERS);
    expect(await screen.findByRole("button", { name: "Copy row 1" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));

    await waitFor(() => expect(listRows).toHaveBeenLastCalledWith("c1", ORDERS, expect.objectContaining({ offset: 100 })));
    expect(await screen.findByRole("button", { name: "Copy row 101" })).toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)("keeps copy labels tied to the loaded page while the next fetch will %s", async (outcome) => {
    let resolveRows!: (rows: TableRows) => void;
    let rejectRows!: (error: Error) => void;
    const nextRows = new Promise<TableRows>((resolve, reject) => {
      resolveRows = resolve;
      rejectRows = reject;
    });
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows")
      .mockResolvedValueOnce({ columns: ["status"], rows: [["first page"]], pk_column: null })
      .mockReturnValueOnce(nextRows);
    vi.spyOn(tauriLib, "invokeCountTableRows").mockResolvedValue(150);

    renderDb(ORDERS);
    await screen.findByRole("button", { name: "Copy row 1" });
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listRows).toHaveBeenCalledTimes(2));

    expect(screen.getByText("first page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy row 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy row 101" })).not.toBeInTheDocument();

    await act(async () => {
      if (outcome === "reject") rejectRows(new Error("page unavailable"));
      else resolveRows({ columns: ["status"], rows: [["next page"]], pk_column: null });
    });

    if (outcome === "reject") {
      expect(screen.getByRole("alert")).toHaveTextContent("page unavailable");
      expect(screen.getByText("first page")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy row 1" })).toBeInTheDocument();
    } else {
      expect(screen.getByText("next page")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy row 101" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Copy row 1" })).not.toBeInTheDocument();
    }
  });

  it("offers no delete action when the table has no single-column primary key", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["42", "pending"]], pk_column: null,
    });

    renderDb(ORDERS);
    await screen.findByText("pending");
    expect(screen.queryByRole("button", { name: /stage delete/i })).toBeNull();
  });

  it("stops accepting cell edits on a row already staged for deletion", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status", "paid"], column_types: ["int4", "text", "bool"], rows: [["42", "pending", "false"]], pk_column: "id",
    });
    useAppStore.setState({ pending: [] });

    renderDb(ORDERS);
    expect((await screen.findByText("pending")).closest("button")!.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Stage delete of row 42" }));

    const cell = screen.getByText("pending").closest("button")!;
    expect(cell.disabled).toBe(true);
    fireEvent.click(cell);
    expect(screen.queryByLabelText("Edit status")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "paid" }) as HTMLInputElement).disabled).toBe(true);
    expect(useAppStore.getState().pending).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Undo staged delete of row 42" }));
    expect(screen.getByText("pending").closest("button")!.disabled).toBe(false);
  });

  it("refuses the whole row when the primary key itself is <unsupported type>", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"],
      rows: [["<unsupported type>", "pending"]],
      pk_column: "id",
    });
    useAppStore.setState({ pending: [] });

    renderDb(ORDERS);
    await screen.findByText("<unsupported type>");

    expect(screen.queryByRole("button", { name: /stage delete/i })).toBeNull();
    const cell = screen.getByText("pending").closest("button")!;
    expect(cell.disabled).toBe(true);
    fireEvent.click(cell);
    expect(screen.queryByLabelText("Edit status")).toBeNull();
    expect(useAppStore.getState().pending).toEqual([]);
  });

  it("does not paint a value staged on another connection onto this connection's rows", async () => {
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
      columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
    });
    useAppStore.setState({ pending: [] });
    useAppStore.getState().setActiveConnectionId("c1");

    renderDb(ORDERS);
    await screen.findByText("pending");

    act(() => {
      useAppStore.getState().stagePendingUpdate({
        kind: "update", connection_id: "c2", table: ORDERS, pk_column: "id", pk_value: "1",
        column: "status", old_value: "pending", new_value: "shipped",
      });
    });

    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.queryByText("shipped")).toBeNull();
    expect(document.querySelector('[data-staged="true"]')).toBeNull();
    act(() => {
      useAppStore.getState().togglePendingDelete("c2", ORDERS, "id", "1");
    });
    expect(screen.getByRole("button", { name: "Stage delete of row 1" })).toBeTruthy();
  });
});
