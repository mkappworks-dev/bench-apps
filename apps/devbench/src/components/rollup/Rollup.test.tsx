import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Rollup } from "./Rollup";

describe("Rollup", () => {
  it("shows a loading skeleton", () => {
    render(<Rollup diffs={[]} loading watchedTableCount={0} onTableClick={() => {}} />);
    expect(screen.getByTestId("rollup-loading")).toBeInTheDocument();
  });

  it("shows a zero-effects message when watched tables had nothing change", () => {
    render(<Rollup diffs={[]} loading={false} watchedTableCount={2} onTableClick={() => {}} />);
    expect(screen.getByText(/no observed effects/i)).toBeInTheDocument();
  });

  it("shows a distinct message when no tables are being watched at all", () => {
    render(<Rollup diffs={[]} loading={false} watchedTableCount={0} onTableClick={() => {}} />);
    expect(screen.getByText(/no tables are being watched/i)).toBeInTheDocument();
    expect(screen.queryByText(/no observed effects/i)).not.toBeInTheDocument();
  });

  it("shows a distinct message when diff data isn't available (e.g. history entries)", () => {
    render(<Rollup diffs={null} loading={false} watchedTableCount={2} onTableClick={() => {}} />);
    expect(screen.getByText(/diff not available/i)).toBeInTheDocument();
    expect(screen.queryByText(/no observed effects/i)).not.toBeInTheDocument();
  });

  it("lists each changed table and calls onTableClick", () => {
    const onTableClick = vi.fn();
    render(
      <Rollup
        diffs={[{ table: "orders", inserted: 1, updated: 0, deleted: 0 }]}
        loading={false}
        watchedTableCount={1}
        onTableClick={onTableClick}
      />,
    );
    const item = screen.getByRole("button", { name: /orders/i });
    expect(item).toHaveTextContent("1 inserted");
    fireEvent.click(item);
    expect(onTableClick).toHaveBeenCalledWith("orders");
  });
});
