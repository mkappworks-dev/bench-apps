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

  // The name still resolves across the move because `mergeSavedQueries` merges
  // into one global list rather than replacing it per connection.
  it("browses the store's active connection, not the one its query is pinned to", async () => {
    useAppStore.setState({ activeConnectionId: "c2" });
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    const listTables = vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);

    renderTab();

    await waitFor(() => expect(listTables).toHaveBeenCalledWith("c2"));
    expect(listTables).not.toHaveBeenCalledWith("c1");
    expect(screen.getByRole("textbox", { name: "Query name" })).toHaveValue("failed orders");
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
    // Nothing about the result may read as written.
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

  // §12: re-running a SELECT at Apply writes nothing, so staging one would
  // occupy a slot in the count without being able to change anything.
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
        previewed_effect: "3 rows affected when run",
      },
    ]);
    // The result is consumed by staging it; leaving it up invites a second
    // click that would stage the same statement twice.
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
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
    // A failed preview_query never returned a preview_id, so there is nothing
    // to roll back and calling it would be a guaranteed "no open preview".
    expect(rollback).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
  });

  it("runs on Cmd+Enter from inside the editor", async () => {
    const run = vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "SQL" }), { key: "Enter", metaKey: true });

    await waitFor(() => expect(run).toHaveBeenCalled());
  });

  // Coverage gap from the previous task's review: one timer per field, keyed,
  // so an edit in one field cannot cancel a write already scheduled for the
  // other.
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

    // The rename's timer started first and is unaffected by the SQL edit
    // scheduled 200ms into it, so it still fires at the 300ms mark it was
    // given rather than being pushed back or cancelled.
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(rename).toHaveBeenCalledWith("q1", "renamed");
    expect(setSql).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(200); });
    expect(setSql).toHaveBeenCalledWith("q1", "SELECT 2;");
  });
});
