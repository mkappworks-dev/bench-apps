import { useEffect, useRef, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid, cellDisplay, CellValue } from "./DataGrid";
import { QueryConsole } from "./QueryConsole";
import { GridToolbar } from "./grid/GridToolbar";
import { canFollow, familyOfColumn, fkTargetOf, type ColumnInfo, type ForeignKeyRef } from "./grid/columnMeta";
import { FkLinkButton, FkPopover } from "./grid/FkPopover";
import { readLayout, writeLayout, type GridLayout } from "./grid/gridLayout";
import { SecondaryButton } from "../ui/SecondaryButton";
import { normalizeTable, tableKey } from "../../lib/tableIdentity";
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
import { stagedUpdateFor } from "../../lib/pendingChanges";
import { useAppStore } from "../../store/useAppStore";

// A cell being edited. No phase and no in-flight flag: accepting an edit
// mutates local state and returns — there is no request to be in flight, and
// no transaction whose fate a response has to decide.
type CellEdit = { rowIndex: number; columnIndex: number; draft: string | null };

function isEditableCell(pkColumn: string | null, column: string, value: string | null): boolean {
  // A cell the grid can't even faithfully display (pk_column === null means
  // no safe WHERE target at all; "<unsupported type>" means the value shown
  // isn't really the value — editing it would mean overwriting something the
  // user never actually saw) must not be editable.
  return pkColumn !== null && column !== pkColumn && value !== "<unsupported type>";
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

// Unlike ui/Menu's ChevronIcon (fixed text-faint, for the dropdown chevron
// that's always dim), this one has no color class — it inherits the toggle
// button's own color so it darkens/lightens the same way "Query console"'s
// text does on hover/pressed, matching the mockup.
function ConsoleChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function DbTab({
  watchedTables,
  onToggleWatch,
  table: tableProp,
  onPatchState,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
  table: QualifiedTable | string | null;
  onPatchState: (patch: { table: QualifiedTable }) => void;
}) {
  const table = normalizeTable(tableProp);
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);
  const setDockPanel = useAppStore((s) => s.setDockPanel);
  const dockPanel = useAppStore((s) => s.dockPanel);
  const setInsertTarget = useAppStore((s) => s.setInsertTarget);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const pending = useAppStore((s) => s.pending);
  const stagePendingUpdate = useAppStore((s) => s.stagePendingUpdate);

  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  // The backend derives `columns` from the first returned row, so a filter that
  // matches nothing comes back with none — which would empty every popover's
  // column picker and leave "+ Add filter" building a condition on `undefined`.
  // The toolbar reads this instead: the last shape this table actually returned.
  const [lastKnownColumns, setLastKnownColumns] = useState<string[]>([]);
  // Column types, defaults and foreign-key targets for the selected table.
  // Fetched once per table — the schema does not change when the page or the
  // filter does.
  const [columnMeta, setColumnMeta] = useState<ColumnInfo[]>([]);
  // Which cell's FK popover is open, and what the lookup for it returned.
  // Keyed by cell rather than by value: the same value can appear in several
  // rows, and only the one that was clicked should open.
  const [fkCell, setFkCell] = useState<{ rowIndex: number; columnIndex: number } | null>(null);
  const [fkRow, setFkRow] = useState<TableRows | null>(null);
  const [fkLoading, setFkLoading] = useState(false);
  const [fkError, setFkError] = useState<string | null>(null);
  // Same shape as requestIdRef: a slow lookup that lands after the popover has
  // closed (or reopened on another cell) must not paint its row into it.
  const fkRequestRef = useRef(0);
  // A jump parks its pinned filter here for the table-switch effect to pick
  // up. Declared with the other refs rather than beside handleJump because the
  // table-switch effect above closes over it — a `const` declared after that
  // effect would still work (the callback runs after render), but reading the
  // component top-to-bottom should not require knowing that.
  const pendingJumpRef = useRef<{ key: string; filter: FilterCondition[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A list, outermost term first — "status, then newest first" is a normal
  // thing to want from a grid, and the backend takes the whole ORDER BY.
  const [sort, setSort] = useState<SortTerm[]>([]);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<FilterCondition[]>([]);
  const [limit, setLimit] = useState(100);
  // From the parallel invokeCountTableRows call below, not the fetched rows —
  // the grid's own page never carries the true total.
  const [total, setTotal] = useState(0);

  // Mirrors `limit`, but updated synchronously (unlike the state variable,
  // which only takes effect on the next render). GridToolbar's rows-per-page
  // control calls onLimitChange then onPageChange back-to-back in one
  // handler — both are this render's closures, so onPageChange's own `limit`
  // read would otherwise still see the pre-change value and fetch a page at
  // the OLD size, which then wins the requestId race since it fires second.
  const limitRef = useRef(limit);

  const [editing, setEditing] = useState<CellEdit | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // A staging refusal (currently only "this row's primary key is NULL")
  // renders next to the grid, not in place of it — reusing `error`, which
  // swaps the whole grid for an error box, would make one unusable cell look
  // like the entire table failed to load.
  const [editError, setEditError] = useState<string | null>(null);

  // Column widths/order/pins/hidden, scoped per connection+table exactly like
  // DataGrid used to scope it internally — lifted up here since GridToolbar's
  // Columns popover needs to read and write the same state the grid renders
  // from. Same render-time key-swap as DataGrid had: an effect would let one
  // render paint the previous table's layout before catching up.
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

  // Bumped on every fetch so a slow, superseded response (e.g. a sort click
  // fired just before a faster one) can be told apart from the latest and
  // discarded instead of clobbering it when it eventually resolves.
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
    // Fired in parallel: the count is the slow one and the grid should not
    // block on it.
    void invokeCountTableRows(connId, t, activeFilter)
      .then((n) => {
        if (requestId === requestIdRef.current) setTotal(n);
      })
      .catch(() => {
        if (requestId === requestIdRef.current) setTotal(0);
      });
    try {
      const result = await invokeListTableRows(connId, t, {
        filter: activeFilter,
        orderBy,
        limit: pageSize,
        offset: pageNum * pageSize,
      });
      if (requestId !== requestIdRef.current) return;
      setTableRows(result);
      if (result.columns.length > 0) setLastKnownColumns(result.columns);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      // `tableRows` is deliberately left alone. A failing query is usually a
      // filter the user just applied, and clearing the rows would unmount the
      // toolbar along with them — taking away the Filter popover that is the
      // only way to undo it. The error renders above the grid instead, and the
      // stale rows stay visible and labelled by that error. On the very first
      // load there is nothing to keep, so the error box stands alone.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  // A new table may not even have the old one's sort column, and its rows
  // start over at offset 0 — same reasoning one level up for a connection
  // switch underneath an already-open table. Clearing `tableRows` here too
  // (not just resetting sort/page/filter/total) drops the *previous* table's
  // grid from the DOM for the duration of the switch — leaving it mounted
  // would keep its stale toolbar/sort-column controls clickable against a
  // table whose page 0 hasn't been fetched yet under the new selection.
  useEffect(() => {
    // A stale edit can't survive a table/connection switch: its rowIndex and
    // columnIndex are about to describe entirely different data once the new
    // table's rows land.
    setEditing(null);
    setEditError(null);
    closeFk();
    setSort([]);
    setPage(0);
    // A jump parks its pinned filter here rather than calling setFilter, which
    // this effect would clear a render later. Anything else starts unfiltered.
    const jump = pendingJumpRef.current;
    const jumpFilter =
      jump && table && jump.key === tableKey(table) ? jump.filter : [];
    pendingJumpRef.current = null;
    setFilter(jumpFilter);
    setLimit(100);
    limitRef.current = 100;
    setTotal(0);
    setTableRows(null);
    setLastKnownColumns([]);
    setError(null);
    if (table && activeConnectionId) {
      void fetchRows(table, activeConnectionId, jumpFilter, [], 0, 100);
    } else {
      requestIdRef.current++;
      setLoading(false);
    }
    // Keyed on the identity string, not `table` itself: a legacy string prop
    // is re-wrapped into a fresh object by normalizeTable on every render, so
    // depending on the object would re-run this effect (and re-fetch) every
    // render instead of only on an actual table change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table ? tableKey(table) : null, activeConnectionId]);

  // Its own effect rather than a call inside fetchRows: the metadata is per
  // table, and fetchRows also runs on every page, sort, filter and refresh.
  useEffect(() => {
    if (!table || !activeConnectionId) {
      setColumnMeta([]);
      return;
    }
    let cancelled = false;
    // Cleared before the fetch starts, not just on catch/no-table: on a
    // table switch, leaving the old table's metadata in place would let it
    // render against the new table's rows until this resolves. Absent
    // metadata degrades to a plain grid; stale metadata actively lies about
    // the schema (wrong FK targets, wrong filter operators).
    setColumnMeta([]);
    invokeDescribeColumns(activeConnectionId, table)
      .then((meta) => {
        if (!cancelled) setColumnMeta(meta);
      })
      .catch(() => {
        // No metadata degrades to text operators and no link icons, which is
        // a usable grid. Taking the tab down because the catalog query failed
        // would be worse than the feature simply being absent.
        if (!cancelled) setColumnMeta([]);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the identity string for the same reason the fetch effect above
    // is: a legacy string prop is re-wrapped into a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table ? tableKey(table) : null, activeConnectionId]);

  // Apply commits in the dock, which cannot reach this grid. When the set goes
  // from non-empty to empty by anything other than Discard, the rows on screen
  // are stale AND their staged overlay has just been cleared — so an applied
  // cell would visibly snap back to its pre-Apply value. Refetching is what
  // makes the grid agree with the database again.
  //
  // Discard all also empties the set, and also needs this: the staged overlay
  // disappearing is exactly the same repaint, and a refetch of unchanged rows
  // is cheap and always correct.
  const hadPendingRef = useRef(pending.length > 0);
  useEffect(() => {
    const had = hadPendingRef.current;
    hadPendingRef.current = pending.length > 0;
    if (!had || pending.length > 0) return;
    if (!table || !activeConnectionId) return;
    // An open editor cannot survive this refetch: the rows underneath it are
    // about to be replaced while editing.rowIndex stays put, so accepting
    // would stage the draft against whatever row lands at that index — with
    // that row's own old_value, which the backend's guard would happily
    // accept. Every other query-shape change abandons the editor first.
    abandonEditForQueryChange();
    void fetchRows(table, activeConnectionId, filter, sort, page, limitRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);

  // A query-shape change (sort, filter, page, limit, refresh) or a table switch
  // drops an open editor: its rowIndex and columnIndex are about to describe
  // different data. The PENDING SET is deliberately untouched — it is global by
  // design (spec §10) and keyed by primary key, not by row position, so it
  // survives every one of these.
  function abandonEditForQueryChange() {
    setEditing(null);
    setEditError(null);
    // A filter/sort/page/limit/refresh replaces tableRows without clearing
    // it first (unlike a table switch), so a popover anchored to a rowIndex
    // from the old rows would silently repaint onto whatever row lands at
    // that index in the new ones — and a lookup still in flight for it would
    // paint into the wrong cell entirely.
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
      // A failed lookup is not the same fact as a key pointing nowhere.
      // Reporting it as "no matching row" would turn an outage into a claim
      // about the data.
      setFkError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === fkRequestRef.current) setFkLoading(false);
    }
  }

  // Spec §8: the jump is a table switch plus a pinned `column = value` filter.
  // A filter rather than an offset means it lands on the row under any sort or
  // page size, with no positional query.
  //
  // The filter cannot simply be handed to setFilter: the table-switch effect
  // clears filter, sort, page and limit on every table change, and would wipe
  // it a render later. It is parked in pendingJumpRef and consumed there.
  function handleJump(target: ForeignKeyRef, value: string) {
    if (!activeConnectionId) return;
    const targetTable: QualifiedTable = { schema: target.schema, name: target.table };
    const targetKey = tableKey(targetTable);
    const jumpFilter: FilterCondition[] = [
      { column: target.column, op: "eq", value, enabled: true },
    ];

    // Layouts are keyed per table (gridLayout.ts, `layoutKey` above), so the
    // source table's pins and hidden columns never travel to the target in
    // the first place — there is nothing here that needs clearing.

    closeFk();

    if (table && targetKey === tableKey(table)) {
      // A self-referencing key. `table` does not change, so the table-switch
      // effect never runs — apply the jump here or the filter is parked and
      // then dropped.
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

  // Plain click replaces the sort; shift-click builds one up. Cycling a term
  // asc → desc → gone (rather than asc → desc → asc) is what makes it possible
  // to drop a column back out of a multi-sort without clearing the whole thing.
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

  /** The row's primary key value, or null when there is nothing safe to key a
   *  change by. Read from the CURRENT rows, so it is the stored value even
   *  when the cell beside it is showing a staged one. */
  function pkValueForRow(rowIndex: number): string | null {
    if (!tableRows?.pk_column) return null;
    const pkIndex = tableRows.columns.indexOf(tableRows.pk_column);
    return tableRows.rows[rowIndex]?.[pkIndex] ?? null;
  }

  function stageCell(rowIndex: number, columnIndex: number, next: string | null) {
    if (!table || !tableRows?.pk_column) return;
    const pkValue = pkValueForRow(rowIndex);
    if (pkValue === null) {
      setEditError("Can't stage a change to this row — its primary key value is NULL.");
      return;
    }
    setEditError(null);
    stagePendingUpdate({
      kind: "update",
      table,
      pk_column: tableRows.pk_column,
      pk_value: pkValue,
      column: tableRows.columns[columnIndex],
      // ALWAYS the stored value from `tableRows`, never the staged one. See
      // pendingChanges.ts: this is what makes the set a diff rather than a log,
      // and what the backend's IS NOT DISTINCT FROM guard compares against.
      old_value: tableRows.rows[rowIndex][columnIndex] ?? null,
      new_value: next,
    });
  }

  // Icon buttons here are neutral (`text-text-faint`), matching AppStrip's
  // icon-button convention — DESIGN.md reserves semantic color for actual
  // state, and a confirm/cancel affordance is generic interactivity, not
  // state.
  // (Deviates from the mockup, which fills these `.save`/`.cancel` buttons
  // with success-bg/neutral-bg — same documented tradeoff as SchemaTree's
  // watch-icon and the console toggle's aria-pressed highlighting.) Sizing
  // (20x20, 4px radius) still follows the mockup's `.cell-edit button`.
  const actionButtonClass =
    "grid h-5 w-5 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-2 hover:text-text disabled:opacity-40";
  // Accept carries the mockup's success hue (`.cell-edit .save`); cancel stays
  // neutral, so the pair reads as which control accepts the edit and which
  // abandons it rather than as two identical glyphs.
  const acceptButtonClass =
    "grid h-5 w-5 shrink-0 place-items-center rounded bg-success-bg text-success hover:brightness-125 disabled:opacity-40";

  // A cell is usually far narrower than the value inside it, so the editor
  // sizes to its content and floats over the columns to its right rather than
  // cramming into one column's width. Absolute (against the `relative` cell
  // DataGrid provides) so no neighbour reflows and the header stays aligned;
  // opaque because it is genuinely covering the cells underneath. z-20 sits
  // above sibling cells and below DataGrid's z-30 sticky header.
  const expandedEditorClass =
    "absolute left-0 top-1/2 z-20 flex w-max min-w-full -translate-y-1/2 items-center gap-1 " +
    "rounded-sm border border-border bg-surface-2 px-3 py-1 shadow-lg";

  function renderCell(rowIndex: number, columnIndex: number, value: string | null) {
    const column = tableRows?.columns[columnIndex] ?? "";
    const editable = isEditableCell(tableRows?.pk_column ?? null, column, value);
    const isEditingThisCell =
      editing !== null && editing.rowIndex === rowIndex && editing.columnIndex === columnIndex;

    const pkValue = pkValueForRow(rowIndex);
    const staged =
      table && pkValue !== null
        ? stagedUpdateFor(pending, table, pkValue, column)
        : ({ staged: false } as const);
    // The staged value is what the cell shows and what an edit of it starts
    // from — spec §10 requires it, and a checkbox that snapped back to its
    // stored value would look like the click did nothing.
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
          {/* "Stage change", not "Preview": it writes nothing, and calling it
              a preview would overstate what the button does in the other
              direction from the retired one, which understated it. */}
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

    const { className, kind } = cellDisplay(shown);

    // Spec §7: a boolean is the one type whose whole value space fits in a
    // control, so the checkbox IS the editor — no text field, no confirm or
    // cancel. NULL is not handled here: it falls through to the italic NULL
    // text below, which is what keeps the three states distinct.
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
          <CellValue value={shown} />
        </span>
        {editable ? (
          <span aria-hidden className="hidden shrink-0 text-[10.5px] text-text-faint group-hover:inline">
            ✎
          </span>
        ) : null}
      </button>
    );

    // Spec §10: an inset --warning left bar. Semantic colour for real state —
    // "changed but not written" — which is the only thing it is reserved for.
    // Absolutely positioned against the `relative` cell DataGrid already
    // provides for the expanded editor, so the grid needs no new prop and stays
    // ignorant of the pending set.
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

  // The real Postgres type, not a guess from a sample value. Before the
  // metadata lands (and if it never does) every column reads as text, whose
  // operators are the ones that work on anything.
  const familyOf = (column: string) => familyOfColumn(columnMeta, column);

  // Watch state is scoped per connection, not just per app. Re-hydrating
  // whenever activeConnectionId changes keeps it in sync with the picker.
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
      // Roll the optimistic toggle back rather than leaving the UI claiming a
      // table is watched when the correlation engine will not see it.
      onToggleWatch(table);
    }
  }

  return (
    // min-w-0 here too: this root is itself a row's main-axis flex child
    // (SplitContent's per-tab wrapper), so without it the same shrink-refusal
    // just recurs one level higher than the content column below.
    <div className="flex h-full w-full min-h-0 min-w-0">
      <SchemaTree
        connectionId={activeConnectionId}
        selected={table}
        watchedTables={watchedTables}
        onToggleWatch={handleToggleWatch}
        onSelectTable={(t) => onPatchState({ table: t })}
        onConnectionChange={setActiveConnectionId}
      />
      {/* min-w-0 overrides the flex default of min-width: auto, which refuses
          to shrink below descendant content width — without it, a wide table
          widens this column (and everything above it, up to the app window)
          instead of scrolling inside DataGrid's own scroll container. */}
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
            <button
              type="button"
              aria-label="Query console"
              aria-pressed={consoleOpen}
              onClick={() => setConsoleOpen((open) => !open)}
              className={`${pending.length > 0 ? "ml-2" : "ml-auto"} flex h-7.5 shrink-0 items-center gap-1.5 rounded-sm px-2.25 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text aria-pressed:bg-surface-2 aria-pressed:text-text`}
            >
              <span className={`flex transition-transform duration-150 ${consoleOpen ? "rotate-180" : ""}`}>
                <ConsoleChevronIcon />
              </span>
              <span>Query console</span>
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!activeConnectionId ? (
            <div className="text-sm text-text-faint">Select a connection to browse its data.</div>
          ) : (
            <>
              {/* Above the grid, never instead of it — see fetchRows' catch. */}
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
                    sort={sort}
                    onSort={handleSort}
                    renderCell={renderCell}
                    layout={layout}
                    onLayoutChange={updateLayout}
                    // Both overlays need to escape their own row's stacking
                    // context. Every virtualized row carries a `transform`, so
                    // an overlay's own z-index is sealed inside it and a LATER
                    // row paints over it — the editor had this bug too, not
                    // just the FK popover. Raising the ROW is the only fix.
                    raisedRowIndex={fkCell?.rowIndex ?? editing?.rowIndex ?? null}
                    toolbar={
                      <GridToolbar
                        // Not tableRows.columns: a filter matching zero rows
                        // returns none, which would blank every popover's
                        // column picker (see lastKnownColumns).
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
                        pageCount={Math.max(1, Math.ceil(total / limit))}
                        onPageChange={(next) => {
                          abandonEditForQueryChange();
                          setPage(next - 1);
                          void fetchRows(table!, activeConnectionId!, filter, sort, next - 1, limitRef.current);
                        }}
                        limit={limit}
                        onLimitChange={(next) => {
                          abandonEditForQueryChange();
                          // Deliberately no fetch: the toolbar always follows this
                          // with onPageChange(1), which fetches page 0 at the new
                          // size via the ref set just below. Fetching here as well
                          // would bill every page-size change a second row query
                          // and count, and the requestId race discards its result.
                          limitRef.current = next;
                          setLimit(next);
                          setPage(0);
                        }}
                        onRefresh={() => {
                          abandonEditForQueryChange();
                          void fetchRows(table!, activeConnectionId!, filter, sort, page, limitRef.current);
                        }}
                        onInsert={() => {
                          if (!table || !activeConnectionId) return;
                          setInsertTarget({ connectionId: activeConnectionId, table, columns: columnMeta });
                          setDockPanel("insert");
                          // The dock has to be open for the panel to be seen
                          // at all — opening the panel into a closed dock
                          // would read as the button doing nothing.
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
        {consoleOpen && activeConnectionId ? <QueryConsole connectionId={activeConnectionId} /> : null}
      </div>
    </div>
  );
}
