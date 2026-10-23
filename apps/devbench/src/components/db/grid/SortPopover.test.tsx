import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SortPopover } from "./SortPopover";
import type { SortTerm } from "./types";

const columns = ["id", "status", "created_at"];

function renderPopover(applied: SortTerm[] = [], onApply = vi.fn(), onClose = vi.fn()) {
  render(<SortPopover columns={columns} applied={applied} onApply={onApply} onClose={onClose} />);
  return { onApply, onClose };
}

describe("SortPopover", () => {
  it("does not apply until Apply is pressed", () => {
    const { onApply } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /add sort/i }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([{ column: "id", descending: false, enabled: true }]);
  });

  it("discards the draft on Cancel", () => {
    const applied: SortTerm[] = [{ column: "id", descending: false, enabled: true }];
    const { onApply, onClose } = renderPopover(applied);
    fireEvent.click(screen.getByRole("button", { name: /add sort/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("toggles direction", () => {
    const { onApply } = renderPopover([{ column: "id", descending: false, enabled: true }]);
    fireEvent.click(screen.getByRole("button", { name: /direction for id/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([{ column: "id", descending: true, enabled: true }]);
  });

  // Priority IS the row order, so moving a row is how precedence changes.
  it("moves a term up to raise its priority", () => {
    const applied: SortTerm[] = [
      { column: "id", descending: false, enabled: true },
      { column: "status", descending: false, enabled: true },
    ];
    const { onApply } = renderPopover(applied);
    fireEvent.click(screen.getByRole("button", { name: /raise priority of status/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([
      { column: "status", descending: false, enabled: true },
      { column: "id", descending: false, enabled: true },
    ]);
  });

  it("cannot move the first term up or the last term down", () => {
    const applied: SortTerm[] = [
      { column: "id", descending: false, enabled: true },
      { column: "status", descending: false, enabled: true },
    ];
    renderPopover(applied);
    expect(screen.getByRole("button", { name: /raise priority of id/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /lower priority of status/i })).toBeDisabled();
  });

  // A term excluded from the ORDER BY has no priority, so it shows no number.
  it("numbers enabled terms only", () => {
    const applied: SortTerm[] = [
      { column: "id", descending: false, enabled: false },
      { column: "status", descending: false, enabled: true },
      { column: "created_at", descending: false, enabled: true },
    ];
    renderPopover(applied);
    expect(screen.getByTestId("rank-id")).toHaveTextContent("—");
    expect(screen.getByTestId("rank-status")).toHaveTextContent("1");
    expect(screen.getByTestId("rank-created_at")).toHaveTextContent("2");
  });

  // Each row's column picker needs its own accessible name, or assistive tech
  // can't tell rows apart once there are 2+ (the common case, since row order
  // is the whole point of this popover).
  it("gives each row's column select a distinct accessible name", () => {
    const applied: SortTerm[] = [
      { column: "id", descending: false, enabled: true },
      { column: "status", descending: false, enabled: true },
    ];
    renderPopover(applied);
    const selects = screen.getAllByRole("combobox", { name: /sort column/i });
    expect(selects).toHaveLength(2);
    expect(new Set(selects.map((el) => el.getAttribute("aria-label"))).size).toBe(2);
  });
});
