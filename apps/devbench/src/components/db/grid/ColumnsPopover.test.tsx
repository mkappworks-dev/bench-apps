import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ColumnsPopover } from "./ColumnsPopover";
import { EMPTY_LAYOUT, type GridLayout } from "./gridLayout";

const COLUMNS = ["id", "status", "amount"];

function renderPopover(layout: Partial<GridLayout> = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(
    <ColumnsPopover
      columns={COLUMNS}
      layout={{ ...EMPTY_LAYOUT, ...layout }}
      onChange={onChange}
      onReset={onReset}
    />,
  );
  return { onChange, onReset };
}

describe("ColumnsPopover", () => {
  // Hidden columns stay listed, or hiding one would remove the only control
  // that brings it back.
  it("lists every column, hidden ones included", () => {
    renderPopover({ hidden: ["status"] });
    expect(screen.getByRole("checkbox", { name: "Show id" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show status" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show amount" })).toBeChecked();
  });

  it("hides a visible column", () => {
    const { onChange } = renderPopover();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: ["status"] }));
  });

  it("shows a hidden column again", () => {
    const { onChange } = renderPopover({ hidden: ["status", "amount"] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: ["amount"] }));
  });

  it("toggles a pin and reports its pressed state", () => {
    const { onChange } = renderPopover({ pinned: ["id"] });
    expect(screen.getByRole("button", { name: "Unfreeze id" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Freeze status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pinned: ["id", "status"] }));
  });

  // Show all is narrow on purpose: it un-hides, and leaves widths, order and
  // pins exactly as the user set them.
  it("un-hides every column without touching widths, order or pins", () => {
    const { onChange } = renderPopover({ hidden: ["status"], pinned: ["id"], widths: { id: 200 } });
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onChange).toHaveBeenCalledWith({
      widths: { id: 200 },
      order: [],
      pinned: ["id"],
      hidden: [],
    });
  });

  // The wider reset lives beside it, in the footer's other slot — it used to
  // be a full-width strip of its own below the toolbar, which appeared in
  // neither the mockup nor the spec.
  it("offers a full layout reset in the footer", () => {
    const { onReset } = renderPopover({ hidden: ["status"], pinned: ["id"], widths: { id: 200 } });
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(onReset).toHaveBeenCalledOnce();
  });
});
