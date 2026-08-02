import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GridToolbar } from "./GridToolbar";
import { EMPTY_LAYOUT } from "./gridLayout";
import type { FilterCondition, SortTerm } from "./types";

function renderToolbar(overrides: Partial<Parameters<typeof GridToolbar>[0]> = {}) {
  const props = {
    columns: ["id", "status"],
    rows: [["1", "paid"]] as (string | null)[][],
    layout: EMPTY_LAYOUT,
    onLayoutChange: vi.fn(),
    filter: [] as FilterCondition[],
    onFilterChange: vi.fn(),
    sort: [] as SortTerm[],
    onSortChange: vi.fn(),
    page: 1,
    pageCount: 3,
    onPageChange: vi.fn(),
    limit: 100,
    onLimitChange: vi.fn(),
    onRefresh: vi.fn(),
    familyOf: () => "text" as const,
    ...overrides,
  };
  const { rerender } = render(<GridToolbar {...props} />);
  return { ...props, rerender: (patch: Partial<Parameters<typeof GridToolbar>[0]>) => rerender(<GridToolbar {...props} {...patch} />) };
}

describe("GridToolbar", () => {
  it("shows no count badge when nothing is filtered or sorted", () => {
    renderToolbar();
    expect(screen.getByRole("button", { name: "Filter" })).not.toHaveTextContent(/\d/);
  });

  // The badge counts what is ACTING on the grid, not what is stored.
  it("counts only enabled conditions", () => {
    renderToolbar({
      filter: [
        { column: "status", op: "eq", value: "paid", enabled: true },
        { column: "id", op: "eq", value: "1", enabled: false },
      ],
    });
    expect(screen.getByRole("button", { name: /^Filter/ })).toHaveTextContent("1");
  });

  it("does not count a condition still missing its value", () => {
    renderToolbar({ filter: [{ column: "status", op: "eq", value: "", enabled: true }] });
    expect(screen.getByRole("button", { name: /^Filter/ })).not.toHaveTextContent(/\d/);
  });

  it("counts only enabled sort terms", () => {
    renderToolbar({
      sort: [
        { column: "id", descending: false, enabled: true },
        { column: "status", descending: false, enabled: false },
      ],
    });
    expect(screen.getByRole("button", { name: /^Sort/ })).toHaveTextContent("1");
  });

  it("counts hidden columns on the Columns button", () => {
    renderToolbar({ layout: { ...EMPTY_LAYOUT, hidden: ["status"] } });
    expect(screen.getByRole("button", { name: /^Columns/ })).toHaveTextContent("1");
  });

  it("goes to the page typed into the field", () => {
    const props = renderToolbar();
    const field = screen.getByRole("textbox", { name: "Page number" });
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onPageChange).toHaveBeenCalledWith(2);
  });

  // Out of range clamps rather than erroring or fetching an empty page.
  it("clamps a page beyond the last one", () => {
    const props = renderToolbar({ pageCount: 3 });
    const field = screen.getByRole("textbox", { name: "Page number" });
    fireEvent.change(field, { target: { value: "99" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onPageChange).toHaveBeenCalledWith(3);
  });

  it("disables Previous on the first page and Next on the last", () => {
    renderToolbar({ page: 1, pageCount: 1 });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  // A new page size makes the current offset meaningless.
  it("returns to page 1 when the limit changes", () => {
    const props = renderToolbar({ page: 3 });
    fireEvent.change(screen.getByRole("combobox", { name: "Rows per page" }), { target: { value: "25" } });
    expect(props.onLimitChange).toHaveBeenCalledWith(25);
    expect(props.onPageChange).toHaveBeenCalledWith(1);
  });

  it("refreshes", () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  // pageField is local state seeded once from the page prop — Prev/Next and
  // any other external page change (filter/sort/limit resets) must still
  // resync the field, not just the field's own commit path.
  it("keeps the page-number field in sync when the page prop changes externally", () => {
    const props = renderToolbar({ page: 1, pageCount: 3 });
    expect(screen.getByRole("textbox", { name: "Page number" })).toHaveValue("1");
    props.rerender({ page: 2 });
    expect(screen.getByRole("textbox", { name: "Page number" })).toHaveValue("2");
  });

  it("opens the filter popover and closes it again", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByText(/applied as a WHERE clause/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/applied as a WHERE clause/i)).not.toBeInTheDocument();
  });
});
