import { useEffect, useRef, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid, cellDisplay } from "./DataGrid";
import {
  invokeListTableRows,
  invokeListWatchedTables,
  invokeSetWatchedTable,
  invokePreviewCellEdit,
  invokeCommitPreview,
  invokeRollbackPreview,
  type TableRows,
} from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

const PAGE_SIZE = 100;

// `draft` mirrors the wire value directly (`string | null`) rather than a
// separate string + "is this null" flag — one field that's either a string
// or NULL, matching what actually goes over the wire to preview_cell_edit.
type CellEdit =
  | { rowIndex: number; columnIndex: number; phase: "editing"; draft: string | null }
  | { rowIndex: number; columnIndex: number; phase: "preview"; draft: string | null; previewId: string };

function isEditableCell(pkColumn: string | null, column: string, value: string | null): boolean {
  // A cell the grid can't even faithfully display (pk_column === null means
  // no safe WHERE target at all; "<unsupported type>" means the value shown
  // isn't really the value — editing it would mean overwriting something the
  // user never actually saw) must not be editable.
  return pkColumn !== null && column !== pkColumn && value !== "<unsupported type>";
}

function isExpiredPreviewError(message: string): boolean {
  return message.includes("no open preview");
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L19 8" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function DbTab({
  watchedTables,
  onToggleWatch,
  table,
  onPatchState,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  table: string | null;
  onPatchState: (patch: { table: string }) => void;
}) {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDescending, setSortDescending] = useState(false);
  const [page, setPage] = useState(0);

  const [editing, setEditing] = useState<CellEdit | null>(null);
  // Cell-edit failures render next to the grid, not in place of it — reusing
  // `error` (which swaps the whole grid for an error box) would make a
  // failed single-cell commit look like the entire table failed to load.
  const [editError, setEditError] = useState<string | null>(null);

  // Bumped on every fetch so a slow, superseded response (e.g. a sort click
  // fired just before a faster one) can be told apart from the latest and
  // discarded instead of clobbering it when it eventually resolves.
  const requestIdRef = useRef(0);

  // Mirrors `editing` for effects/cleanups that must not themselves depend on
  // `editing` (a table-switch effect keyed on `editing` would refire the
  // fetch on every keystroke of a draft). Kept in sync after every render.
  const editingRef = useRef<CellEdit | null>(null);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // An open preview holds a real transaction (and its row lock) on the
  // user's database. Firing this whenever a preview is abandoned — by table
  // switch, sort, paging, editing a different cell, or unmount — is what
  // keeps that lock from leaking for up to the sweep's full 2-minute window.
  // Swallowing the result: if the sweep already reclaimed it, this call
  // fails with "no open preview", which is not a real problem — the outcome
  // (transaction gone) is identical either way.
  function abandonOpenPreview(current: CellEdit | null) {
    if (current?.phase === "preview") {
      void invokeRollbackPreview(current.previewId).catch(() => {});
    }
  }

  async function fetchRows(t: string, connId: string, orderByColumn: string | null, orderByDesc: boolean, pageNum: number) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      // The backend has no cheap COUNT(*); over-fetching by one row and
      // trimming it is what lets hasNextPage be an honest fact instead of a
      // guess from "this page happened to come back full."
      const result = await invokeListTableRows(connId, t, {
        orderByColumn,
        orderByDesc,
        limit: PAGE_SIZE + 1,
        offset: pageNum * PAGE_SIZE,
      });
      if (requestId !== requestIdRef.current) return;
      setTableRows({ ...result, rows: result.rows.slice(0, PAGE_SIZE) });
      setHasNextPage(result.rows.length > PAGE_SIZE);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setTableRows(null);
      setHasNextPage(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  // A new table may not even have the old one's sort column, and its rows
  // start over at offset 0 — same reasoning one level up for a connection
  // switch underneath an already-open table. Clearing `tableRows` here too
  // (not just resetting sort/page/hasNextPage) drops the *previous* table's
  // grid from the DOM for the duration of the switch — leaving it mounted
  // would keep its stale hasNextPage/sort-column controls clickable against
  // a table whose page 0 hasn't been fetched yet under the new selection.
  useEffect(() => {
    // A stale edit can't survive a table/connection switch: its rowIndex and
    // columnIndex are about to describe entirely different data once the new
    // table's rows land, and any open preview is a transaction against
    // whatever connection/table it was opened on.
    abandonOpenPreview(editingRef.current);
    setEditing(null);
    setEditError(null);
    setSortColumn(null);
    setSortDescending(false);
    setPage(0);
    setHasNextPage(false);
    setTableRows(null);
    setError(null);
    if (table && activeConnectionId) {
      void fetchRows(table, activeConnectionId, null, false, 0);
    } else {
      requestIdRef.current++;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, activeConnectionId]);

  // Rolls back any preview left open when the tab itself goes away (closed,
  // or its pane repurposed) — the table/connection-switch effect above only
  // covers switches within a mounted DbTab, not unmounting it outright.
  useEffect(() => {
    return () => abandonOpenPreview(editingRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSort(column: string) {
    if (!table || !activeConnectionId) return;
    abandonOpenPreview(editing);
    setEditing(null);
    setEditError(null);
    const descending = sortColumn === column ? !sortDescending : false;
    setSortColumn(column);
    setSortDescending(descending);
    setPage(0);
    void fetchRows(table, activeConnectionId, column, descending, 0);
  }

  function handlePrevPage() {
    if (!table || !activeConnectionId) return;
    abandonOpenPreview(editing);
    setEditing(null);
    setEditError(null);
    const nextPage = Math.max(0, page - 1);
    setPage(nextPage);
    void fetchRows(table, activeConnectionId, sortColumn, sortDescending, nextPage);
  }

  function handleNextPage() {
    if (!table || !activeConnectionId) return;
    abandonOpenPreview(editing);
    setEditing(null);
    setEditError(null);
    const nextPage = page + 1;
    setPage(nextPage);
    void fetchRows(table, activeConnectionId, sortColumn, sortDescending, nextPage);
  }

  function startEdit(rowIndex: number, columnIndex: number, currentValue: string | null) {
    abandonOpenPreview(editing);
    setEditError(null);
    setEditing({ rowIndex, columnIndex, phase: "editing", draft: currentValue });
  }

  async function previewEdit() {
    if (!editing || editing.phase !== "editing" || !tableRows?.pk_column || !activeConnectionId || !table) return;
    const pkIndex = tableRows.columns.indexOf(tableRows.pk_column);
    const pkValue = tableRows.rows[editing.rowIndex][pkIndex];
    if (pkValue === null) {
      setEditError("Can't edit this row — its primary key value is NULL.");
      return;
    }
    try {
      const preview = await invokePreviewCellEdit(
        activeConnectionId,
        table,
        tableRows.pk_column,
        pkValue,
        tableRows.columns[editing.columnIndex],
        editing.draft,
      );
      setEditError(null);
      setEditing({ ...editing, phase: "preview", previewId: preview.preview_id });
    } catch (err) {
      // The row this edit targeted no longer matches 1-for-1 (e.g. deleted
      // or changed by something else since the page loaded) or the preview
      // never opened at all — nothing was written either way. Drop back to
      // "editing" rather than clearing the draft, so a genuinely transient
      // failure doesn't cost the user their typed value.
      setEditError(err instanceof Error ? err.message : String(err));
      setEditing({ rowIndex: editing.rowIndex, columnIndex: editing.columnIndex, phase: "editing", draft: editing.draft });
    }
  }

  async function commitEdit() {
    if (!editing || editing.phase !== "preview" || !tableRows) return;
    const { rowIndex, columnIndex, draft, previewId } = editing;
    try {
      await invokeCommitPreview(previewId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish "the sweep already rolled this back" (previews expire
      // ~2 minutes after being opened) from any other commit failure — both
      // mean nothing was written, but only one is worth telling the user
      // "you waited too long," not "something is broken."
      setEditError(
        isExpiredPreviewError(message)
          ? "This preview expired before you committed it (previews auto-expire after 2 minutes) — nothing was written. Preview the change again to retry."
          : `Commit failed — nothing was written: ${message}`,
      );
      // The preview_id is unusable regardless of which branch failed (sqlx
      // consumes the transaction on both a successful and a failed commit),
      // so retrying means previewing again, not resubmitting the same id.
      setEditing({ rowIndex, columnIndex, phase: "editing", draft });
      return;
    }
    setTableRows({
      ...tableRows,
      rows: tableRows.rows.map((row, ri) => (ri === rowIndex ? row.map((v, ci) => (ci === columnIndex ? draft : v)) : row)),
    });
    setEditing(null);
    setEditError(null);
  }

  async function rollbackEdit() {
    if (editing?.phase !== "preview") {
      setEditing(null);
      return;
    }
    try {
      await invokeRollbackPreview(editing.previewId);
      setEditError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An already-resolved preview (the sweep beat the user to it) is not
      // worth surfacing — the user asked to discard the edit, and it's gone
      // either way. Anything else genuinely failed and should be visible.
      if (!isExpiredPreviewError(message)) setEditError(message);
    }
    setEditing(null);
  }

  function renderCell(rowIndex: number, columnIndex: number, value: string | null) {
    const column = tableRows?.columns[columnIndex] ?? "";
    const editable = isEditableCell(tableRows?.pk_column ?? null, column, value);
    const isEditingThisCell = editing !== null && editing.rowIndex === rowIndex && editing.columnIndex === columnIndex;

    if (isEditingThisCell && editing.phase === "preview") {
      const { text: oldText } = cellDisplay(value);
      return (
        <div className="flex items-center gap-1.5">
          <span className="text-danger line-through">{oldText}</span>
          <span aria-hidden className="text-text-faint">
            →
          </span>
          {editing.draft === null ? (
            <span className="italic text-success">NULL</span>
          ) : (
            <span className="truncate font-semibold text-success">{editing.draft}</span>
          )}
          <button
            type="button"
            aria-label="Rollback edit"
            onClick={() => void rollbackEdit()}
            className="shrink-0 rounded-sm p-0.5 text-text-faint hover:bg-surface-2 hover:text-text"
          >
            <CrossIcon />
          </button>
          <button
            type="button"
            aria-label="Commit edit"
            onClick={() => void commitEdit()}
            className="shrink-0 rounded-sm p-0.5 text-success hover:bg-surface-2"
          >
            <CheckIcon />
          </button>
        </div>
      );
    }

    if (isEditingThisCell) {
      const isNull = editing.draft === null;
      return (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            disabled={isNull}
            value={editing.draft ?? ""}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            className="min-w-0 flex-1 rounded-sm border border-accent bg-bg px-1.5 py-0.5 text-sm text-text disabled:opacity-50"
          />
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-text-faint">
            <input
              type="checkbox"
              checked={isNull}
              onChange={(e) => setEditing({ ...editing, draft: e.target.checked ? null : "" })}
            />
            NULL
          </label>
          <button
            type="button"
            aria-label="Preview change"
            onClick={() => void previewEdit()}
            className="shrink-0 rounded-sm p-0.5 text-success hover:bg-surface-2"
          >
            <CheckIcon />
          </button>
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={() => setEditing(null)}
            className="shrink-0 rounded-sm p-0.5 text-text-faint hover:bg-surface-2 hover:text-text"
          >
            <CrossIcon />
          </button>
        </div>
      );
    }

    const { text, className } = cellDisplay(value);
    return (
      <button
        type="button"
        disabled={!editable}
        onClick={() => editable && startEdit(rowIndex, columnIndex, value)}
        className={`w-full truncate text-left ${editable ? "cursor-text hover:bg-surface-2" : ""} ${className}`}
      >
        {text}
      </button>
    );
  }

  // Watch state is scoped per connection, not just per app. Re-hydrating
  // whenever activeConnectionId changes keeps it in sync with the picker.
  useEffect(() => {
    if (!activeConnectionId) return;
    invokeListWatchedTables(activeConnectionId)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [activeConnectionId, setWatchedTables]);

  async function handleToggleWatch(table: string) {
    if (!activeConnectionId) return;
    const nextWatched = !watchedTables.has(table);
    onToggleWatch(table);
    try {
      await invokeSetWatchedTable(activeConnectionId, table, nextWatched);
    } catch {
      // Roll the optimistic toggle back rather than leaving the UI claiming a
      // table is watched when the correlation engine will not see it.
      onToggleWatch(table);
    }
  }

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connectionId={activeConnectionId}
        watchedTables={watchedTables}
        onToggleWatch={handleToggleWatch}
        onSelectTable={(t) => onPatchState({ table: t })}
        onConnectionChange={setActiveConnectionId}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {!activeConnectionId ? (
          <div className="text-sm text-text-faint">Select a connection to browse its data.</div>
        ) : error ? (
          <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
        ) : tableRows ? (
          <div className={loading ? "opacity-60 transition-opacity duration-200" : undefined}>
            {editError ? (
              <div role="alert" className="mb-2 rounded-sm border border-border bg-danger-bg px-3 py-1.5 text-xs text-danger">
                {editError}
              </div>
            ) : null}
            <DataGrid
              columns={tableRows.columns}
              rows={tableRows.rows}
              sortColumn={sortColumn}
              sortDescending={sortDescending}
              onSort={handleSort}
              hasPrevPage={page > 0}
              hasNextPage={hasNextPage}
              onPrevPage={handlePrevPage}
              onNextPage={handleNextPage}
              renderCell={renderCell}
            />
            {!tableRows.pk_column ? (
              <div className="mt-2 text-xs text-text-faint">
                No single-column primary key on <span className="font-semibold text-text-muted">{table}</span> — cells are
                read-only.
              </div>
            ) : null}
          </div>
        ) : loading ? (
          <div className="text-sm text-text-faint">Loading…</div>
        ) : null}
      </div>
    </div>
  );
}
