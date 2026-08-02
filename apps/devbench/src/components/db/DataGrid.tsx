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
import {
  ACTIONS_COLUMN_PX,
  EMPTY_LAYOUT,
  MIN_COLUMN_PX,
  MIN_RESIZED_COLUMN_PX,
  ROW_HEIGHT_PX,
  pinOffsets,
  visualColumns,
  widthOf,
  type GridLayout,
} from "./grid/gridLayout";

/** One `ORDER BY` term. A list of these is what lets a sort tie-break. */
export interface SortTerm {
  column: string;
  descending: boolean;
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
  /** Overrides how a cell renders — the inline-editing UI plugs in here.
   *  `columnIndex` is always the DATA index, never the on-screen position, so
   *  reordering columns can never redirect an edit to the wrong column. */
  renderCell?: (rowIndex: number, columnIndex: number, value: string | null) => ReactNode;
  /** Column widths/order/pins/hidden — owned by the caller (not DataGrid)
   *  since GridToolbar's Columns popover reads and writes the same state. */
  layout?: GridLayout;
  onLayoutChange?: (layout: GridLayout) => void;
  /** Rendered above the scrollable grid, inside the table wrapper — DbTab
   *  plugs GridToolbar in here. */
  toolbar?: ReactNode;
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

export function CellValue({ value }: { value: string | null }) {
  const { text, kind } = cellDisplay(value);
  if (kind === "bool-true" || kind === "bool-false") {
    return (
      <input
        type="checkbox"
        readOnly
        disabled
        checked={kind === "bool-true"}
        aria-label={text}
        // Drawn rather than native: a UA checkbox is ~16px and platform
        // coloured, which reads as a form control dropped into a dense row.
        className="mx-auto block size-3.5 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent disabled:opacity-100"
      />
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
  renderCell,
  layout = EMPTY_LAYOUT,
  onLayoutChange,
  toolbar,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  // Live width during an in-progress resize drag, overlaid on `layout` for
  // display only — onLayoutChange (which the caller may persist) fires once
  // on release, not on every mousemove.
  const [liveWidth, setLiveWidth] = useState<{ column: string; width: number } | null>(null);
  const effectiveLayout = liveWidth
    ? { ...layout, widths: { ...layout.widths, [liveWidth.column]: liveWidth.width } }
    : layout;

  function updateLayout(next: GridLayout) {
    onLayoutChange?.(next);
  }

  const isPinned = (column: string) => effectiveLayout.pinned.includes(column);

  // On-screen order: the saved order, minus columns this table no longer has,
  // plus any it gained — then pinned columns hoisted to the front so "pinned"
  // and "leftmost" can't disagree.
  const visual = useMemo(() => visualColumns(columns, effectiveLayout), [columns, effectiveLayout]);

  // Undragged, unpinned columns stay flexible (`minmax(…, 1fr)`, matching the
  // mockup's auto-sizing `<table>`). Pinning forces a fixed width because a
  // sticky offset has to be a number we can compute before layout runs.
  const gridTemplateColumns = useMemo(
    () =>
      visual
        .map((col) =>
          effectiveLayout.widths[col] || effectiveLayout.pinned.includes(col)
            ? `${effectiveLayout.widths[col] ?? MIN_COLUMN_PX}px`
            : `minmax(${MIN_COLUMN_PX}px, 1fr)`,
        )
        .join(" ") + ` ${ACTIONS_COLUMN_PX}px`,
    [visual, effectiveLayout],
  );

  // Left offset for each pinned column, accumulated across the pinned run.
  const offsets = useMemo(() => pinOffsets(visual, effectiveLayout), [visual, effectiveLayout]);

  // Floor for the header+body wrapper below. Without it, a block-level `auto`
  // width can't grow past its containing block even when the grid's own
  // column minimums need more room — the grid silently overflows its box
  // instead of the box (and its scrollbar) growing to fit. This is what let
  // the header and body compute different widths and drift apart on scroll.
  const minTableWidth = visual.reduce((sum, col) => sum + widthOf(col, effectiveLayout), 0) + ACTIONS_COLUMN_PX;

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
        setLiveWidth({ column, width: latest });
      }
      // Saved once on release rather than on every mousemove: a drag is one
      // decision, and writing storage per frame would be dozens of writes for it.
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setLiveWidth(null);
        updateLayout({ ...layout, widths: { ...layout.widths, [column]: latest } });
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  function togglePinned(column: string) {
    const pinned = isPinned(column)
      ? effectiveLayout.pinned.filter((c) => c !== column)
      : [...effectiveLayout.pinned, column];
    updateLayout({
      ...effectiveLayout,
      pinned,
      order: visual,
      // Pinning fixes the width, so capture whatever it currently is rather
      // than snapping the column to the default on pin.
      widths: pinned.includes(column) && !effectiveLayout.widths[column]
        ? { ...effectiveLayout.widths, [column]: measuredWidth(column) }
        : effectiveLayout.widths,
    });
  }

  function measuredWidth(column: string): number {
    const el = scrollRef.current?.querySelector(`[data-column="${CSS.escape(column)}"]`);
    const width = el instanceof HTMLElement ? Math.round(el.getBoundingClientRect().width) : 0;
    return width > 0 ? width : MIN_COLUMN_PX;
  }

  function moveColumn(column: string, targetColumn: string) {
    if (column === targetColumn) return;
    const from = visual.indexOf(column);
    const to = visual.indexOf(targetColumn);
    if (from < 0 || to < 0) return;
    const next = visual.filter((c) => c !== column);
    // Removing the column first shifts everything after it left by one, so a
    // rightward move has to land AFTER the target to actually go anywhere —
    // inserting at the target's new index would put it back where it started.
    const anchor = next.indexOf(targetColumn);
    next.splice(from < to ? anchor + 1 : anchor, 0, column);
    updateLayout({ ...effectiveLayout, order: next });
  }

  /** Keyboard equivalent of the header drag — dragging alone would make
   *  reordering mouse-only. */
  function nudgeColumn(column: string, delta: number) {
    const from = visual.indexOf(column);
    const to = from + delta;
    if (to < 0 || to >= visual.length) return;
    moveColumn(column, visual[to]);
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
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });

  async function copyRow(row: (string | null)[], format: "tsv" | "json") {
    // Copied in the order the user is looking at, not storage order.
    const ordered = visual.map((col) => row[columns.indexOf(col)] ?? null);
    const text = format === "tsv" ? rowAsTsv(ordered) : rowAsJson(visual, ordered);
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : String(err));
    }
  }

  const layoutIsCustomised =
    effectiveLayout.order.length > 0 ||
    effectiveLayout.pinned.length > 0 ||
    Object.keys(effectiveLayout.widths).length > 0;

  return (
    // No overflow-hidden here: GridToolbar's popovers are `position: absolute`
    // against this ancestor's stacking context, and an overflow-hidden
    // ancestor clips an absolutely-positioned descendant regardless of
    // z-index. The clip that actually needs to happen (rounding the
    // scrolling grid's corners) lives on the narrower wrapper below instead.
    <div className="rounded-lg border border-border" role="table" aria-rowcount={rows.length}>
      {toolbar}
      {layoutIsCustomised ? (
        <div className="flex items-center justify-end border-b border-border bg-surface px-3 py-1.5">
          <button
            type="button"
            onClick={() => updateLayout(EMPTY_LAYOUT)}
            className="shrink-0 rounded-sm px-2 py-0.5 text-xs text-text-faint hover:bg-surface-2 hover:text-text"
          >
            Reset layout
          </button>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-b-lg">
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
              {visual.map((col) => {
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
                    style={pinned ? { position: "sticky", left: offsets[col], zIndex: 2 } : undefined}
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

            {rows.length === 0 ? (
              <div className="p-4 text-sm text-text-faint">No rows.</div>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const dataRowIndex = virtualRow.index;
                  const row = rows[dataRowIndex];
                  return (
                    <div
                      key={dataRowIndex}
                      role="row"
                      className={`group/row font-mono text-xs hover:bg-surface-2 ${
                        virtualRow.index === rows.length - 1 ? "" : "border-b border-border"
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
                      {visual.map((col) => {
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
                          ? { position: "sticky" as const, left: offsets[col], zIndex: 10 }
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
      </div>
    </div>
  );
}
