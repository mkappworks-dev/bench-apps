import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const ROW_HEIGHT_PX = 33;
const MIN_COLUMN_PX = 140;
const ACTIONS_COLUMN_PX = 90;

export interface DataGridProps {
  columns: string[];
  rows: (string | null)[][];
  sortColumn?: string | null;
  sortDescending?: boolean;
  onSort?: (column: string) => void;
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
  onPrevPage?: () => void;
  onNextPage?: () => void;
  /** Overrides how a cell renders — Task 12's editable-cell UI plugs in here. */
  renderCell?: (rowIndex: number, columnIndex: number, value: string | null) => ReactNode;
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
        className={`inline-flex rounded-full px-1.75 py-px text-[10.5px] font-bold ${
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
  sortColumn = null,
  sortDescending = false,
  onSort,
  hasNextPage = false,
  hasPrevPage = false,
  onPrevPage,
  onNextPage,
  renderCell,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // Undragged columns stay flexible (`minmax(…, 1fr)`, matching the mockup's
  // auto-sizing `<table>`); dragging a `.th-resize` handle pins that one
  // column to a fixed px width, same as the mockup's resize handles. This
  // keeps the default (nothing dragged) layout byte-for-byte identical to
  // before the resize feature existed.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const gridTemplateColumns = useMemo(
    () =>
      columns.map((col) => (columnWidths[col] ? `${columnWidths[col]}px` : `minmax(${MIN_COLUMN_PX}px, 1fr)`)).join(" ") +
      ` ${ACTIONS_COLUMN_PX}px`,
    [columns, columnWidths],
  );
  // Floor for the header+body wrapper below. Without it, a block-level `auto`
  // width can't grow past its containing block even when the grid's own
  // column minimums need more room — the grid silently overflows its box
  // instead of the box (and its scrollbar) growing to fit. This is what let
  // the header and body compute different widths and drift apart on scroll.
  // A resized column's floor is its own fixed width rather than the shared
  // minimum, since that's what the grid track actually demands.
  const minTableWidth =
    columns.reduce((sum, col) => sum + (columnWidths[col] ?? MIN_COLUMN_PX), 0) + ACTIONS_COLUMN_PX;

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
      function onMove(ev: MouseEvent) {
        const next = Math.max(MIN_COLUMN_PX, Math.round(startWidth + (ev.clientX - startX)));
        setColumnWidths((prev) => ({ ...prev, [column]: next }));
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });

  async function copyRow(row: (string | null)[], format: "tsv" | "json") {
    const text = format === "tsv" ? rowAsTsv(row) : rowAsJson(columns, row);
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border" role="table" aria-rowcount={rows.length}>
      {/* Header and body share this one scrollable box (both axes) so a
          horizontal scroll moves them together — a table/tbody or a
          sibling header re-flows column widths independently the moment
          rows are absolutely positioned for virtualization, which is what
          let the header drift out of alignment with scrolled row content. */}
      <div ref={scrollRef} className="max-h-125 overflow-auto">
        <div style={{ minWidth: minTableWidth }}>
          <div
            style={{ display: "grid", gridTemplateColumns }}
            className="sticky top-0 z-10 border-b border-border bg-surface-2"
            role="row"
          >
            {columns.map((col) => {
              const active = sortColumn === col;
              return (
                <div
                  key={col}
                  role="columnheader"
                  aria-sort={active ? (sortDescending ? "descending" : "ascending") : undefined}
                  className="relative select-none text-left text-[10.5px] font-semibold uppercase tracking-wide text-text-faint"
                >
                  <button
                    type="button"
                    onClick={() => onSort?.(col)}
                    className="group flex w-full items-center gap-1.25 py-1.75 pl-3 pr-3.5 text-left hover:text-text"
                    aria-label={`Sort by ${col}`}
                  >
                    <span className="truncate">{col}</span>
                    <SortChevron active={active} descending={sortDescending} column={col} />
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
                const row = rows[virtualRow.index];
                return (
                  <div
                    key={virtualRow.index}
                    role="row"
                    className="border-b border-border font-mono text-xs hover:bg-surface-2"
                    style={{
                      display: "grid",
                      gridTemplateColumns,
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.map((value, columnIndex) =>
                      renderCell ? (
                        <div key={columnIndex} role="cell" className="px-3 py-1.75 text-text">
                          {renderCell(virtualRow.index, columnIndex, value)}
                        </div>
                      ) : (
                        <div
                          key={columnIndex}
                          role="cell"
                          className={`truncate px-3 py-1.75 text-text ${cellDisplay(value).className}`}
                        >
                          <CellValue value={value} />
                        </div>
                      ),
                    )}
                    <div role="cell" className="px-2 py-1.75">
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
