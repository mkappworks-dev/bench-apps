import {
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const ROW_HEIGHT_PX = 33;
/** Width an undragged column is guaranteed at least — the readable default. */
const MIN_COLUMN_PX = 140;
/** Floor for a column the user has actually dragged. Deliberately far below
 *  MIN_COLUMN_PX: sharing one constant meant the default width was also the
 *  smallest achievable one, so a drag could only ever widen a column. Still
 *  non-zero, so a column can't be collapsed to an unrecoverable sliver. */
const MIN_RESIZED_COLUMN_PX = 56;
const ACTIONS_COLUMN_PX = 90;
const LAYOUT_STORAGE_PREFIX = "devbench.grid-layout.";

/** One `ORDER BY` term. A list of these is what lets a sort tie-break. */
export interface SortTerm {
  column: string;
  descending: boolean;
}

/** Per-table view preferences. Deliberately only ever holds column *names*,
 *  never indices — a table whose shape changed underneath a stored layout
 *  then degrades to "that column is gone" rather than to a silent mis-mapping. */
interface GridLayout {
  widths: Record<string, number>;
  order: string[];
  pinned: string[];
}

const EMPTY_LAYOUT: GridLayout = { widths: {}, order: [], pinned: [] };

function readLayout(key: string | undefined): GridLayout {
  if (!key) return EMPTY_LAYOUT;
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_PREFIX + key);
    if (!raw) return EMPTY_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_LAYOUT;
    const { widths, order, pinned } = parsed as Partial<GridLayout>;
    return {
      widths: typeof widths === "object" && widths !== null ? widths : {},
      order: Array.isArray(order) ? order.filter((c): c is string => typeof c === "string") : [],
      pinned: Array.isArray(pinned) ? pinned.filter((c): c is string => typeof c === "string") : [],
    };
  } catch {
    // Unreadable or corrupt storage means "no saved layout", never a broken
    // grid — this runs on every table switch.
    return EMPTY_LAYOUT;
  }
}

function writeLayout(key: string | undefined, layout: GridLayout): void {
  if (!key) return;
  try {
    localStorage.setItem(LAYOUT_STORAGE_PREFIX + key, JSON.stringify(layout));
  } catch {
    // A full or disabled store must not take the grid down with it; the
    // layout simply stops surviving reloads.
  }
}

export interface DataGridProps {
  /** Column names in DATA order — the order row arrays are indexed by. What
   *  the user sees is derived from this plus their saved order/pins. */
  columns: string[];
  rows: (string | null)[][];
  /** Active sort terms, outermost first. */
  sort?: SortTerm[];
  /** `additive` is true for shift-click: append/adjust rather than replace. */
  onSort?: (column: string, additive: boolean) => void;
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
  onPrevPage?: () => void;
  onNextPage?: () => void;
  /** Overrides how a cell renders — the inline-editing UI plugs in here.
   *  `columnIndex` is always the DATA index, never the on-screen position, so
   *  reordering columns can never redirect an edit to the wrong column. */
  renderCell?: (rowIndex: number, columnIndex: number, value: string | null) => ReactNode;
  /** Identity the saved column layout is stored under (e.g. connection+table).
   *  Omit to opt out of persistence entirely. */
  layoutKey?: string;
}

export type CellKind = "null" | "unsupported" | "number" | "bool-true" | "bool-false" | "text";

// The wire format has no column-type metadata, so "is this boolean" is the
// same best-effort inference already used for numbers below (a text column
// literally containing "true"/"false" would also get the pill) — an
// accepted tradeoff for a value that's already a string by the time it
// reaches the grid.
export function cellDisplay(value: string | null): { text: string; className: string; kind: CellKind } {
  if (value === null) return { text: "NULL", className: "italic text-text-faint", kind: "null" };
  if (value === "<unsupported type>") return { text: value, className: "italic text-warning", kind: "unsupported" };
  if (value === "true" || value === "false") {
    return { text: value, className: "", kind: value === "true" ? "bool-true" : "bool-false" };
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return { text: value, className: "text-right tabular-nums", kind: "number" };
  return { text: value, className: "", kind: "text" };
}

// Renders a boolean as the mockup's pill (filled success for true, outlined
// neutral for false) instead of plain text; everything else is just text.
export function CellValue({ value }: { value: string | null }) {
  const { text, kind } = cellDisplay(value);
  if (kind === "bool-true" || kind === "bool-false") {
    return (
      <span
        // `leading-normal` (1.5) rather than the inherited row leading: the
        // pill's own line box is what sets its height, and 1.5 is what makes
        // it the mockup's measured 17.75px instead of 16px.
        className={`inline-flex rounded-full px-1.75 py-px text-[10.5px] font-bold leading-normal ${
          kind === "bool-true" ? "bg-success-bg text-success" : "border border-border bg-surface text-text-faint"
        }`}
      >
        {text}
      </span>
    );
  }
  return <>{text}</>;
}

function SortChevron({ active, descending, column }: { active: boolean; descending: boolean; column: string }) {
  return (
    <svg
      aria-hidden
      data-testid={`sort-chevron-${column}`}
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-text-faint transition-transform duration-150 ${
        active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      } ${active && descending ? "rotate-180" : ""}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill={pinned ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 3h6l-1 6 3 3H7l3-3-1-6z" />
      <path d="M12 12v9" />
    </svg>
  );
}

function rowAsTsv(row: (string | null)[]): string {
  return row.map((v) => v ?? "").join("\t");
}

function rowAsJson(columns: string[], row: (string | null)[]): string {
  const obj: Record<string, string | null> = {};
  columns.forEach((col, i) => {
    obj[col] = row[i] ?? null;
  });
  return JSON.stringify(obj);
}

export function DataGrid({
  columns,
  rows,
  sort = [],
  onSort,
  hasNextPage = false,
  hasPrevPage = false,
  onPrevPage,
  onNextPage,
  renderCell,
  layoutKey,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [dragColumn, setDragColumn] = useState<string | null>(null);

  // Layout is keyed by table, so switching tables must swap it during render
  // rather than in an effect — an effect would let one render paint the
  // previous table's widths, and would race the save below into the new key.
  const [stored, setStored] = useState(() => ({ key: layoutKey, layout: readLayout(layoutKey) }));
  if (stored.key !== layoutKey) {
    setStored({ key: layoutKey, layout: readLayout(layoutKey) });
    setFilter("");
  }
  const layout = stored.layout;

  function updateLayout(next: GridLayout) {
    setStored({ key: layoutKey, layout: next });
    writeLayout(layoutKey, next);
  }

  const isPinned = (column: string) => layout.pinned.includes(column);
  const widthOf = (column: string) => layout.widths[column] ?? MIN_COLUMN_PX;

  // On-screen order: the saved order, minus columns this table no longer has,
  // plus any it gained — then pinned columns hoisted to the front so "pinned"
  // and "leftmost" can't disagree.
  const visualColumns = useMemo(() => {
    const known = layout.order.filter((c) => columns.includes(c));
    const ordered = [...known, ...columns.filter((c) => !known.includes(c))];
    return [
      ...ordered.filter((c) => layout.pinned.includes(c)),
      ...ordered.filter((c) => !layout.pinned.includes(c)),
    ];
  }, [columns, layout]);

  // Undragged, unpinned columns stay flexible (`minmax(…, 1fr)`, matching the
  // mockup's auto-sizing `<table>`). Pinning forces a fixed width because a
  // sticky offset has to be a number we can compute before layout runs.
  const gridTemplateColumns = useMemo(
    () =>
      visualColumns
        .map((col) =>
          layout.widths[col] || layout.pinned.includes(col)
            ? `${layout.widths[col] ?? MIN_COLUMN_PX}px`
            : `minmax(${MIN_COLUMN_PX}px, 1fr)`,
        )
        .join(" ") + ` ${ACTIONS_COLUMN_PX}px`,
    [visualColumns, layout],
  );

  // Left offset for each pinned column, accumulated across the pinned run.
  const pinOffsets = useMemo(() => {
    const offsets: Record<string, number> = {};
    let accumulated = 0;
    for (const col of visualColumns) {
      if (!layout.pinned.includes(col)) break;
      offsets[col] = accumulated;
      accumulated += layout.widths[col] ?? MIN_COLUMN_PX;
    }
    return offsets;
  }, [visualColumns, layout]);

  // Floor for the header+body wrapper below. Without it, a block-level `auto`
  // width can't grow past its containing block even when the grid's own
  // column minimums need more room — the grid silently overflows its box
  // instead of the box (and its scrollbar) growing to fit. This is what let
  // the header and body compute different widths and drift apart on scroll.
  const minTableWidth = visualColumns.reduce((sum, col) => sum + widthOf(col), 0) + ACTIONS_COLUMN_PX;

  // Filtering is over the fetched page only, so a row keeps its original
  // index — that index is what `renderCell` resolves an edit against, and a
  // filtered position would point the write at a different row.
  const visibleRows = useMemo(() => {
    const indexed = rows.map((row, index) => ({ row, index }));
    const needle = filter.trim().toLowerCase();
    if (!needle) return indexed;
    return indexed.filter(({ row }) =>
      row.some((value) => cellDisplay(value).text.toLowerCase().includes(needle)),
    );
  }, [rows, filter]);

  const sortIndexOf = (column: string) => sort.findIndex((term) => term.column === column);

  // Drag state lives outside React state — only the resulting width needs a
  // re-render, not every mousemove. Mirrors QueryConsole/ChatDock's own
  // resize-drag wiring (window-level listeners added on mousedown, torn down
  // on mouseup) rather than introducing a new pattern.
  function beginColumnResize(column: string) {
    return (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const headerCell = (e.currentTarget as HTMLElement).closest('[role="columnheader"]');
      if (!(headerCell instanceof HTMLElement)) return;
      const startWidth = headerCell.getBoundingClientRect().width;
      const startX = e.clientX;
      let latest = startWidth;
      function onMove(ev: MouseEvent) {
        latest = Math.max(MIN_RESIZED_COLUMN_PX, Math.round(startWidth + (ev.clientX - startX)));
        setStored((prev) => ({ ...prev, layout: { ...prev.layout, widths: { ...prev.layout.widths, [column]: latest } } }));
      }
      // Saved once on release rather than on every mousemove: a drag is one
      // decision, and writing storage per frame would be dozens of writes for it.
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setStored((prev) => {
          const next = { ...prev.layout, widths: { ...prev.layout.widths, [column]: latest } };
          writeLayout(layoutKey, next);
          return { ...prev, layout: next };
        });
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  function togglePinned(column: string) {
    const pinned = isPinned(column)
      ? layout.pinned.filter((c) => c !== column)
      : [...layout.pinned, column];
    updateLayout({
      ...layout,
      pinned,
      order: visualColumns,
      // Pinning fixes the width, so capture whatever it currently is rather
      // than snapping the column to the default on pin.
      widths: pinned.includes(column) && !layout.widths[column]
        ? { ...layout.widths, [column]: measuredWidth(column) }
        : layout.widths,
    });
  }

  function measuredWidth(column: string): number {
    const el = scrollRef.current?.querySelector(`[data-column="${CSS.escape(column)}"]`);
    const width = el instanceof HTMLElement ? Math.round(el.getBoundingClientRect().width) : 0;
    return width > 0 ? width : MIN_COLUMN_PX;
  }

  function moveColumn(column: string, targetColumn: string) {
    if (column === targetColumn) return;
    const from = visualColumns.indexOf(column);
    const to = visualColumns.indexOf(targetColumn);
    if (from < 0 || to < 0) return;
    const next = visualColumns.filter((c) => c !== column);
    // Removing the column first shifts everything after it left by one, so a
    // rightward move has to land AFTER the target to actually go anywhere —
    // inserting at the target's new index would put it back where it started.
    const anchor = next.indexOf(targetColumn);
    next.splice(from < to ? anchor + 1 : anchor, 0, column);
    updateLayout({ ...layout, order: next });
  }

  /** Keyboard equivalent of the header drag — dragging alone would make
   *  reordering mouse-only. */
  function nudgeColumn(column: string, delta: number) {
    const from = visualColumns.indexOf(column);
    const to = from + delta;
    if (to < 0 || to >= visualColumns.length) return;
    moveColumn(column, visualColumns[to]);
  }

  function onHeaderKeyDown(column: string) {
    return (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!e.altKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nudgeColumn(column, -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nudgeColumn(column, 1);
      }
    };
  }

  function onHeaderDrop(target: string) {
    return (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const source = e.dataTransfer.getData("text/x-devbench-column") || dragColumn;
      if (source) moveColumn(source, target);
      setDragColumn(null);
    };
  }

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });

  async function copyRow(row: (string | null)[], format: "tsv" | "json") {
    // Copied in the order the user is looking at, not storage order.
    const ordered = visualColumns.map((col) => row[columns.indexOf(col)] ?? null);
    const text = format === "tsv" ? rowAsTsv(ordered) : rowAsJson(visualColumns, ordered);
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : String(err));
    }
  }

  const layoutIsCustomised =
    layout.order.length > 0 || layout.pinned.length > 0 || Object.keys(layout.widths).length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border" role="table" aria-rowcount={rows.length}>
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter rows on this page"
          placeholder="Filter this page…"
          className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 font-mono text-xs text-text placeholder:text-text-faint focus-visible:border-text-faint"
        />
        {filter.trim() ? (
          <span className="shrink-0 text-xs text-text-faint">
            {visibleRows.length} of {rows.length}
          </span>
        ) : null}
        {layoutIsCustomised ? (
          <button
            type="button"
            onClick={() => updateLayout(EMPTY_LAYOUT)}
            className="shrink-0 rounded-sm px-2 py-0.5 text-xs text-text-faint hover:bg-surface-2 hover:text-text"
          >
            Reset layout
          </button>
        ) : null}
      </div>
      {/* Header and body share this one scrollable box (both axes) so a
          horizontal scroll moves them together — a table/tbody or a
          sibling header re-flows column widths independently the moment
          rows are absolutely positioned for virtualization, which is what
          let the header drift out of alignment with scrolled row content. */}
      <div ref={scrollRef} className="max-h-125 overflow-auto">
        <div style={{ minWidth: minTableWidth }}>
          <div
            style={{ display: "grid", gridTemplateColumns }}
            // z-30 keeps the header above an expanded inline editor (z-20),
            // which overflows its own cell and would otherwise ride over the
            // header when its row is scrolled up under it.
            className="sticky top-0 z-30 border-b border-border bg-surface-2 font-mono"
            role="row"
          >
            {visualColumns.map((col) => {
              const sortIndex = sortIndexOf(col);
              const active = sortIndex >= 0;
              const pinned = isPinned(col);
              return (
                <div
                  key={col}
                  role="columnheader"
                  data-column={col}
                  aria-sort={active ? (sort[sortIndex].descending ? "descending" : "ascending") : undefined}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onHeaderDrop(col)}
                  style={pinned ? { position: "sticky", left: pinOffsets[col], zIndex: 2 } : undefined}
                  // `group` belongs on the cell, not the sort button: the pin
                  // button is the button's SIBLING, so a group scoped to the
                  // button would never reveal it on hover.
                  className={`group relative flex select-none items-center border-r border-border text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-faint ${
                    pinned ? "bg-surface-2" : ""
                  } ${dragColumn === col ? "opacity-50" : ""}`}
                >
                  {/* `uppercase` is repeated on the button on purpose: the UA
                      stylesheet sets `text-transform: none` on form controls,
                      and Tailwind's preflight only re-inherits font/letter-
                      spacing/color — so the parent's casing never reaches the
                      label and every header renders lowercase without this. */}
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/x-devbench-column", col);
                      e.dataTransfer.effectAllowed = "move";
                      setDragColumn(col);
                    }}
                    onDragEnd={() => setDragColumn(null)}
                    onClick={(e) => onSort?.(col, e.shiftKey)}
                    onKeyDown={onHeaderKeyDown(col)}
                    className="flex min-w-0 flex-1 items-center gap-1.25 py-1.75 pl-3 pr-1 text-left uppercase hover:text-text"
                    aria-label={`Sort by ${col}`}
                    title="Click to sort, shift-click to add a sort, drag or Alt+Arrow to reorder"
                  >
                    <span className="truncate">{col}</span>
                    <SortChevron active={active} descending={active && sort[sortIndex].descending} column={col} />
                    {sort.length > 1 && active ? (
                      <span aria-hidden className="shrink-0 tabular-nums text-text-faint">
                        {sortIndex + 1}
                      </span>
                    ) : null}
                  </button>
                  {/* `invisible` rather than opacity so an unrevealed pin
                      can't be clicked, while the header still reserves its
                      space and nothing shifts on hover. */}
                  <button
                    type="button"
                    onClick={() => togglePinned(col)}
                    aria-pressed={pinned}
                    aria-label={pinned ? `Unfreeze ${col}` : `Freeze ${col}`}
                    className={`mr-2.5 shrink-0 rounded-sm p-0.5 hover:text-text ${
                      pinned ? "text-text" : "invisible text-text-faint group-hover:visible group-focus-within:visible"
                    }`}
                  >
                    <PinIcon pinned={pinned} />
                  </button>
                  {/* Drag to resize — mirrors the mockup's `.th-resize`. A
                      sibling of the sort button (not nested inside it) so
                      dragging never fires a sort click. */}
                  <div
                    aria-hidden
                    data-testid={`resize-handle-${col}`}
                    onMouseDown={beginColumnResize(col)}
                    className="absolute inset-y-0 right-0 w-1.25 cursor-col-resize hover:bg-accent hover:opacity-50"
                  />
                </div>
              );
            })}
            <div role="columnheader" aria-label="Row actions" />
          </div>

          {visibleRows.length === 0 ? (
            <div className="p-4 text-sm text-text-faint">
              {rows.length === 0 ? "No rows." : `No rows on this page match “${filter.trim()}”.`}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const { row, index: dataRowIndex } = visibleRows[virtualRow.index];
                return (
                  <div
                    key={dataRowIndex}
                    role="row"
                    className={`group/row font-mono text-xs hover:bg-surface-2 ${
                      virtualRow.index === visibleRows.length - 1 ? "" : "border-b border-border"
                    }`}
                    style={{
                      display: "grid",
                      gridTemplateColumns,
                      // Pinned to the same constant the virtualizer measures
                      // with. Left to size itself, a row is only as tall as its
                      // content — a bordered boolean pill made some rows 33px
                      // and plain ones 31.5px while `virtualRow.start` advanced
                      // by a flat 33px, so rows drifted apart by 1.5px gaps.
                      // Cells stretch to this height and center their own
                      // content, so a taller pill can't reintroduce that
                      // variance and the column rules still span the full row.
                      height: ROW_HEIGHT_PX,
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {visualColumns.map((col) => {
                      // Always the DATA index: reordering changes where a
                      // column is drawn, never which value it holds or which
                      // column an edit resolves to.
                      const columnIndex = columns.indexOf(col);
                      const value = row[columnIndex] ?? null;
                      const pinned = isPinned(col);
                      // A pinned cell slides over its neighbours, so it needs
                      // its own opaque fill — including the row's hover fill,
                      // or hovering would reveal a hole where it sits.
                      const pinnedClass = pinned ? "bg-bg group-hover/row:bg-surface-2" : "";
                      const pinnedStyle = pinned
                        ? { position: "sticky" as const, left: pinOffsets[col], zIndex: 10 }
                        : undefined;
                      return renderCell ? (
                        // `relative` so an expanded inline editor can position
                        // itself against this cell and spill over the columns
                        // to its right instead of being squeezed into one.
                        <div
                          key={col}
                          role="cell"
                          style={pinnedStyle}
                          className={`relative flex min-w-0 items-center border-r border-border px-3 text-text-muted ${pinnedClass}`}
                        >
                          {renderCell(dataRowIndex, columnIndex, value)}
                        </div>
                      ) : (
                        <div
                          key={col}
                          role="cell"
                          style={pinnedStyle}
                          className={`flex min-w-0 items-center border-r border-border px-3 text-text-muted ${pinnedClass}`}
                        >
                          {/* The truncation lives on this span, not the cell:
                              text-overflow has no effect on a flex container's
                              own anonymous text child. */}
                          <span className={`min-w-0 flex-1 truncate ${cellDisplay(value).className}`}>
                            <CellValue value={value} />
                          </span>
                        </div>
                      );
                    })}
                    <div role="cell" className="flex items-center px-2">
                      <button
                        type="button"
                        aria-label="Copy row as tab-separated values"
                        onClick={() => void copyRow(row, "tsv")}
                        className="px-1 text-xs text-text-faint hover:text-text"
                      >
                        TSV
                      </button>
                      <button
                        type="button"
                        aria-label="Copy row as JSON"
                        onClick={() => void copyRow(row, "json")}
                        className="px-1 text-xs text-text-faint hover:text-text"
                      >
                        JSON
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {copyError ? (
        <div role="alert" className="border-t border-border bg-danger-bg px-3 py-1.5 text-xs text-danger">
          Couldn't copy row: {copyError}
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-border bg-surface px-3 py-2 text-xs text-text-faint">
        <span>
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={!hasPrevPage}
            onClick={onPrevPage}
            className="flex h-7.5 items-center rounded-sm px-2.25 hover:bg-surface-2 hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-faint"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={!hasNextPage}
            onClick={onNextPage}
            className="flex h-7.5 items-center rounded-sm px-2.25 hover:bg-surface-2 hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-faint"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
