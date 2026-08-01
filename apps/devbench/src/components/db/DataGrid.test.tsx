import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { DataGrid } from "./DataGrid";

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
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

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

  it("calls onSort with the clicked column", () => {
    const onSort = vi.fn();
    render(<DataGrid columns={["id", "status"]} rows={[]} onSort={onSort} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
    expect(onSort).toHaveBeenCalledWith("status");
  });

  it("shows the sort direction indicator on the active column", () => {
    render(<DataGrid columns={["id"]} rows={[]} sortColumn="id" sortDescending={false} />);
    expect(screen.getByText("▲")).toBeInTheDocument();
  });

  it("disables Prev on the first page and Next when there is no next page", () => {
    render(<DataGrid columns={["id"]} rows={[]} hasPrevPage={false} hasNextPage={false} />);
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("calls onNextPage when Next is enabled and clicked", () => {
    const onNextPage = vi.fn();
    render(<DataGrid columns={["id"]} rows={[]} hasNextPage onNextPage={onNextPage} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNextPage).toHaveBeenCalled();
  });

  it("copies a row as tab-separated values", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy row as tab-separated values" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("1\tpending");
  });

  it("copies a row as JSON", async () => {
    render(<DataGrid columns={["id", "status"]} rows={[["1", "pending"]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy row as JSON" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify({ id: "1", status: "pending" }));
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
});
