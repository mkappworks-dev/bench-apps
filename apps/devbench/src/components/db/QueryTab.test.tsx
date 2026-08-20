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
        pending: [{ kind: "sql", connection_id: "c1", table: null, statement: "SELECT 1;", previewed_effect: "1 row affected" }],
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
        previewed_effect: "3 rows affected",
      },
    ]);
    // The result is consumed by staging it; leaving it up invites a second
    // click that would stage the same statement twice.
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
  });

  // Fix 1: a result describes the statement that produced it. Left up across
  // an edit, it would let Add to pending record an effect for a statement
  // that was never previewed, and would carry a write's enabled button over
  // to whatever gets pasted next — including a SELECT.
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

  // Fix 1: staging must record what was actually sent to the database, not
  // whatever `query.sql` has since become — clearing the result on edit makes
  // the bug unreachable through the editor, but capturing at run time is what
  // keeps the invariant true even if the underlying query is mutated by some
  // other route while the result is still up.
  it("stages the statement that ran, even if the query's sql has since moved", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue(WRITE_PREVIEW);
    vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to pending" })).toBeEnabled());

    // Mutates the store directly, bypassing onSqlChange (which would itself
    // clear the result) — simulating some other route moving the query's sql
    // out from under a result that is still on screen.
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
    // A failed preview_query never returned a preview_id, so there is nothing
    // to roll back and calling it would be a guaranteed "no open preview".
    expect(rollback).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add to pending" })).not.toBeInTheDocument();
  });

  // Fix 1(b). A failed rollback means the transaction is gone, so the
  // statement may have committed. The reassurance must not stand, and a
  // statement whose effect is unknown must not be queued to run AGAIN.
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

  // The warning is per-run, not sticky: a later run whose rollback succeeds
  // must read as rolled back again.
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

  // Fix 3. Staging targets the PINNED connection; PendingPanel and Apply are
  // scoped to the ACTIVE one. Opening the panel without retargeting shows a
  // set this tab's own entries are not in.
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

  // Highest-risk property in this file: run and stage must use the tab's
  // PINNED connection, never wherever the rail happens to be browsing. Every
  // other test in this file seeds both ids as "c1", which would let a
  // pinned/active swap inside run()/stage() slip through unnoticed — this one
  // sets them apart on purpose.
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
