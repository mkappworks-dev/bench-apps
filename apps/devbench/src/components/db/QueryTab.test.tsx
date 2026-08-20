import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryTab } from "./QueryTab";
import * as tauriLib from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";
import type { Tab } from "../../store/useAppStore";

const TAB: Tab = {
  id: "t1", kind: "query", pane: "left", ordinal: 0,
  state: { queryId: "q1", connectionId: "c1" },
};

function seed(sql = "SELECT 1;") {
  useAppStore.setState({
    savedQueries: [{ id: "q1", connection_id: "c1", name: "failed orders", sql, created_at: 1 }],
    pending: [],
    activeConnectionId: "c1",
  });
}

function renderTab() {
  return render(
    <QueryTab tab={TAB} onOpenQuery={() => {}} watchedTables={new Set()} onToggleWatch={() => {}} />,
  );
}

describe("QueryTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([]);
    seed();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the query name in an editable field, not as static text", () => {
    renderTab();
    const name = screen.getByRole("textbox", { name: "Query name" });
    expect(name).toHaveValue("failed orders");
  });

  // The store updates on the keystroke so the tab label follows immediately;
  // only the SQLite write waits. Nothing async writes back into the field
  // while it has focus, which is what keeps the caret where it was.
  it("renames into the store immediately and into the database once, debounced", async () => {
    const rename = vi.spyOn(tauriLib, "invokeRenameSavedQuery").mockResolvedValue(undefined);
    renderTab();

    const name = screen.getByRole("textbox", { name: "Query name" });
    fireEvent.change(name, { target: { value: "failed order" } });
    fireEvent.change(name, { target: { value: "failed orders today" } });

    expect(useAppStore.getState().savedQueries[0].name).toBe("failed orders today");
    expect(rename).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(300); });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("q1", "failed orders today");
  });

  it("saves edited SQL to the database once, debounced", async () => {
    const setSql = vi.spyOn(tauriLib, "invokeSetSavedQuerySql").mockResolvedValue(undefined);
    renderTab();

    fireEvent.change(screen.getByRole("textbox", { name: "SQL" }), {
      target: { value: "SELECT 2;" },
    });
    expect(useAppStore.getState().savedQueries[0].sql).toBe("SELECT 2;");
    expect(setSql).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(300); });
    expect(setSql).toHaveBeenCalledWith("q1", "SELECT 2;");
  });

  it("gives the resize grip a separator role with a horizontal orientation", () => {
    renderTab();
    const grip = screen.getByRole("separator", { name: "Resize query editor" });
    expect(grip).toHaveAttribute("aria-orientation", "horizontal");
  });

  // The pane strip's Pending button is global by design (§10 Scope) — it is
  // the only route to entries staged on a connection you are not looking at.
  it("shows the Pending button only when something is staged", () => {
    const { rerender } = renderTab();
    expect(screen.queryByRole("button", { name: /Pending/ })).not.toBeInTheDocument();

    act(() => {
      useAppStore.setState({
        pending: [{ kind: "sql", connection_id: "c1", table: null, statement: "SELECT 1;", previewed_effect: "1 row affected when run" }],
      });
    });
    rerender(<QueryTab tab={TAB} onOpenQuery={() => {}} watchedTables={new Set()} onToggleWatch={() => {}} />);
    expect(screen.getByRole("button", { name: /Pending/ })).toBeInTheDocument();
  });
});
