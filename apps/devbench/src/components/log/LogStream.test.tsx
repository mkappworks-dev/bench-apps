import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { LogStream } from "./LogStream";
import type { LogLine } from "../../lib/tauri";

// jsdom gives every element a height of 0, which makes TanStack Virtual
// compute a zero-row viewport and render nothing. Give the layout primitives
// real numbers so the virtualizer has a window to fill.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => {} };
  };
});

function line(id: number, over: Partial<LogLine> = {}): LogLine {
  const merged = {
    id,
    source_id: "src1",
    captured_at_ms: 1_000 + id,
    timestamp: "2026-07-30T14:02:11.482Z",
    level: "INFO",
    message: `line ${id}`,
    raw: `line ${id}`,
    ...over,
  };
  // If message was overridden but raw wasn't, update raw to match for filtering to work
  if (over.message !== undefined && over.raw === undefined) {
    merged.raw = over.message;
  }
  return merged;
}

describe("LogStream", () => {
  it("renders an empty state when there are no lines", () => {
    render(<LogStream lines={[]} filter="" />);
    expect(screen.getByText(/no log lines yet/i)).toBeInTheDocument();
  });

  it("renders lines with their level and message", () => {
    render(<LogStream lines={[line(1), line(2)]} filter="" />);
    expect(screen.getByText("line 1")).toBeInTheDocument();
    expect(screen.getAllByText("INFO").length).toBeGreaterThan(0);
  });

  it("virtualizes rather than rendering every line", () => {
    const many = Array.from({ length: 3000 }, (_, i) => line(i + 1));
    render(<LogStream lines={many} filter="" />);
    const rows = screen.getAllByTestId("log-line");
    expect(rows.length).toBeLessThan(200);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("applies a case-insensitive substring filter", () => {
    render(
      <LogStream
        lines={[line(1, { message: "order created" }), line(2, { message: "inventory low" })]}
        filter="ORDER"
      />,
    );
    expect(screen.getByText("order created")).toBeInTheDocument();
    expect(screen.queryByText("inventory low")).not.toBeInTheDocument();
  });

  it("says so when the filter matches nothing, instead of looking empty", () => {
    render(<LogStream lines={[line(1)]} filter="zzzz" />);
    expect(screen.getByText(/no lines match/i)).toBeInTheDocument();
  });
});
