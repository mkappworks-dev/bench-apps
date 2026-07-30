import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Rollup } from "./Rollup";

describe("Rollup", () => {
  it("shows a loading skeleton", () => {
    render(<Rollup diffs={[]} loading onTableClick={() => {}} />);
    expect(screen.getByTestId("rollup-loading")).toBeInTheDocument();
  });

  it("shows a zero-effects message when nothing changed", () => {
    render(<Rollup diffs={[]} loading={false} onTableClick={() => {}} />);
    expect(screen.getByText(/no observed effects/i)).toBeInTheDocument();
  });

  it("lists each changed table and calls onTableClick", () => {
    const onTableClick = vi.fn();
    render(
      <Rollup
        diffs={[{ table: "orders", inserted: 1, updated: 0, deleted: 0 }]}
        loading={false}
        onTableClick={onTableClick}
      />,
    );
    const item = screen.getByRole("button", { name: /orders/i });
    expect(item).toHaveTextContent("1 inserted");
    fireEvent.click(item);
    expect(onTableClick).toHaveBeenCalledWith("orders");
  });
});
