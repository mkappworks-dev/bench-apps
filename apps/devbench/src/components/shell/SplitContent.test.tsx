import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SplitContent } from "./SplitContent";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";

function renderSplit(overrides: Partial<Parameters<typeof SplitContent>[0]> = {}) {
  return render(
    <SplitContent
      onAddTab={() => {}}
      onPatchState={() => {}}
      onOpenDb={() => {}}
      onOpenLog={() => {}}
      onOpenEmail={() => {}}
      emailFocusRequest={null}
      {...overrides}
    />,
  );
}

describe("SplitContent", () => {
  beforeEach(() => {
    useAppStore.setState({ tabs: [], activeTabId: { left: null, right: null } });
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({ columns: [], rows: [] });
    vi.spyOn(tauriLib, "invokeListLogSources").mockResolvedValue([]);
  });

  it("shows the empty-state prompt in the left pane when the session has no tabs", () => {
    renderSplit();
    expect(screen.getByText(/no tools open/i)).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("adding a tool from the empty state targets the left pane", () => {
    const onAddTab = vi.fn();
    renderSplit({ onAddTab });
    fireEvent.click(screen.getByRole("button", { name: /add a tool/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Log" }));
    expect(onAddTab).toHaveBeenCalledWith("left", "log");
  });

  it("renders one main region with no tabs open in the right pane", () => {
    useAppStore.setState({ tabs: [{ id: "a", kind: "api", pane: "left", ordinal: 0, state: {} }], activeTabId: { left: "a", right: null } });
    renderSplit();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("renders two main regions once a tab occupies the right pane", () => {
    useAppStore.setState({
      tabs: [
        { id: "a", kind: "api", pane: "left", ordinal: 0, state: {} },
        { id: "b", kind: "db", pane: "right", ordinal: 0, state: {} },
      ],
      activeTabId: { left: "a", right: "b" },
    });
    renderSplit();
    expect(screen.getAllByRole("main")).toHaveLength(2);
  });

  // The spec's own lifecycle test, and the reason this rewrite exists: a Log
  // tab that unmounts stops tailing. Assert the hidden node stays in the
  // document, and that the poll it started is still running.
  it("keeps an inactive tab mounted rather than unmounting it", async () => {
    vi.useFakeTimers();
    const readLines = vi.spyOn(tauriLib, "invokeReadLogLines").mockResolvedValue({ lines: [], next_id: 0, dropped: 0 });
    useAppStore.setState({
      tabs: [
        { id: "a", kind: "api", pane: "left", ordinal: 0, state: {} },
        { id: "b", kind: "log", pane: "left", ordinal: 1, state: {} },
      ],
      activeTabId: { left: "a", right: null },
    });
    renderSplit();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    const callsWhileHidden = readLines.mock.calls.length;
    expect(callsWhileHidden).toBeGreaterThan(0);

    useAppStore.getState().setActiveTabId("left", "b");
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(readLines.mock.calls.length).toBeGreaterThan(callsWhileHidden);
    vi.useRealTimers();
  });

  // Two DB tabs in the SAME pane (the actual "duplicates allowed" scenario
  // reachable from EmptyPane's/+'s menu) — this covers state isolation: each
  // tab gets its own DbTab instance with its own `tableRows` useState, so
  // neither's fetched rows leak into the other's. It does NOT exercise
  // `key={tab.id}`'s reconciliation role — the tabs array here never
  // reorders or changes membership, so React never needs the key to tell the
  // instances apart. Cross-pane placement wouldn't catch a state leak either,
  // since separate panes are already structurally separate subtrees. RTL's
  // text queries ignore the CSS class-swap that hides the inactive tab, so
  // both instances' fetched rows must be independently queryable even though
  // only "a" is visible.
  it("gives two simultaneously-mounted DB tabs in the same pane independent, distinctly-rendered rows", async () => {
    const listRows = vi.spyOn(tauriLib, "invokeListTableRows").mockImplementation(async (_conn, table: string) => ({
      columns: ["table"],
      rows: [[table]],
    }));
    useAppStore.setState({
      tabs: [
        { id: "a", kind: "db", pane: "left", ordinal: 0, state: { table: "orders" } },
        { id: "b", kind: "db", pane: "left", ordinal: 1, state: { table: "payments" } },
      ],
      activeTabId: { left: "a", right: null },
    });
    renderSplit();

    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("payments")).toBeInTheDocument());
    expect(listRows).toHaveBeenCalledWith(expect.anything(), "orders");
    expect(listRows).toHaveBeenCalledWith(expect.anything(), "payments");

    // Switching which tab is active only flips the CSS class — DbTab's fetch
    // effect keys on its `table` prop, which does not change on an active-tab
    // switch, so no re-fetch happens and both tabs' rows are still there.
    const callCountAfterMount = listRows.mock.calls.length;
    await act(async () => {
      useAppStore.getState().setActiveTabId("left", "b");
    });
    expect(listRows.mock.calls.length).toBe(callCountAfterMount);
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText("payments")).toBeInTheDocument();
  });
});
