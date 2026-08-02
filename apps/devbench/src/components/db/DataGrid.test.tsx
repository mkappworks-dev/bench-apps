import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { DataGrid, type DataGridProps } from "./DataGrid";
import { EMPTY_LAYOUT, type GridLayout } from "./grid/gridLayout";

// jsdom gives every element a height of 0, which makes TanStack Virtual
// compute a zero-row viewport and render nothing (see LogStream.test.tsx,
// which hit the same issue). Give the layout primitives real numbers so the
// virtualizer has a window to fill; a test that stops rendering rows fails
// as a result rather than silently asserting on an empty grid.
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

// DataGrid takes `layout` as a controlled prop (widths/order/pins/hidden) —
// this harness plays the role DbTab does in production, feeding
// onLayoutChange's result back in as the next render's layout.
function ControlledGrid({
  initialLayout = EMPTY_LAYOUT,
  ...props
}: Omit<DataGridProps, "layout" | "onLayoutChange"> & { initialLayout?: GridLayout }) {
  const [layout, setLayout] = useState(initialLayout);
  return <DataGrid {...props} layout={layout} onLayoutChange={setLayout} />;
}

describe("DataGrid", () => {
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

  // A checkbox rather than a word: booleans are the one column type whose whole
  // value space fits in a control. Slice 1 renders it read-only; Slice 3 makes
  // it interactive.
  it("renders a boolean as a checkbox reflecting its value", () => {
    render(<DataGrid columns={["paid"]} rows={[["true"], ["false"]]} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[0]).toBeDisabled();
  });

  // Three states, and the brief calls NULL-distinctness a hard constraint.
  it("keeps NULL distinct from false in a boolean column", () => {
    render(<DataGrid columns={["paid"]} rows={[["false"], [null]]} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("calls onSort with the clicked column", () => {
    const onSort = vi.fn();
    render(<DataGrid columns={["id", "status"]} rows={[]} onSort={onSort} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
    expect(onSort).toHaveBeenCalledWith("status", false);
  });

  // The mockup uses one chevron that rotates 180° for desc rather than two
  // distinct glyphs — the indicator is a decorative SVG (aria-hidden; sort
  // state itself is on aria-sort, covered below), so it's queried by
  // data-testid rather than by text/role.
  it("shows the sort direction indicator rotated for descending, upright for ascending", () => {
    const { rerender } = render(<DataGrid columns={["id"]} rows={[]} sort={[{ column: "id", descending: false }]} />);
    expect(screen.getByTestId("sort-chevron-id")).not.toHaveClass("rotate-180");

    rerender(<DataGrid columns={["id"]} rows={[]} sort={[{ column: "id", descending: true }]} />);
    expect(screen.getByTestId("sort-chevron-id")).toHaveClass("rotate-180");
  });

  it("copies a row as tab-separated values", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy row as tab-separated values" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("1\tpending"));
  });

  it("copies a row as JSON", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy row as JSON" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify({ id: "1", status: "pending" })),
    );
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

  // Proves the virtualizer is actually windowing rather than the mocked
  // dimensions above happening to make it render everything: with 2000 rows
  // and a 600px-tall viewport at 33px/row, a real window renders well under
  // the full count but still more than zero.
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

  // Mirrors the mockup's `.th-resize` drag handle: dragging pins that one
  // column to a fixed px width while every other column stays flexible.
  it("dragging a column's resize handle fixes that column's width, leaving others flexible", () => {
    render(<ControlledGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    const headerRow = screen.getByRole("button", { name: "Sort by id" }).closest('[role="row"]') as HTMLElement;
    expect(headerRow.style.gridTemplateColumns).toBe("minmax(140px, 1fr) minmax(140px, 1fr) 90px");

    // getBoundingClientRect is mocked (see beforeAll) to always report a
    // width of 800, so dragging 40px right should pin the column at 840px.
    fireEvent.mouseDown(screen.getByTestId("resize-handle-id"), { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 40 });
    fireEvent.mouseUp(window);

    expect(headerRow.style.gridTemplateColumns).toBe("840px minmax(140px, 1fr) 90px");
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

  // The client-side "Filter rows on this page" box (and the row-index
  // renumbering hazard it used to guard against) is gone — filtering is now
  // server-side only, via GridToolbar's Filter popover (see GridToolbar.test.tsx
  // and DbTab.test.tsx). `renderCell` always receives the plain data index
  // now, covered by the reorder test below.
  it("reorders a column with Alt+Arrow, giving the header drag a keyboard equivalent", () => {
    render(<ControlledGrid columns={["id", "status", "amount"]} rows={[]} />);
    expect(columnOrder()).toEqual(["id", "status", "amount"]);

    fireEvent.keyDown(screen.getByRole("button", { name: "Sort by status" }), { key: "ArrowRight", altKey: true });
    expect(columnOrder()).toEqual(["id", "amount", "status"]);

    fireEvent.keyDown(screen.getByRole("button", { name: "Sort by status" }), { key: "ArrowLeft", altKey: true });
    expect(columnOrder()).toEqual(["id", "status", "amount"]);
  });

  // Reordering changes where a column is drawn, never which value it holds.
  // If this regresses, an inline edit writes to whichever column happens to
  // occupy that screen position — a silent, data-corrupting failure.
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

  // Persisting layout across a table switch (the previous "remembers it under
  // the layout key" behaviour) moved to DbTab along with the `stored`/
  // `updateLayout` state — DataGrid now just reflects whatever `layout` prop
  // it's given. The storage round-trip itself (including the corrupt-JSON
  // fallback) is still covered directly in gridLayout.test.ts.
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
    fireEvent.click(screen.getByRole("button", { name: "Copy row as tab-separated values" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/clipboard permission denied/i);
  });
});
