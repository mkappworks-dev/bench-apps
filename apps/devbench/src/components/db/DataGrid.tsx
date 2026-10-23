import {
  useEffect,
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

export interface SortTerm {
  column: string;
  descending: boolean;
}

export interface DataGridProps {
  // Column names in DATA order — the order row arrays are indexed by, not the on-screen position. Cell/row callbacks below use this index.
  columns: string[];
  rows: (string | null)[][];
  getRowLabel?: (rowIndex: number) => string;
  sort?: SortTerm[];
  onSort?: (column: string, additive: boolean) => void;
  renderCell?: (rowIndex: number, columnIndex: number, value: string | null) => ReactNode;
  layout?: GridLayout;
  onLayoutChange?: (layout: GridLayout) => void;
  toolbar?: ReactNode;
  // Every virtualized row carries a `transform`, which creates a new stacking context — a z-index inside the row can't escape it.
  // Raising the ROW itself (not an overlay inside it) is what lets it paint over a later sibling row and under the z-30 sticky header.
  raisedRowIndex?: number | null;
  renderRowActions?: (rowIndex: number) => ReactNode;
}

export type CellKind = "null" | "unsupported" | "number" | "bool-true" | "bool-false" | "text";

// No column-type metadata on the wire, so "is this boolean" is a best-effort inference — a text column literally containing "true"/"false" also gets the pill.
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

function CopyIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="8" y="8" width="12" height="12" rx="1.5" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
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
  getRowLabel = (rowIndex) => String(rowIndex + 1),
  sort = [],
  onSort,
  renderCell,
  layout = EMPTY_LAYOUT,
  onLayoutChange,
  toolbar,
  raisedRowIndex = null,
  renderRowActions,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [copyMenuRow, setCopyMenuRow] = useState<number | null>(null);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);
  // copyMenuRow needs the same row-raising treatment as raisedRowIndex.
  const effectiveRaisedRow = copyMenuRow ?? raisedRowIndex;
  // Overlaid on `layout` for display only — onLayoutChange fires once on release, not on every mousemove.
  const [liveWidth, setLiveWidth] = useState<{ column: string; width: number } | null>(null);
  const effectiveLayout = liveWidth
    ? { ...layout, widths: { ...layout.widths, [liveWidth.column]: liveWidth.width } }
    : layout;

  function updateLayout(next: GridLayout) {
    onLayoutChange?.(next);
  }

  const isPinned = (column: string) => effectiveLayout.pinned.includes(column);

  // Saved order, reconciled against the current columns (drift removed, new ones appended), then pinned columns hoisted to the front.
  const visual = useMemo(() => visualColumns(columns, effectiveLayout), [columns, effectiveLayout]);

  // Unpinned columns stay flexible (minmax(…, 1fr)); pinning forces a fixed width since a sticky offset must be a precomputed number.
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

  const offsets = useMemo(() => pinOffsets(visual, effectiveLayout), [visual, effectiveLayout]);

  // A block-level `auto` width can't grow past its containing block on its own — without this explicit floor, the header and
  // body wrapper would silently overflow their box instead of growing to fit the columns' real minimums, drifting apart on scroll.
  const minTableWidth = visual.reduce((sum, col) => sum + widthOf(col, effectiveLayout), 0) + ACTIONS_COLUMN_PX;

  const sortIndexOf = (column: string) => sort.findIndex((term) => term.column === column);

  // Drag state lives outside React state — only the resulting width needs a re-render, not every mousemove.
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
      // Capture the current width on pin rather than snapping to the default — pinning fixes the width from here on.
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
    // Removing the column shifts everything after it left by one, so a rightward move must land AFTER the target's new index.
    const anchor = next.indexOf(targetColumn);
    next.splice(from < to ? anchor + 1 : anchor, 0, column);
    updateLayout({ ...effectiveLayout, order: next });
  }

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

  // The trigger is excluded here — its own click already toggles the menu, so this handler would immediately reopen what it just closed.
  useEffect(() => {
    if (copyMenuRow === null) return;
    function onPointerDown(event: PointerEvent) {
      const node = event.target as Node | null;
      if (node instanceof Element && node.closest("[data-copy-menu-trigger]")) return;
      if (copyMenuRef.current?.contains(node)) return;
      setCopyMenuRow(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setCopyMenuRow(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [copyMenuRow]);

  // Virtualization unmounts the row under an open menu once it scrolls out of the overscan window, orphaning the menu's anchor.
  useEffect(() => {
    if (copyMenuRow === null) return;
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      setCopyMenuRow(null);
    }
    // Deferred a frame: a trigger not fully in view gets focus-scrolled AFTER the click handler runs, which would self-dismiss otherwise.
    const frame = requestAnimationFrame(() => el.addEventListener("scroll", onScroll));
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
    };
  }, [copyMenuRow]);

  return (
    // No overflow-hidden here — it would clip GridToolbar's absolutely-positioned popovers regardless of z-index. The corner
    // rounding that needs it lives on the narrower wrapper below instead.
    <div className="rounded-lg border border-border" role="table" aria-rowcount={rows.length}>
      {toolbar}
      <div className="overflow-hidden rounded-b-lg">
        {/* Header and body share this one scrollable box (both axes): a separate table/header would re-flow column widths
            independently once rows are absolutely positioned for virtualization, drifting out of alignment on scroll. */}
        <div ref={scrollRef} className="max-h-125 overflow-auto">
          <div style={{ minWidth: minTableWidth }}>
            <div
              style={{ display: "grid", gridTemplateColumns }}
              // z-30 keeps the header above an expanded inline editor (z-20) that scrolls up under it. rounded-t-lg only when
              // there's no toolbar above: only then is this row the outer wrapper's topmost element, clipped to its radius.
              className={`sticky top-0 z-30 border-b border-border bg-surface-2 font-mono ${toolbar ? "" : "rounded-t-lg"}`}
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
                    // `group` on the cell, not the sort button — the pin button is the button's SIBLING and needs the hover scope too.
                    className={`group relative flex select-none items-center border-r border-border text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-faint ${
                      pinned ? "bg-surface-2" : ""
                    } ${dragColumn === col ? "opacity-50" : ""}`}
                  >
                    {/* `uppercase` repeated on the button on purpose — the UA stylesheet sets text-transform: none on form
                        controls, and Tailwind's preflight doesn't re-inherit it, so headers render lowercase without this. */}
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
                    {/* `invisible`, not opacity — an unrevealed pin stays unclickable while the header still reserves its space. */}
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
                    {/* Sibling of the sort button, not nested inside it, so dragging never fires a sort click. */}
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
                  const copyLabel = `Copy row ${getRowLabel(dataRowIndex)}`;
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
                        // Pinned to the constant the virtualizer measures with — left to size itself, a bordered boolean pill
                        // once made rows 33px vs 31.5px while `virtualRow.start` advanced by a flat 33px, drifting rows apart.
                        height: ROW_HEIGHT_PX,
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                        // This row's own transform is a stacking context (see raisedRowIndex above) — the copy menu's row needs the same raising.
                        zIndex: effectiveRaisedRow === dataRowIndex ? 20 : undefined,
                      }}
                    >
                      {visual.map((col) => {
                        // columnIndex stays the DATA index even as `col` iterates the reordered display — reordering must never redirect an edit.
                        const columnIndex = columns.indexOf(col);
                        const value = row[columnIndex] ?? null;
                        const pinned = isPinned(col);
                        // A pinned cell slides over its neighbours, so it needs its own opaque fill (including the row's hover fill) or hovering reveals a hole.
                        const pinnedClass = pinned ? "bg-bg group-hover/row:bg-surface-2" : "";
                        const pinnedStyle = pinned
                          ? { position: "sticky" as const, left: offsets[col], zIndex: 10 }
                          : undefined;
                        return renderCell ? (
                          // `relative` so an expanded inline editor can spill over the columns to its right instead of being squeezed into one.
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
                            {/* Truncation lives on this span, not the cell — text-overflow has no effect on a flex container's own anonymous text child. */}
                            <span className={`min-w-0 flex-1 truncate ${cellDisplay(value).className}`}>
                              <CellValue value={value} />
                            </span>
                          </div>
                        );
                      })}
                      <div role="cell" className="relative flex items-center gap-1 px-2">
                        <button
                          type="button"
                          data-copy-menu-trigger
                          aria-label={copyLabel}
                          aria-haspopup="menu"
                          aria-expanded={copyMenuRow === dataRowIndex}
                          onClick={() => setCopyMenuRow(copyMenuRow === dataRowIndex ? null : dataRowIndex)}
                          className="grid size-5 shrink-0 place-items-center rounded-sm text-text-faint hover:bg-surface-2 hover:text-text"
                        >
                          <CopyIcon />
                        </button>
                        {copyMenuRow === dataRowIndex ? (
                          <div
                            ref={copyMenuRef}
                            role="menu"
                            aria-label={copyLabel}
                            className="absolute right-0 top-full z-20 mt-1 min-w-30 rounded-lg border border-border bg-surface p-1 shadow-lg"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                void copyRow(row, "tsv");
                                setCopyMenuRow(null);
                              }}
                              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text"
                            >
                              Copy as TSV
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                void copyRow(row, "json");
                                setCopyMenuRow(null);
                              }}
                              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text"
                            >
                              Copy as JSON
                            </button>
                          </div>
                        ) : null}
                        {renderRowActions ? renderRowActions(dataRowIndex) : null}
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
