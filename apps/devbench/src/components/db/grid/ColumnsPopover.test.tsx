import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColumnsPopover } from "./ColumnsPopover";
import { EMPTY_LAYOUT } from "./gridLayout";

const columns = ["id", "status", "notes"];

describe("ColumnsPopover", () => {
  it("hides a column immediately", () => {
    const onChange = vi.fn();
    render(<ColumnsPopover columns={columns} layout={EMPTY_LAYOUT} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: ["status"] }));
  });

  it("shows a hidden column again", () => {
    const onChange = vi.fn();
    render(
      <ColumnsPopover columns={columns} layout={{ ...EMPTY_LAYOUT, hidden: ["status"] }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Show status" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: [] }));
  });

  it("pins and unpins a column", () => {
    const onChange = vi.fn();
    render(<ColumnsPopover columns={columns} layout={EMPTY_LAYOUT} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Freeze id" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pinned: ["id"] }));
  });

  it("restores every column with Show all", () => {
    const onChange = vi.fn();
    render(
      <ColumnsPopover
        columns={columns}
        layout={{ ...EMPTY_LAYOUT, hidden: ["status", "notes"] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hidden: [] }));
  });

  // Hiding is a view concern; the column is still fetched and exported.
  it("lists hidden columns too, so they can be brought back", () => {
    render(
      <ColumnsPopover columns={columns} layout={{ ...EMPTY_LAYOUT, hidden: ["notes"] }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("checkbox", { name: "Show notes" })).toBeInTheDocument();
  });
});
