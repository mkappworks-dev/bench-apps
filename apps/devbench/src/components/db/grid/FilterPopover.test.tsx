import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterPopover } from "./FilterPopover";
import type { FilterCondition } from "./types";

const columns = ["id", "status", "paid"];
const familyOf = (column: string) => (column === "paid" ? "boolean" as const : "text" as const);

function renderPopover(applied: FilterCondition[] = [], onApply = vi.fn(), onClose = vi.fn()) {
  render(
    <FilterPopover columns={columns} familyOf={familyOf} applied={applied} onApply={onApply} onClose={onClose} />,
  );
  return { onApply, onClose };
}

describe("FilterPopover", () => {
  it("adds a condition row without applying anything", () => {
    const { onApply } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    expect(screen.getByRole("combobox", { name: "Filter column" })).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  // The draft is the whole point: nothing reaches the query until Apply.
  it("does not apply while editing, only on Apply", () => {
    const { onApply } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter column" }), { target: { value: "status" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter value" }), { target: { value: "paid" } });
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      { column: "status", op: "eq", value: "paid", enabled: true },
    ]);
  });

  it("discards the draft on Cancel", () => {
    const { onApply, onClose } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // An unticked rule is kept so it can be switched back on without retyping.
  it("keeps an unticked condition but marks it disabled", () => {
    const applied: FilterCondition[] = [{ column: "status", op: "eq", value: "paid", enabled: true }];
    const { onApply } = renderPopover(applied);
    fireEvent.click(screen.getByRole("checkbox", { name: /include/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      { column: "status", op: "eq", value: "paid", enabled: false },
    ]);
  });

  it("removes a condition", () => {
    const applied: FilterCondition[] = [{ column: "status", op: "eq", value: "paid", enabled: true }];
    const { onApply } = renderPopover(applied);
    fireEvent.click(screen.getByRole("button", { name: /remove condition/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([]);
  });

  // The operator list must describe the column's type, not a fixed menu.
  it("offers boolean operators for a boolean column", () => {
    renderPopover([{ column: "paid", op: "is_true", value: null, enabled: true }]);
    const operators = [...screen.getByRole("combobox", { name: "Filter operator" }).querySelectorAll("option")];
    expect(operators.map((o) => o.textContent)).toEqual(["is true", "is false", "is null", "is not null"]);
  });

  // Changing column can invalidate the operator, so it resets.
  it("resets the operator when the column changes", () => {
    renderPopover([{ column: "status", op: "contains", value: "x", enabled: true }]);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter column" }), { target: { value: "paid" } });
    expect(screen.getByRole("combobox", { name: "Filter operator" })).toHaveValue("is_true");
  });

  it("hides the value field for an operator that takes none", () => {
    renderPopover([{ column: "status", op: "is_null", value: null, enabled: true }]);
    expect(screen.queryByRole("textbox", { name: "Filter value" })).not.toBeInTheDocument();
  });
});
