import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Rollup, type RollupData } from "./Rollup";

function data(over: Partial<RollupData> = {}): RollupData {
  return {
    tableDiffs: [],
    watchedTableCount: 0,
    logLines: null,
    logLinesTruncated: false,
    dbError: null,
    windowOpen: false,
    ...over,
  };
}

describe("Rollup", () => {
  it("shows a loading skeleton", () => {
    render(<Rollup data={null} loading onOpenDb={() => {}} onOpenLog={() => {}} />);
    expect(screen.getByTestId("rollup-loading")).toBeInTheDocument();
  });

  it("shows a distinct message when diff data isn't available at all (history entries)", () => {
    render(
      <Rollup
        data={data({ tableDiffs: null, dbError: null, watchedTableCount: 0 })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByText(/not available for past requests/i)).toBeInTheDocument();
  });

  it("warns that the DB could not be verified rather than showing zero writes", () => {
    render(
      <Rollup
        data={data({ tableDiffs: null, dbError: "connection failed", watchedTableCount: 2 })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByText(/unable to verify/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 writes/)).not.toBeInTheDocument();
  });

  it("says no tables are watched, distinctly from nothing having changed", () => {
    render(<Rollup data={data({ watchedTableCount: 0 })} loading={false} onOpenDb={() => {}} onOpenLog={() => {}} />);
    expect(screen.getByText(/no tables are being watched/i)).toBeInTheDocument();
  });

  it("shows aggregate DB writes and per-table detail, and deep-links per table", () => {
    const onOpenDb = vi.fn();
    render(
      <Rollup
        data={data({
          watchedTableCount: 2,
          tableDiffs: [
            { table: "orders", inserted: 1, updated: 0, deleted: 0 },
            { table: "inventory", inserted: 0, updated: 2, deleted: 0 },
          ],
        })}
        loading={false}
        onOpenDb={onOpenDb}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /DB.*3 writes/ })).toBeInTheDocument();
    const perTable = screen.getByRole("button", { name: /orders/ });
    expect(perTable).toHaveTextContent("1 inserted");
    fireEvent.click(perTable);
    expect(onOpenDb).toHaveBeenCalledWith("orders");
  });

  it("shows a log chip with the captured line count and deep-links to the Log tab", () => {
    const onOpenLog = vi.fn();
    render(
      <Rollup
        data={data({
          watchedTableCount: 1,
          logLines: [
            { id: 1, source_id: "s", captured_at_ms: 1, timestamp: null, level: "INFO", message: "a", raw: "a" },
            { id: 2, source_id: "s", captured_at_ms: 2, timestamp: null, level: "INFO", message: "b", raw: "b" },
          ],
        })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={onOpenLog}
      />,
    );
    const chip = screen.getByRole("button", { name: /Log.*2 lines/ });
    fireEvent.click(chip);
    expect(onOpenLog).toHaveBeenCalled();
  });

  it("renders the log count as N+ when the buffer dropped lines from the window", () => {
    render(
      <Rollup
        data={data({
          watchedTableCount: 1,
          logLines: [{ id: 1, source_id: "s", captured_at_ms: 1, timestamp: null, level: null, message: "a", raw: "a" }],
          logLinesTruncated: true,
        })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Log.*1\+ lines/ })).toBeInTheDocument();
  });

  it("says logs were not observed when no source is configured, not '0 lines'", () => {
    render(
      <Rollup data={data({ watchedTableCount: 1, logLines: null })} loading={false} onOpenDb={() => {}} onOpenLog={() => {}} />,
    );
    expect(screen.getByText(/log: not observed/i)).toBeInTheDocument();
  });

  it("shows the log chip as pending while the correlation window is still open", () => {
    render(
      <Rollup
        data={data({ watchedTableCount: 1, logLines: null, windowOpen: true })}
        loading={false}
        onOpenDb={() => {}}
        onOpenLog={() => {}}
      />,
    );
    expect(screen.getByTestId("rollup-log-pending")).toBeInTheDocument();
  });
});
