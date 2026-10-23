import { useState } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { DataGrid, type DataGridProps } from "./DataGrid";
import { EMPTY_LAYOUT, type GridLayout } from "./grid/gridLayout";

// jsdom gives every element a height of 0, which makes TanStack Virtual compute a zero-row viewport and render nothing.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => {} };
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function columnOrder(): string[] {
  return [...document.querySelectorAll('[role="columnheader"][data-column]')].map(
    (h) => (h as HTMLElement).dataset.column ?? "",
  );
}

// This harness plays the role DbTab does in production, feeding onLayoutChange's result back in as the next render's `layout` prop.
function ControlledGrid({
  initialLayout = EMPTY_LAYOUT,
  ...props
}: Omit<DataGridProps, "layout" | "onLayoutChange"> & { initialLayout?: GridLayout }) {
  const [layout, setLayout] = useState(initialLayout);
  return <DataGrid {...props} layout={layout} onLayoutChange={setLayout} />;
}

describe("DataGrid", () => {
  it.each([undefined, ["text"]])("keeps boolean-looking strings as text with column types %j", (columnTypes) => {
    render(<DataGrid columns={["label"]} rows={[["true"], ["false"], [null]]} columnTypes={columnTypes} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("distinguishes copy controls by data-row number when no labels are supplied", () => {
    render(<DataGrid columns={["value"]} rows={[["a"], ["b"]]} />);
    expect(screen.getByRole("button", { name: "Copy row 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy row 2" })).toBeInTheDocument();
  });

  it("uses caller-supplied row identities for the copy trigger and menu", () => {
    const rows = [["a", "42"], ["b", "99"]];
    render(<DataGrid columns={["value", "id"]} rows={rows} getRowLabel={(index) => `id ${rows[index][1]}`} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy row id 99" }));
    expect(screen.getByRole("menu", { name: "Copy row id 99" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as TSV" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("b\t99");
  });

  it("renders columns and row values", () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("renders NULL distinctly from an empty string", () => {
    render(<DataGrid columns={["notes"]} rows={[[null]]} />);
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("renders the unsupported-type marker distinctly", () => {
    render(<DataGrid columns={["amount"]} rows={[["<unsupported type>"]]} />);
    expect(screen.getByText("<unsupported type>")).toBeInTheDocument();
  });

  it("renders a boolean as a checkbox reflecting its value", () => {
    render(<DataGrid columns={["paid"]} columnTypes={["bool"]} rows={[["true"], ["false"]]} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[0]).toBeDisabled();
  });

  it("keeps NULL distinct from false in a boolean column", () => {
    render(<DataGrid columns={["paid"]} columnTypes={["bool"]} rows={[["false"], [null]]} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("calls onSort with the clicked column", () => {
    const onSort = vi.fn();
    render(<DataGrid columns={["id", "status"]} rows={[]} onSort={onSort} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
    expect(onSort).toHaveBeenCalledWith("status", false);
  });

  // A decorative SVG (aria-hidden; sort state itself is on aria-sort, covered below), so it's queried by data-testid, not text/role.
  it("shows the sort direction indicator rotated for descending, upright for ascending", () => {
    const { rerender } = render(<DataGrid columns={["id"]} rows={[]} sort={[{ column: "id", descending: false }]} />);
    expect(screen.getByTestId("sort-chevron-id")).not.toHaveClass("rotate-180");

    rerender(<DataGrid columns={["id"]} rows={[]} sort={[{ column: "id", descending: true }]} />);
    expect(screen.getByTestId("sort-chevron-id")).toHaveClass("rotate-180");
  });

  it("does not render the copy menu until the trigger is clicked", () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    expect(screen.queryByText("Copy as TSV")).not.toBeInTheDocument();
    expect(screen.queryByText("Copy as JSON")).not.toBeInTheDocument();
  });

  it("opening the copy trigger reveals both TSV and JSON options", () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    expect(screen.getByText("Copy as TSV")).toBeInTheDocument();
    expect(screen.getByText("Copy as JSON")).toBeInTheDocument();
  });

  it("copies a row as tab-separated values", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    fireEvent.click(screen.getByText("Copy as TSV"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("1\tpending"));
  });

  it("copies a row as JSON", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    fireEvent.click(screen.getByText("Copy as JSON"));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify({ id: "1", status: "pending" })),
    );
  });

  it("closes the menu after choosing an item", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    fireEvent.click(screen.getByText("Copy as TSV"));
    expect(screen.queryByText("Copy as TSV")).not.toBeInTheDocument();
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  });

  it("closes the menu on a pointer-down outside it, without copying", () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("Copy as TSV")).not.toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("closes the menu on Escape", () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Copy as TSV")).not.toBeInTheDocument();
  });

  it("closes the menu when the grid is scrolled", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    expect(screen.getByText("Copy as TSV")).toBeInTheDocument();
    const scrollContainer = document.querySelector(".overflow-auto") as HTMLElement;
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    fireEvent.scroll(scrollContainer);
    await waitFor(() => expect(screen.queryByText("Copy as TSV")).not.toBeInTheDocument());
  });

  // jsdom doesn't focus-scroll on click like a real browser does, so this drives the same-frame scroll directly to prove it's ignored.
  it("survives the scroll the opening click itself causes", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    const scrollContainer = document.querySelector(".overflow-auto") as HTMLElement;
    fireEvent.scroll(scrollContainer); // same frame as opening
    expect(screen.getByText("Copy as TSV")).toBeInTheDocument();
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    fireEvent.scroll(scrollContainer); // a frame later
    await waitFor(() => expect(screen.queryByText("Copy as TSV")).not.toBeInTheDocument());
  });

  it("raises the row whose copy menu is open to zIndex 20", () => {
    render(<DataGrid columns={["id"]} rows={[["a"], ["b"]]} />);
    const triggers = screen.getAllByRole("button", { name: /^Copy row / });
    fireEvent.click(triggers[1]);
    const openRow = screen.getByText("b").closest('[role="row"]') as HTMLElement;
    const otherRow = screen.getByText("a").closest('[role="row"]') as HTMLElement;
    expect(openRow.style.zIndex).toBe("20");
    expect(otherRow.style.zIndex).toBe("");
  });

  it("lets a consumer override cell rendering (the seam Task 12 uses for inline editing)", () => {
    render(
      <DataGrid
        columns={["status"]}
        rows={[["pending"]]}
        renderCell={(_r, _c, value) => <span data-testid="custom-cell">{value}-custom</span>}
      />,
    );
    expect(screen.getByTestId("custom-cell")).toHaveTextContent("pending-custom");
  });

  // With 2000 rows and a 600px viewport at 33px/row, a real window renders well under the full count but still more than zero.
  it("virtualizes rather than rendering every row", () => {
    const many = Array.from({ length: 2000 }, (_, i) => [String(i), "row"]);
    render(<DataGrid columns={["id", "label"]} rows={many} />);
    const rendered = screen.getAllByText("row").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(2000);
  });

  it("shows a distinct message instead of a blank body when there are no rows", () => {
    render(<DataGrid columns={["id"]} rows={[]} />);
    expect(screen.getByText(/no rows/i)).toBeInTheDocument();
  });

  it("reflects sort state via aria-sort on the active column header only", () => {
    render(<DataGrid columns={["id", "status"]} rows={[]} sort={[{ column: "status", descending: true }]} />);
    const statusHeader = screen.getByRole("button", { name: "Sort by status" }).closest('[role="columnheader"]');
    const idHeader = screen.getByRole("button", { name: "Sort by id" }).closest('[role="columnheader"]');
    expect(statusHeader).toHaveAttribute("aria-sort", "descending");
    expect(idHeader).not.toHaveAttribute("aria-sort");
  });

  it("dragging a column's resize handle fixes that column's width, leaving others flexible", () => {
    render(<ControlledGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    const headerRow = screen.getByRole("button", { name: "Sort by id" }).closest('[role="row"]') as HTMLElement;
    expect(headerRow.style.gridTemplateColumns).toBe("minmax(140px, 1fr) minmax(140px, 1fr) 60px");

    // getBoundingClientRect is mocked to always report 800, so dragging 40px right pins the column at 840px.
    fireEvent.mouseDown(screen.getByTestId("resize-handle-id"), { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 40 });
    fireEvent.mouseUp(window);

    expect(headerRow.style.gridTemplateColumns).toBe("840px minmax(140px, 1fr) 60px");
  });

  it("shift-clicking a header asks for an additive sort rather than replacing the current one", () => {
    const onSort = vi.fn();
    render(<DataGrid columns={["id", "status"]} rows={[]} onSort={onSort} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }), { shiftKey: true });
    expect(onSort).toHaveBeenCalledWith("status", true);
  });

  it("numbers each column when more than one sort term is active, so precedence is readable", () => {
    render(
      <DataGrid
        columns={["id", "status"]}
        rows={[]}
        sort={[
          { column: "status", descending: false },
          { column: "id", descending: true },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Sort by status" })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Sort by id" })).toHaveTextContent("2");
  });

  it("reorders a column with Alt+Arrow, giving the header drag a keyboard equivalent", () => {
    render(<ControlledGrid columns={["id", "status", "amount"]} rows={[]} />);
    expect(columnOrder()).toEqual(["id", "status", "amount"]);

    fireEvent.keyDown(screen.getByRole("button", { name: "Sort by status" }), { key: "ArrowRight", altKey: true });
    expect(columnOrder()).toEqual(["id", "amount", "status"]);

    fireEvent.keyDown(screen.getByRole("button", { name: "Sort by status" }), { key: "ArrowLeft", altKey: true });
    expect(columnOrder()).toEqual(["id", "status", "amount"]);
  });

  // If this regresses, an inline edit writes to whichever column happens to occupy that screen position — silent data corruption.
  it("keeps renderCell on the DATA column index after a reorder, not the on-screen position", () => {
    const calls: { columnIndex: number; value: string | null }[] = [];
    render(
      <ControlledGrid
        columns={["id", "status", "amount"]}
        rows={[["1", "paid", "99"]]}
        renderCell={(_r, columnIndex, value) => {
          calls.push({ columnIndex, value });
          return <span>{value}</span>;
        }}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Sort by status" }), { key: "ArrowRight", altKey: true });

    const status = calls.filter((c) => c.value === "paid");
    expect(status.at(-1)?.columnIndex).toBe(1);
    const amount = calls.filter((c) => c.value === "99");
    expect(amount.at(-1)?.columnIndex).toBe(2);
  });

  // DataGrid just reflects whatever `layout` prop it's given — the storage round-trip (including the corrupt-JSON fallback) is covered in gridLayout.test.ts.
  it("freezes a column to the left edge, reporting the change via onLayoutChange", () => {
    render(<ControlledGrid columns={["id", "status"]} rows={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Freeze id" }));

    const header = document.querySelector('[data-column="id"]') as HTMLElement;
    expect(header.style.position).toBe("sticky");
    expect(screen.getByRole("button", { name: "Unfreeze id" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows visible feedback when a clipboard copy fails, instead of failing silently", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard permission denied"));
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy row / }));
    fireEvent.click(screen.getByText("Copy as TSV"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/clipboard permission denied/i);
  });

  // Whether this actually escapes a later sibling's paint is a real-browser stacking-context question jsdom can't answer — this
  // only pins the one thing jsdom CAN check: the prop reaches the right row's own style and no other row's.
  it("raises only the row named by raisedRowIndex, leaving its siblings at the default stacking order", () => {
    render(<DataGrid columns={["id"]} rows={[["a"], ["b"], ["c"]]} raisedRowIndex={1} />);

    const raisedRow = screen.getByText("b").closest('[role="row"]') as HTMLElement;
    const otherRow = screen.getByText("a").closest('[role="row"]') as HTMLElement;
    expect(raisedRow.style.zIndex).toBe("20");
    expect(otherRow.style.zIndex).toBe("");
  });

  it("renders caller-supplied row actions against the data row index", () => {
    render(
      <DataGrid
        columns={["id"]}
        rows={[["1"], ["2"]]}
        renderRowActions={(rowIndex) => (
          <button type="button" aria-label={`Act on row ${rowIndex}`}>
            x
          </button>
        )}
      />,
    );
    expect(screen.getByRole("button", { name: "Act on row 0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Act on row 1" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Copy row / })).toHaveLength(2);
  });
});
