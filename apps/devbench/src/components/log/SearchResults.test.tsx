import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchResults } from "./SearchResults";
import type { LogLine } from "../../lib/tauri";

function line(id: number, over: Partial<LogLine> = {}): LogLine {
  return {
    id,
    source_id: "src1",
    captured_at_ms: 1_000 + id,
    timestamp: "2026-07-30T14:02:11.482Z",
    level: "INFO",
    message: `line ${id}`,
    raw: `line ${id}`,
    ...over,
  };
}

describe("SearchResults", () => {
  it("prompts before the first search", () => {
    render(<SearchResults lines={[]} searched={false} error={null} />);
    expect(screen.getByText(/Search persisted log history/)).toBeInTheDocument();
  });

  it("reports an empty result distinctly from not having searched", () => {
    render(<SearchResults lines={[]} searched={true} error={null} />);
    expect(screen.getByText(/No stored lines match/)).toBeInTheDocument();
    expect(screen.queryByText(/Search persisted log history/)).not.toBeInTheDocument();
  });

  it("renders every result row", () => {
    render(<SearchResults lines={[line(1), line(2), line(3)]} searched={true} error={null} />);
    expect(screen.getAllByTestId("search-result")).toHaveLength(3);
  });

  it("shows the full date, not just the time — results span days", () => {
    render(
      <SearchResults
        lines={[line(1, { captured_at_ms: new Date("2026-07-30T14:02:11Z").getTime() })]}
        searched={true}
        error={null}
      />,
    );
    expect(screen.getByTestId("search-result")).toHaveTextContent("2026-07-30");
  });

  it("identifies the source of each result and preserves attribution for a removed source", () => {
    render(<SearchResults lines={[line(1), line(2, { source_id: "removed-worker" })]}
      sources={[{ id: "src1", label: "server.log" }]} searched={true} error={null} />);
    expect(screen.getAllByTestId("search-result")[0]).toHaveTextContent("server.log");
    expect(screen.getAllByTestId("search-result")[1]).toHaveTextContent("removed-worker");
  });

  it("shows a search error", () => {
    render(<SearchResults lines={[]} searched={true} error="failed to search log lines: disk full" />);
    expect(screen.getByText(/disk full/)).toBeInTheDocument();
  });

  it("does not auto-scroll like the live tail", () => {
    render(<SearchResults lines={[line(1)]} searched={true} error={null} />);
    // The live tail is `data-testid="log-stream"`; search results must be a
    // distinct component so nothing pins them to the newest row.
    expect(screen.queryByTestId("log-stream")).not.toBeInTheDocument();
    expect(screen.getByTestId("search-results")).toBeInTheDocument();
  });
});
