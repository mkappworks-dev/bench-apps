import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryTab, MIN_EDITOR_PX, MAX_EDITOR_PX } from "./QueryTab";
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
    <QueryTab tab={TAB} onOpenQuery={() => {}} onCloseQueryTabs={() => {}} watchedTables={new Set()} onToggleWatch={() => {}} />,
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

  it("browses the store's active connection, not the one its query is pinned to", async () => {
    useAppStore.setState({ activeConnectionId: "c2" });
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    const listTables = vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);

    renderTab();

    await waitFor(() => expect(listTables).toHaveBeenCalledWith("c2"));
    expect(listTables).not.toHaveBeenCalledWith("c1");
    expect(screen.getByRole("textbox", { name: "Query name" })).toHaveValue("failed orders");
  });

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

  it("makes the resize grip focusable and reports its current size and bounds", () => {
    renderTab();
    const grip = screen.getByRole("separator", { name: "Resize query editor" });
    expect(grip).toHaveAttribute("tabindex", "0");
    expect(grip).toHaveAttribute("aria-valuemin", String(MIN_EDITOR_PX));
    expect(grip).toHaveAttribute("aria-valuemax", String(MAX_EDITOR_PX));
    expect(grip).toHaveAttribute("aria-valuenow", "220");
  });

  it("resizes in ten-pixel steps and clamps keyboard input at both bounds", () => {
    renderTab();
    const grip = screen.getByRole("separator", { name: "Resize query editor" });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(grip).toHaveAttribute("aria-valuenow", "230");
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(grip).toHaveAttribute("aria-valuenow", "220");
    fireEvent.keyDown(grip, { key: "Home" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(grip).toHaveAttribute("aria-valuenow", String(MIN_EDITOR_PX));
    fireEvent.keyDown(grip, { key: "End" });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(grip).toHaveAttribute("aria-valuenow", String(MAX_EDITOR_PX));
  });

  it("prevents scrolling for resize keys and leaves unrelated keys alone", () => {
    renderTab();
    const grip = screen.getByRole("separator", { name: "Resize query editor" });
    expect(fireEvent.keyDown(grip, { key: "ArrowDown" })).toBe(false);
    expect(fireEvent.keyDown(grip, { key: "Tab" })).toBe(true);
  });

  it("shows the Pending button only when something is staged", () => {
    const { rerender } = renderTab();
    expect(screen.queryByRole("button", { name: /Pending/ })).not.toBeInTheDocument();

    act(() => {
      useAppStore.setState({
        pending: [{ kind: "sql", connection_id: "c1", table: null, statement: "SELECT 1;", previewed_effect: "1 row affected" }],
      });
    });
    rerender(<QueryTab tab={TAB} onOpenQuery={() => {}} onCloseQueryTabs={() => {}} watchedTables={new Set()} onToggleWatch={() => {}} />);
    expect(screen.getByRole("button", { name: /Pending/ })).toBeInTheDocument();
  });

  const WRITE_PREVIEW = { preview_id: "p1", columns: [], rows: [], rows_affected: 3 };
  const SELECT_PREVIEW = {
    preview_id: "p2",
    columns: ["id", "status"],
    rows: [["1", "failed"]],
    rows_affected: null,
  };

  it("runs the statement and rolls its transaction back without being asked", async () => {
    const run = vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
    expect(run).toHaveBeenCalledWith("c1", "SELECT 1;");
    expect(screen.getByText(/rolled back/i)).toBeInTheDocument();
  });

  it("reports the affected count for a write and offers to stage it", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(screen.getByText(/3 rows affected/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add to pending" })).toBeEnabled();
  });

  it("refuses to stage a statement that returned rows", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(SELECT_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add to pending" })).toBeDisabled();
  });

  it("stages the statement with the effect the run reported", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to pending" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add to pending" }));

    expect(useAppStore.getState().pending).toEqual([
      {
        kind: "sql",
        connection_id: "c1",
        table: null,
        statement: "SELECT 1;",
        previewed_effect: "3 rows affected",
      },
    ]);
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
  });

  it("clears the result when the SQL changes, since it no longer describes what would run", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);
    vi.spyOn(tauriLib, "invokeSetSavedQuerySql").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(screen.getByText(/3 rows affected/)).toBeInTheDocument());

    fireEvent.change(screen.getByRole("textbox", { name: "SQL" }), { target: { value: "SELECT 2;" } });

    expect(screen.queryByText(/3 rows affected/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
  });

  it("stages the statement that ran, even if the query's sql has since moved", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to pending" })).toBeEnabled());

    // Mutates the store directly, bypassing onSqlChange, to simulate some other route moving the sql out from under a result still on screen.
    act(() => {
      useAppStore.getState().patchSavedQuery("q1", { sql: "DROP TABLE orders;" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Add to pending" }));

    expect(useAppStore.getState().pending).toEqual([
      {
        kind: "sql",
        connection_id: "c1",
        table: null,
        statement: "SELECT 1;",
        previewed_effect: "3 rows affected",
      },
    ]);
  });

  it("discards the result and stages nothing", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(screen.getByText(/3 rows affected/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.queryByText(/3 rows affected/)).not.toBeInTheDocument();
    expect(useAppStore.getState().pending).toEqual([]);
  });

  it("surfaces a failed run as an error and stages nothing", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockRejectedValue(new Error('column "nope" does not exist'));
    const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(screen.getByText(/column "nope" does not exist/)).toBeInTheDocument());
    expect(rollback).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
  });

  it("replaces the rolled-back reassurance with a warning when the rollback fails, and blocks staging", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockRejectedValue(
      new Error("rollback failed: there is no transaction in progress"),
    );

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(screen.getByText(/could not be rolled back/i)).toBeInTheDocument());
    expect(screen.queryByText(/nothing is written unless you add it/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to pending" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Add to pending" }));
    expect(useAppStore.getState().pending).toEqual([]);
  });

  it("clears the failed-rollback warning on the next successful run", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    const rollback = vi
      .spyOn(tauriLib, "invokeRollbackPreview")
      .mockRejectedValueOnce(new Error("no transaction in progress"))
      .mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(screen.getByText(/could not be rolled back/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/rolled back — nothing is written/i)).toBeInTheDocument());
    expect(screen.queryByText(/could not be rolled back/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to pending" })).toBeEnabled();
  });

  it("points the active connection at the pinned one before opening the pending panel", () => {
    useAppStore.setState({
      activeConnectionId: "c2",
      pending: [
        { kind: "sql", connection_id: "c1", table: null, statement: "SELECT 1;", previewed_effect: "1 row affected" },
      ],
    });

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Pending/ }));

    expect(useAppStore.getState().activeConnectionId).toBe("c1");
    expect(useAppStore.getState().dockPanel).toBe("pending");
    expect(useAppStore.getState().chatOpen).toBe(true);
  });

  it("runs on Cmd+Enter from inside the editor", async () => {
    const run = vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "SQL" }), { key: "Enter", metaKey: true });

    await waitFor(() => expect(run).toHaveBeenCalled());
  });

  // Every other test in this file seeds both ids as "c1" — this one sets them apart on purpose, so a pinned/active swap can't hide.
  it("runs and stages against the pinned connection, not the one the rail is browsing", async () => {
    useAppStore.setState({ activeConnectionId: "c2" });
    const run = vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));

    await waitFor(() => expect(run).toHaveBeenCalledWith("c1", "SELECT 1;"));
    expect(run).not.toHaveBeenCalledWith("c2", expect.anything());

    await waitFor(() => expect(screen.getByRole("button", { name: "Add to pending" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add to pending" }));

    expect(useAppStore.getState().pending).toEqual([
      {
        kind: "sql",
        connection_id: "c1",
        table: null,
        statement: "SELECT 1;",
        previewed_effect: "3 rows affected",
      },
    ]);
  });

  it("keys the write debounce per field, so a SQL edit does not cancel a pending rename", async () => {
    const rename = vi.spyOn(tauriLib, "invokeRenameSavedQuery").mockResolvedValue(undefined);
    const setSql = vi.spyOn(tauriLib, "invokeSetSavedQuerySql").mockResolvedValue(undefined);
    renderTab();

    fireEvent.change(screen.getByRole("textbox", { name: "Query name" }), {
      target: { value: "renamed" },
    });
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.change(screen.getByRole("textbox", { name: "SQL" }), {
      target: { value: "SELECT 2;" },
    });

    await act(async () => { vi.advanceTimersByTime(100); });
    expect(rename).toHaveBeenCalledWith("q1", "renamed");
    expect(setSql).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(200); });
    expect(setSql).toHaveBeenCalledWith("q1", "SELECT 2;");
  });
});
