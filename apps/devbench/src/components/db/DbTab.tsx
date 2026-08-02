import { useEffect, useRef, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid, cellDisplay, CellValue } from "./DataGrid";
import { QueryConsole } from "./QueryConsole";
import { GridToolbar } from "./grid/GridToolbar";
import { inferFamily, type ColumnFamily } from "./grid/types";
import { readLayout, writeLayout, type GridLayout } from "./grid/gridLayout";
import {
  invokeListTableRows,
  invokeCountTableRows,
  invokeListWatchedTables,
  invokeSetWatchedTable,
  invokePreviewCellEdit,
  invokeCommitPreview,
  invokeRollbackPreview,
  type FilterCondition,
  type SortTerm,
  type TableRows,
} from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

// `draft` mirrors the wire value directly (`string | null`) rather than a
// separate string + "is this null" flag — one field that's either a string
// or NULL, matching what actually goes over the wire to preview_cell_edit.
// `pending` is true while a preview/commit/rollback request for *this* edit
// is in flight — it disables the button that would fire an overlapping
// duplicate request, and gates whether a landing response is still allowed
// to touch component state (see `editGenerationRef` below).
type CellEdit =
  | { rowIndex: number; columnIndex: number; phase: "editing"; draft: string | null; pending: boolean }
  | { rowIndex: number; columnIndex: number; phase: "preview"; draft: string | null; previewId: string; pending: boolean };

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
  // The backend derives `columns` from the first returned row, so a filter that
  // matches nothing comes back with none — which would empty every popover's
  // column picker and leave "+ Add filter" building a condition on `undefined`.
  // The toolbar reads this instead: the last shape this table actually returned.
  const [lastKnownColumns, setLastKnownColumns] = useState<string[]>([]);
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
  // Cell-edit failures render next to the grid, not in place of it — reusing
  // `error` (which swaps the whole grid for an error box) would make a
  // failed single-cell commit look like the entire table failed to load.
  const [editError, setEditError] = useState<string | null>(null);

  // Column widths/order/pins/hidden, scoped per connection+table exactly like
  // DataGrid used to scope it internally — lifted up here since GridToolbar's
  // Columns popover needs to read and write the same state the grid renders
  // from. Same render-time key-swap as DataGrid had: an effect would let one
  // render paint the previous table's layout before catching up.
  const layoutKey = `${activeConnectionId}:${table}`;
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

  // Mirrors `editing` for effects/cleanups that must not themselves depend on
  // `editing` (a table-switch effect keyed on `editing` would refire the
  // fetch on every keystroke of a draft). Kept in sync after every render.
  const editingRef = useRef<CellEdit | null>(null);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // Bumped every time an edit is abandoned (table/connection switch, sort,
  // paging, a different cell, cancel, or unmount). previewEdit/commitEdit/
  // rollbackEdit each capture the current value before their `await` and
  // compare it after: a mismatch means whatever they were acting on is gone
  // by the time the response lands, so they must not touch component state —
  // this is the same shape as `requestIdRef` above, applied to the mutation
  // path instead of the read path. Without it, a request that outlives the
  // edit it belongs to can resurrect a preview UI on a different table,
  // report a successful write as failed, or stomp a freshly-fetched grid
  // with stale rows from the edit it started on.
  const editGenerationRef = useRef(0);

  // An open preview holds a real transaction (and its row lock) on the
  // user's database. Firing this whenever a preview is abandoned — by table
  // switch, sort, paging, editing a different cell, cancelling, or unmount —
  // is what keeps that lock from leaking for up to the sweep's full
  // 2-minute window. Swallowing the result: if the sweep already reclaimed
  // it, this call fails with "no open preview", which is not a real problem
  // — the outcome (transaction gone) is identical either way.
  function abandonEdit(current: CellEdit | null) {
    editGenerationRef.current++;
    // If a commit or rollback is already in flight for this preview
    // (`pending`), it already owns deciding that preview's fate — firing a
    // second, redundant rollback here would just race it for no benefit.
    if (current?.phase === "preview" && !current.pending) {
      void invokeRollbackPreview(current.previewId).catch(() => {});
    }
  }

  async function fetchRows(
    t: string,
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
    // table's rows land, and any open preview is a transaction against
    // whatever connection/table it was opened on.
    abandonEdit(editingRef.current);
    setEditing(null);
    setEditError(null);
    setSort([]);
    setPage(0);
    setFilter([]);
    setLimit(100);
    limitRef.current = 100;
    setTotal(0);
    setTableRows(null);
    setLastKnownColumns([]);
    setError(null);
    if (table && activeConnectionId) {
      void fetchRows(table, activeConnectionId, [], [], 0, 100);
    } else {
      requestIdRef.current++;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, activeConnectionId]);

  // Rolls back any preview left open when the tab itself goes away (closed,
  // or its pane repurposed) — the table/connection-switch effect above only
  // covers switches within a mounted DbTab, not unmounting it outright. If a
  // preview/commit *request* is still in flight (no materialized preview to
  // roll back yet, or a commit already claimed it), bumping the generation
  // here is what makes that request's own continuation self-correct when it
  // eventually lands — `setEditing` after unmount would be a no-op, so this
  // is the only recovery path for that case.
  useEffect(() => {
    return () => abandonEdit(editingRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any query-shape change (sort, filter, page, limit, refresh) abandons an
  // in-progress edit the same way a table switch does: the rows it targeted
  // are about to be replaced, and an open preview is a transaction that must
  // not leak.
  function abandonEditForQueryChange() {
    abandonEdit(editing);
    setEditing(null);
    setEditError(null);
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
    // A cell mid-request for its own preview/commit/rollback can't be
    // abandoned by clicking elsewhere — every other cell renders disabled
    // while anything is pending (see `renderCell`), so this is a defensive
    // backstop, not the primary guard.
    if (editing?.pending) return;
    abandonEdit(editing);
    setEditError(null);
    setEditing({ rowIndex, columnIndex, phase: "editing", draft: currentValue, pending: false });
  }

  async function previewEdit() {
    if (!editing || editing.phase !== "editing" || editing.pending || !tableRows?.pk_column || !activeConnectionId || !table) return;
    const pkIndex = tableRows.columns.indexOf(tableRows.pk_column);
    const pkValue = tableRows.rows[editing.rowIndex][pkIndex];
    if (pkValue === null) {
      setEditError("Can't edit this row — its primary key value is NULL.");
      return;
    }
    // Captured before the `await`: `generation` is compared against
    // `editGenerationRef.current` when the request lands to tell whether
    // this edit is still the one the user is looking at (see
    // `editGenerationRef`'s comment). `target` is this edit's own identity,
    // independent of whatever `editing` holds by the time we get a reply.
    const generation = editGenerationRef.current;
    const target = editing;
    const column = tableRows.columns[target.columnIndex];
    setEditing({ ...target, pending: true });
    try {
      const preview = await invokePreviewCellEdit(activeConnectionId, table, tableRows.pk_column, pkValue, column, target.draft);
      if (generation !== editGenerationRef.current) {
        // Whatever this edit belonged to (this cell, this table, this
        // mounted tab) is gone — table switch, cancel, or unmount happened
        // while the request was in flight. We now hold a live transaction
        // nobody's watching; roll it back immediately rather than leaking
        // it for the sweep's ~2-minute window.
        void invokeRollbackPreview(preview.preview_id).catch(() => {});
        return;
      }
      setEditError(null);
      setEditing({ ...target, phase: "preview", previewId: preview.preview_id, pending: false });
    } catch (err) {
      // Nobody's watching this outcome anymore — don't resurrect edit UI for
      // a cell (or table) the user has already left.
      if (generation !== editGenerationRef.current) return;
      // The row this edit targeted no longer matches 1-for-1 (e.g. deleted
      // or changed by something else since the page loaded) or the preview
      // never opened at all — nothing was written either way. Drop back to
      // "editing" rather than clearing the draft, so a genuinely transient
      // failure doesn't cost the user their typed value.
      setEditError(err instanceof Error ? err.message : String(err));
      setEditing({ ...target, pending: false });
    }
  }

  async function commitEdit() {
    if (!editing || editing.phase !== "preview" || editing.pending || !tableRows) return;
    const generation = editGenerationRef.current;
    const target = editing;
    setEditing({ ...target, pending: true });
    try {
      await invokeCommitPreview(target.previewId);
    } catch (err) {
      if (generation !== editGenerationRef.current) return; // see success branch below
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
      setEditing({ rowIndex: target.rowIndex, columnIndex: target.columnIndex, phase: "editing", draft: target.draft, pending: false });
      return;
    }
    if (generation !== editGenerationRef.current) {
      // The write committed for real — that part already happened and
      // can't be (and doesn't need to be) undone. But `tableRows` in this
      // closure is a snapshot from whatever table this edit started on; if
      // the user has since switched tables, applying it here would stomp
      // the *new* table's freshly-fetched rows with the old table's stale
      // snapshot. Nothing further to reconcile locally — the next time this
      // table is opened, a fresh fetch shows the committed value for real.
      return;
    }
    const { rowIndex, columnIndex, draft } = target;
    setTableRows({
      ...tableRows,
      rows: tableRows.rows.map((row, ri) => (ri === rowIndex ? row.map((v, ci) => (ci === columnIndex ? draft : v)) : row)),
    });
    setEditing(null);
    setEditError(null);
  }

  async function rollbackEdit() {
    if (!editing || editing.phase !== "preview" || editing.pending) {
      setEditing(null);
      return;
    }
    const generation = editGenerationRef.current;
    const previewId = editing.previewId;
    setEditing({ ...editing, pending: true });
    try {
      await invokeRollbackPreview(previewId);
    } catch (err) {
      // Only worth surfacing if this is still the edit in view — an
      // already-resolved preview (the sweep beat the user to it) isn't a
      // real failure either way, and one that landed after the user moved
      // on isn't something to report against whatever they're looking at now.
      if (generation === editGenerationRef.current) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isExpiredPreviewError(message)) setEditError(message);
      }
    }
    setEditing(null);
  }

  // Icon buttons here are neutral (`text-text-faint`), matching AppStrip's
  // icon-button convention — DESIGN.md reserves semantic color for actual
  // state, and a confirm/cancel affordance is generic interactivity, not
  // state. The diff's red-strikethrough/green-new-value text below is the
  // legitimate use of semantic color: it reports a real fact (old vs. new).
  // (Deviates from the mockup, which fills these `.save`/`.cancel` buttons
  // with success-bg/neutral-bg — same documented tradeoff as SchemaTree's
  // watch-icon and the console toggle's aria-pressed highlighting.) Sizing
  // (20x20, 4px radius) still follows the mockup's `.cell-edit button`.
  const actionButtonClass =
    "grid h-5 w-5 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-2 hover:text-text disabled:opacity-40";
  // Accept carries the mockup's success hue (`.cell-edit .save`); cancel stays
  // neutral. The green is doing real work here rather than decorating a generic
  // button — it is the same success/danger pairing as the diff text beside it,
  // marking which control commits the change the user is looking at.
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
    const isEditingThisCell = editing !== null && editing.rowIndex === rowIndex && editing.columnIndex === columnIndex;

    if (isEditingThisCell && editing.phase === "preview") {
      const { text: oldText } = cellDisplay(value);
      return (
        <div className={expandedEditorClass}>
          <span className="text-danger line-through">{oldText}</span>
          <span aria-hidden className="text-text-faint">
            →
          </span>
          {editing.draft === null ? (
            <span className="italic text-success">NULL</span>
          ) : (
            <span className="font-semibold text-success">{editing.draft}</span>
          )}
          {/* Both buttons lock once a commit/rollback request is in flight —
              once that round trip is actually running, there's no honest
              "cancel" to offer; the outcome is already decided server-side. */}
          <button
            type="button"
            aria-label="Rollback edit"
            disabled={editing.pending}
            onClick={() => void rollbackEdit()}
            className={actionButtonClass}
          >
            <CrossIcon />
          </button>
          <button
            type="button"
            aria-label="Commit edit"
            disabled={editing.pending}
            onClick={() => void commitEdit()}
            className={acceptButtonClass}
          >
            <CheckIcon />
          </button>
        </div>
      );
    }

    if (isEditingThisCell) {
      return (
        <div className={expandedEditorClass}>
          <input
            autoFocus
            // Named for the column it edits: without this the editor is an
            // anonymous textbox, indistinguishable to a screen reader (and to
            // a test) from the grid's filter box.
            aria-label={`Edit ${column}`}
            disabled={editing.pending}
            // Sized in characters from the draft itself — the point of the
            // expansion is to show the whole value, and a mono face makes `ch`
            // exact. Bounded so one enormous cell can't span the whole grid.
            size={Math.min(Math.max((editing.draft ?? "").length + 1, 12), 60)}
            value={editing.draft ?? ""}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            className="min-w-0 rounded border border-accent bg-bg px-1.5 py-0.75 text-xs text-text disabled:opacity-50"
          />
          <button
            type="button"
            aria-label="Preview change"
            disabled={editing.pending}
            onClick={() => void previewEdit()}
            className={acceptButtonClass}
          >
            <CheckIcon />
          </button>
          {/* Deliberately never disabled, even while a preview request for
              this exact draft is in flight: the request already left and
              can't be pulled back, but its eventual response is made to
              check in (via editGenerationRef) and roll itself back rather
              than resurrect a preview the user already walked away from. */}
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={() => {
              abandonEdit(editing);
              setEditing(null);
            }}
            className={actionButtonClass}
          >
            <CrossIcon />
          </button>
        </div>
      );
    }

    // Disabled while any cell's edit is mid-request, not just this one — one
    // edit in flight at a time keeps two concurrent commits from racing to
    // apply their own stale `tableRows` snapshot over each other.
    const anyEditPending = editing !== null && editing.pending;
    // The mockup exempts the identity column from the numeric right-align
    // (`col !== 'id'`), read here as the general rule it stands for: a primary
    // key is a label that happens to be digits, not a quantity to compare down
    // a column. Query results keep the plain numeric rule — they declare no key.
    const { className, kind } = cellDisplay(value);
    const alignClass = kind === "number" && column === tableRows?.pk_column ? "" : className;
    return (
      <button
        type="button"
        disabled={!editable || anyEditPending}
        onClick={() => editable && startEdit(rowIndex, columnIndex, value)}
        className={`group flex w-full min-w-0 items-center gap-1 text-left ${editable ? "hover:cursor-text hover:bg-surface-2" : ""}`}
      >
        <span className={`min-w-0 flex-1 truncate ${alignClass}`}>
          <CellValue value={value} />
        </span>
        {/* Decorative hover affordance (mirrors the mockup's `::after`
            pencil) — a real DOM node marked `aria-hidden` rather than CSS
            generated content, so it can never bleed into the button's
            accessible name the way `::after` text sometimes does. */}
        {editable ? (
          <span aria-hidden className="hidden shrink-0 text-[10.5px] text-text-faint group-hover:inline">
            ✎
          </span>
        ) : null}
      </button>
    );
  }

  // Samples the first NON-NULL value in the column across the fetched page,
  // not just row 0 — a NULL there would report the column as text and offer
  // "contains"/"starts with" where "is true"/"is false" belong. Still a
  // heuristic; Slice 2 replaces the whole thing with describe_columns' real
  // type metadata.
  function familyOfColumn(column: string): ColumnFamily {
    const index = tableRows?.columns.indexOf(column) ?? -1;
    if (index < 0) return "text";
    const sample = (tableRows?.rows ?? []).map((row) => row[index]).find((v) => v !== null);
    return inferFamily(sample ?? null);
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
    // min-w-0 here too: this root is itself a row's main-axis flex child
    // (SplitContent's per-tab wrapper), so without it the same shrink-refusal
    // just recurs one level higher than the content column below.
    <div className="flex h-full w-full min-h-0 min-w-0">
      <SchemaTree
        connectionId={activeConnectionId}
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
            <span className="text-xs font-semibold text-text-muted">{table ?? "No table selected"}</span>
            <button
              type="button"
              aria-label="Query console"
              aria-pressed={consoleOpen}
              onClick={() => setConsoleOpen((open) => !open)}
              className="ml-auto flex h-7.5 shrink-0 items-center gap-1.5 rounded-sm px-2.25 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text aria-pressed:bg-surface-2 aria-pressed:text-text"
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
                          limitRef.current = next;
                          setLimit(next);
                          setPage(0);
                          void fetchRows(table!, activeConnectionId!, filter, sort, 0, next);
                        }}
                        onRefresh={() => {
                          abandonEditForQueryChange();
                          void fetchRows(table!, activeConnectionId!, filter, sort, page, limitRef.current);
                        }}
                        familyOf={familyOfColumn}
                      />
                    }
                  />
                  {!tableRows.pk_column ? (
                    <div className="mt-2.5 text-xs text-text-faint">
                      No single-column primary key on <span className="font-semibold text-text-muted">{table}</span> — cells
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
