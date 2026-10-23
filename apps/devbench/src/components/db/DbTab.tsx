import { useEffect, useRef, useState } from "react";
import { ConnectionRail } from "./ConnectionRail";
import { DataGrid, cellDisplay, CellValue } from "./DataGrid";
import { GridToolbar } from "./grid/GridToolbar";
import { canFollow, familyOfColumn, fkTargetOf, type ColumnInfo, type ForeignKeyRef } from "./grid/columnMeta";
import { FkLinkButton, FkPopover } from "./grid/FkPopover";
import { readLayout, writeLayout, type GridLayout } from "./grid/gridLayout";
import { SecondaryButton } from "../ui/SecondaryButton";
import { normalizeTable, tableKey } from "../../lib/tableIdentity";
import { tableCountCache } from "../../lib/tableCountCache";
import {
  invokeListTableRows,
  invokeCountTableRows,
  invokeDescribeColumns,
  invokeGetReferencedRow,
  invokeListWatchedTables,
  invokeSetWatchedTable,
  type FilterCondition,
  type QualifiedTable,
  type SortTerm,
  type TableRows,
} from "../../lib/tauri";
import { stagedUpdateFor, hasStagedDelete } from "../../lib/pendingChanges";
import { useAppStore } from "../../store/useAppStore";

type CellEdit = { rowIndex: number; columnIndex: number; draft: string | null };

// Marker for a value cell_to_string couldn't decode — never a real value, never a WHERE match.
const UNSUPPORTED = "<unsupported type>";

function isEditableCell({
  pkColumn,
  pkValue,
  column,
  value,
  stagedDelete,
}: {
  pkColumn: string | null;
  pkValue: string | null;
  column: string;
  value: string | null;
  stagedDelete: boolean;
}): boolean {
  // Staged-delete rows are refused too: an update appended after the delete would match zero rows at Apply.
  return (
    pkColumn !== null &&
    pkValue !== null &&
    column !== pkColumn &&
    value !== UNSUPPORTED &&
    !stagedDelete
  );
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

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
    </svg>
  );
}

export function DbTab({
  watchedTables,
  onToggleWatch,
  table: tableProp,
  onPatchState,
  onOpenQuery,
  onCloseQueryTabs,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
  table: QualifiedTable | string | null;
  onPatchState: (patch: { table: QualifiedTable }) => void;
  onOpenQuery: (queryId: string) => void;
  onCloseQueryTabs: (queryId: string) => void;
}) {
  const table = normalizeTable(tableProp);
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);
  const setDockPanel = useAppStore((s) => s.setDockPanel);
  const dockPanel = useAppStore((s) => s.dockPanel);
  const setInsertTarget = useAppStore((s) => s.setInsertTarget);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const pending = useAppStore((s) => s.pending);
  const applyGeneration = useAppStore((s) => s.applyGeneration);
  const stagePendingUpdate = useAppStore((s) => s.stagePendingUpdate);
  const togglePendingDelete = useAppStore((s) => s.togglePendingDelete);

  const [tableRows, setTableRows] = useState<(TableRows & { offset: number }) | null>(null);
  // tableRows.columns comes back empty when a filter matches nothing; this holds the last non-empty shape.
  const [lastKnownColumns, setLastKnownColumns] = useState<string[]>([]);
  const [columnMeta, setColumnMeta] = useState<ColumnInfo[]>([]);
  const [fkCell, setFkCell] = useState<{ rowIndex: number; columnIndex: number } | null>(null);
  const [fkRow, setFkRow] = useState<TableRows | null>(null);
  const [fkLoading, setFkLoading] = useState(false);
  const [fkError, setFkError] = useState<string | null>(null);
  const fkRequestRef = useRef(0);
  const pendingJumpRef = useRef<{ key: string; filter: FilterCondition[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SortTerm[]>([]);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<FilterCondition[]>([]);
  const [limit, setLimit] = useState(100);
  const [total, setTotal] = useState<number | null>(null);

  const limitRef = useRef(limit);

  const [editing, setEditing] = useState<CellEdit | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const layoutKey = `${activeConnectionId}:${table ? tableKey(table) : "null"}`;
  const [storedLayout, setStoredLayout] = useState(() => ({ key: layoutKey, layout: readLayout(layoutKey) }));
  if (storedLayout.key !== layoutKey) {
    setStoredLayout({ key: layoutKey, layout: readLayout(layoutKey) });
  }
  const layout = storedLayout.layout;
  function updateLayout(next: GridLayout) {
    setStoredLayout({ key: layoutKey, layout: next });
    writeLayout(layoutKey, next);
  }

  const requestIdRef = useRef(0);

  async function fetchRows(
    t: QualifiedTable,
    connId: string,
    activeFilter: FilterCondition[],
    orderBy: SortTerm[],
    pageNum: number,
    pageSize: number,
  ) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setTotal(null);
    void tableCountCache.get(activeSessionId, connId, t, activeFilter, () => invokeCountTableRows(connId, t, activeFilter))
      .then((n) => {
        if (requestId === requestIdRef.current) setTotal(n);
      })
      .catch(() => {
        if (requestId === requestIdRef.current) setTotal(null);
      });
    try {
      const result = await invokeListTableRows(connId, t, {
        filter: activeFilter,
        orderBy,
        limit: pageSize,
        offset: pageNum * pageSize,
      });
      if (requestId !== requestIdRef.current) return;
      setTableRows({ ...result, offset: pageNum * pageSize });
      if (result.columns.length > 0) setLastKnownColumns(result.columns);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      // tableRows is deliberately left alone — clearing it would unmount the toolbar (and its Filter popover) needed to fix the error.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    setEditing(null);
    setEditError(null);
    closeFk();
    setSort([]);
    setPage(0);
    const jump = pendingJumpRef.current;
    const jumpFilter =
      jump && table && jump.key === tableKey(table) ? jump.filter : [];
    pendingJumpRef.current = null;
    setFilter(jumpFilter);
    setLimit(100);
    limitRef.current = 100;
    setTotal(null);
    setTableRows(null);
    setLastKnownColumns([]);
    setError(null);
    if (table && activeConnectionId) {
      void fetchRows(table, activeConnectionId, jumpFilter, [], 0, 100);
    } else {
      requestIdRef.current++;
      setLoading(false);
    }
    // table is re-wrapped into a fresh object each render, so keying on tableKey(table) avoids re-fetching every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table ? tableKey(table) : null, activeConnectionId, activeSessionId]);

  useEffect(() => {
    if (!table || !activeConnectionId) {
      setColumnMeta([]);
      return;
    }
    let cancelled = false;
    setColumnMeta([]);
    invokeDescribeColumns(activeConnectionId, table)
      .then((meta) => {
        if (!cancelled) setColumnMeta(meta);
      })
      .catch(() => {
        if (!cancelled) setColumnMeta([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table ? tableKey(table) : null, activeConnectionId]);

  const seenApplyRef = useRef(applyGeneration);
  useEffect(() => {
    if (seenApplyRef.current === applyGeneration) return;
    seenApplyRef.current = applyGeneration;
    if (!table || !activeConnectionId) return;
    abandonEditForQueryChange();
    void fetchRows(table, activeConnectionId, filter, sort, page, limitRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyGeneration]);

  function abandonEditForQueryChange() {
    setEditing(null);
    setEditError(null);
    closeFk();
  }

  function closeFk() {
    fkRequestRef.current++;
    setFkCell(null);
    setFkRow(null);
    setFkError(null);
    setFkLoading(false);
  }

  async function openFk(rowIndex: number, columnIndex: number, column: string, value: string) {
    if (!table || !activeConnectionId) return;
    const requestId = ++fkRequestRef.current;
    setFkCell({ rowIndex, columnIndex });
    setFkRow(null);
    setFkError(null);
    setFkLoading(true);
    try {
      const referenced = await invokeGetReferencedRow(activeConnectionId, table, column, value);
      if (requestId !== fkRequestRef.current) return;
      setFkRow(referenced);
    } catch (err) {
      if (requestId !== fkRequestRef.current) return;
      setFkError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === fkRequestRef.current) setFkLoading(false);
    }
  }

  function handleJump(target: ForeignKeyRef, value: string) {
    if (!activeConnectionId) return;
    const targetTable: QualifiedTable = { schema: target.schema, name: target.table };
    const targetKey = tableKey(targetTable);
    const jumpFilter: FilterCondition[] = [
      { column: target.column, op: "eq_typed", value, enabled: true },
    ];

    closeFk();

    if (table && targetKey === tableKey(table)) {
      abandonEditForQueryChange();
      setSort([]);
      setPage(0);
      setFilter(jumpFilter);
      void fetchRows(table, activeConnectionId, jumpFilter, [], 0, limitRef.current);
      return;
    }

    pendingJumpRef.current = { key: targetKey, filter: jumpFilter };
    onPatchState({ table: targetTable });
  }

  function handleSort(column: string, additive: boolean) {
    if (!table || !activeConnectionId) return;
    abandonEditForQueryChange();

    const existing = sort.find((term) => term.column === column);
    let next: SortTerm[];
    if (!additive) {
      next =
        existing && !existing.descending
          ? [{ column, descending: true, enabled: true }]
          : [{ column, descending: false, enabled: true }];
    } else if (!existing) {
      next = [...sort, { column, descending: false, enabled: true }];
    } else if (!existing.descending) {
      next = sort.map((term) => (term.column === column ? { column, descending: true, enabled: true } : term));
    } else {
      next = sort.filter((term) => term.column !== column);
    }

    setSort(next);
    setPage(0);
    void fetchRows(table, activeConnectionId, filter, next, 0, limit);
  }

  function startEdit(rowIndex: number, columnIndex: number, currentValue: string | null) {
    setEditError(null);
    setEditing({ rowIndex, columnIndex, draft: currentValue });
  }

  function pkValueForRow(rowIndex: number): string | null {
    if (!tableRows?.pk_column) return null;
    const pkIndex = tableRows.columns.indexOf(tableRows.pk_column);
    const value = tableRows.rows[rowIndex]?.[pkIndex] ?? null;
    return value === UNSUPPORTED ? null : value;
  }

  function stageCell(rowIndex: number, columnIndex: number, next: string | null) {
    if (!table || !tableRows?.pk_column || !activeConnectionId) return;
    const pkValue = pkValueForRow(rowIndex);
    if (pkValue === null) {
      setEditError("Can't stage a change to this row — its primary key has no usable value.");
      return;
    }
    setEditError(null);
    stagePendingUpdate({
      kind: "update",
      connection_id: activeConnectionId,
      table,
      pk_column: tableRows.pk_column,
      pk_value: pkValue,
      column: tableRows.columns[columnIndex],
      old_value: tableRows.rows[rowIndex][columnIndex] ?? null,
      new_value: next,
    });
  }

  const actionButtonClass =
    "grid h-5 w-5 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-2 hover:text-text disabled:opacity-40";
  const acceptButtonClass =
    "grid h-5 w-5 shrink-0 place-items-center rounded bg-success-bg text-success hover:brightness-125 disabled:opacity-40";

  // z-20: above sibling cells, below DataGrid's z-30 sticky header.
  const expandedEditorClass =
    "absolute left-0 top-1/2 z-20 flex w-max min-w-full -translate-y-1/2 items-center gap-1 " +
    "rounded-sm border border-border bg-surface-2 px-3 py-1 shadow-lg";

  function renderCell(rowIndex: number, columnIndex: number, value: string | null) {
    const column = tableRows?.columns[columnIndex] ?? "";
    const isEditingThisCell =
      editing !== null && editing.rowIndex === rowIndex && editing.columnIndex === columnIndex;

    const pkValue = pkValueForRow(rowIndex);
    const addressable = table !== null && pkValue !== null && activeConnectionId !== null;
    const stagedDelete = addressable
      ? hasStagedDelete(pending, activeConnectionId, table, pkValue)
      : false;
    const editable = isEditableCell({
      pkColumn: tableRows?.pk_column ?? null,
      pkValue,
      column,
      value,
      stagedDelete,
    });
    const staged = addressable
      ? stagedUpdateFor(pending, activeConnectionId, table, pkValue, column)
      : ({ staged: false } as const);
    const shown = staged.staged ? staged.value : value;

    if (isEditingThisCell) {
      const stage = () => {
        stageCell(rowIndex, columnIndex, editing.draft);
        setEditing(null);
      };
      return (
        <div className={expandedEditorClass}>
          <input
            autoFocus
            aria-label={`Edit ${column}`}
            size={Math.min(Math.max((editing.draft ?? "").length + 1, 12), 60)}
            value={editing.draft ?? ""}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") stage();
              if (e.key === "Escape") setEditing(null);
            }}
            className="min-w-0 rounded border border-accent bg-bg px-1.5 py-0.75 text-xs text-text"
          />
          <button
            type="button"
            aria-label="Stage change"
            onClick={stage}
            className={acceptButtonClass}
          >
            <CheckIcon />
          </button>
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={() => setEditing(null)}
            className={actionButtonClass}
          >
            <CrossIcon />
          </button>
        </div>
      );
    }

    const udt = tableRows?.column_types?.[columnIndex] ?? columnMeta.find((info) => info.name === column)?.udt;
    const { className, kind } = cellDisplay(shown, udt);

    if (kind === "bool-true" || kind === "bool-false") {
      const checked = kind === "bool-true";
      return (
        <>
          {staged.staged ? (
            <span
              aria-hidden
              data-staged="true"
              className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-warning"
            />
          ) : null}
          <input
            type="checkbox"
            checked={checked}
            disabled={!editable}
            aria-label={column}
            title={editable ? "Toggle — staged until you Apply" : "Read-only"}
            onChange={() => stageCell(rowIndex, columnIndex, checked ? "false" : "true")}
            className="mx-auto block size-3.5 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent disabled:opacity-50"
          />
        </>
      );
    }

    const alignClass = kind === "number" && column === tableRows?.pk_column ? "" : className;

    const target = fkTargetOf(columnMeta, column);
    const followable = target !== null && canFollow(columnMeta, column, shown);
    const fkOpen =
      fkCell !== null && fkCell.rowIndex === rowIndex && fkCell.columnIndex === columnIndex;

    const valueButton = (
      <button
        type="button"
        disabled={!editable}
        title={staged.staged ? "Staged — not written until you Apply" : undefined}
        onClick={() => editable && startEdit(rowIndex, columnIndex, shown)}
        className={`group flex min-w-0 items-center gap-1 text-left ${
          followable ? "flex-1" : "w-full"
        } ${editable ? "hover:cursor-text hover:bg-surface-2" : ""}`}
      >
        <span className={`min-w-0 flex-1 truncate ${alignClass}`}>
          <CellValue value={shown} udt={udt} />
        </span>
        {editable ? (
          <span aria-hidden className="hidden shrink-0 text-[10.5px] text-text-faint group-hover:inline">
            ✎
          </span>
        ) : null}
      </button>
    );

    const stagedBar = staged.staged ? (
      <span
        aria-hidden
        data-staged="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-warning"
      />
    ) : null;

    if (!followable || target === null || shown === null) {
      return (
        <>
          {stagedBar}
          {valueButton}
        </>
      );
    }

    return (
      <>
        {stagedBar}
        <div className="flex w-full min-w-0 items-center gap-1.5">
          {valueButton}
          <FkLinkButton
            target={target}
            onOpen={() => (fkOpen ? closeFk() : void openFk(rowIndex, columnIndex, column, shown))}
          />
          {fkOpen ? (
            <FkPopover
              target={target}
              row={fkRow}
              loading={fkLoading}
              error={fkError}
              onJump={() => handleJump(target, shown)}
              onClose={closeFk}
            />
          ) : null}
        </div>
      </>
    );
  }

  const familyOf = (column: string) => familyOfColumn(columnMeta, column);

  useEffect(() => {
    if (!activeConnectionId) return;
    invokeListWatchedTables(activeConnectionId)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [activeConnectionId, setWatchedTables]);

  async function handleToggleWatch(table: QualifiedTable) {
    if (!activeConnectionId) return;
    const key = tableKey(table);
    const nextWatched = !watchedTables.has(key);
    onToggleWatch(table);
    try {
      await invokeSetWatchedTable(activeConnectionId, table, nextWatched);
    } catch {
      onToggleWatch(table);
    }
  }

  return (
    // min-w-0: flex's default min-width:auto would otherwise block shrinking below content width.
    <div className="flex h-full w-full min-h-0 min-w-0">
      <ConnectionRail
        connectionId={activeConnectionId}
        selected={table}
        watchedTables={watchedTables}
        onToggleWatch={handleToggleWatch}
        onSelectTable={(t) => onPatchState({ table: t })}
        onConnectionChange={setActiveConnectionId}
        initialSegment="tables"
        activeQueryId={null}
        onOpenQuery={onOpenQuery}
        onCloseQueryTabs={onCloseQueryTabs}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {activeConnectionId ? (
          <div className="flex h-11 items-center border-b border-border px-3.5">
            <span className="text-xs font-semibold text-text-muted">{table ? table.name : "No table selected"}</span>
            {pending.length > 0 ? (
              <SecondaryButton
                className="ml-auto h-7 gap-1.5"
                aria-pressed={dockPanel === "pending"}
                onClick={() => {
                  setDockPanel("pending");
                  setChatOpen(true);
                }}
              >
                <span>Pending</span>
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-lg bg-accent px-1 text-[10.5px] font-bold text-accent-on">
                  {pending.length}
                </span>
              </SecondaryButton>
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!activeConnectionId ? (
            <div className="text-sm text-text-faint">Select a connection to browse its data.</div>
          ) : (
            <>
              {error ? (
                <div role="alert" className="mb-2 rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">
                  {error}
                </div>
              ) : null}
              {tableRows ? (
                <div className={loading ? "opacity-60 transition-opacity duration-200" : undefined}>
                  {editError ? (
                    <div role="alert" className="mb-2 rounded-sm border border-border bg-danger-bg px-3 py-1.5 text-xs text-danger">
                      {editError}
                    </div>
                  ) : null}
                  <DataGrid
                    columns={tableRows.columns}
                    rows={tableRows.rows}
                    getRowLabel={(rowIndex) => {
                      const pkValue = pkValueForRow(rowIndex);
                      return pkValue === null
                        ? String(tableRows.offset + rowIndex + 1)
                        : `${tableRows.pk_column} ${pkValue}`;
                    }}
                    sort={sort}
                    onSort={handleSort}
                    renderCell={renderCell}
                    layout={layout}
                    onLayoutChange={updateLayout}
                    // Every virtualized row carries a `transform`, sealing its own z-index inside it — raising the row is the only way an overlay escapes a later row painting over it.
                    raisedRowIndex={fkCell?.rowIndex ?? editing?.rowIndex ?? null}
                    renderRowActions={(rowIndex) => {
                      const pkColumn = tableRows?.pk_column;
                      if (!table || !pkColumn || !activeConnectionId) return null;
                      const pkValue = pkValueForRow(rowIndex);
                      if (pkValue === null) return null;
                      const staged = hasStagedDelete(pending, activeConnectionId, table, pkValue);
                      return (
                        <button
                          type="button"
                          aria-label={
                            staged
                              ? `Undo staged delete of row ${pkValue}`
                              : `Stage delete of row ${pkValue}`
                          }
                          aria-pressed={staged}
                          onClick={() =>
                            togglePendingDelete(activeConnectionId, table, pkColumn, pkValue)
                          }
                          className={`px-1 ${
                            staged ? "text-danger" : "text-text-faint hover:text-danger"
                          }`}
                        >
                          <TrashIcon />
                        </button>
                      );
                    }}
                    toolbar={
                      <GridToolbar
                        columns={tableRows.columns.length > 0 ? tableRows.columns : lastKnownColumns}
                        rows={tableRows.rows}
                        layout={layout}
                        onLayoutChange={updateLayout}
                        filter={filter}
                        onFilterChange={(next) => {
                          abandonEditForQueryChange();
                          setFilter(next);
                          setPage(0);
                          void fetchRows(table!, activeConnectionId!, next, sort, 0, limitRef.current);
                        }}
                        sort={sort}
                        onSortChange={(next) => {
                          abandonEditForQueryChange();
                          setSort(next);
                          setPage(0);
                          void fetchRows(table!, activeConnectionId!, filter, next, 0, limitRef.current);
                        }}
                        page={page + 1}
                        pageCount={total === null ? null : Math.max(1, Math.ceil(total / limit))}
                        onPageChange={(next) => {
                          abandonEditForQueryChange();
                          setPage(next - 1);
                          void fetchRows(table!, activeConnectionId!, filter, sort, next - 1, limitRef.current);
                        }}
                        limit={limit}
                        onLimitChange={(next) => {
                          abandonEditForQueryChange();
                          // No fetch here — the toolbar always follows with onPageChange(1), which fetches at the new size.
                          limitRef.current = next;
                          setLimit(next);
                          setPage(0);
                        }}
                        onRefresh={() => {
                          abandonEditForQueryChange();
                          tableCountCache.invalidateTable(activeConnectionId!, table!);
                          void fetchRows(table!, activeConnectionId!, filter, sort, page, limitRef.current);
                        }}
                        onInsert={() => {
                          if (!table || !activeConnectionId) return;
                          setInsertTarget({ connectionId: activeConnectionId, table, columns: columnMeta });
                          setDockPanel("insert");
                          setChatOpen(true);
                        }}
                        familyOf={familyOf}
                      />
                    }
                  />
                  {!tableRows.pk_column ? (
                    <div className="mt-2.5 text-xs text-text-faint">
                      No single-column primary key on <span className="font-semibold text-text-muted">{table!.name}</span> — cells
                      are read-only.
                    </div>
                  ) : null}
                </div>
              ) : loading ? (
                <div className="text-sm text-text-faint">Loading…</div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
