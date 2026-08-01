import { useMemo, useRef, useState, type ReactNode } from "react";
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

export function cellDisplay(value: string | null): { text: string; className: string } {
  if (value === null) return { text: "NULL", className: "italic text-text-faint" };
  if (value === "<unsupported type>") return { text: value, className: "italic text-warning" };
  if (/^-?\d+(\.\d+)?$/.test(value)) return { text: value, className: "text-right tabular-nums" };
  return { text: value, className: "" };
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
  const gridTemplateColumns = useMemo(
    () => `repeat(${columns.length}, minmax(${MIN_COLUMN_PX}px, 1fr)) ${ACTIONS_COLUMN_PX}px`,
    [columns.length],
  );
  // Floor for the header+body wrapper below. Without it, a block-level `auto`
  // width can't grow past its containing block even when the grid's own
  // column minimums need more room — the grid silently overflows its box
  // instead of the box (and its scrollbar) growing to fit. This is what let
  // the header and body compute different widths and drift apart on scroll.
  const minTableWidth = columns.length * MIN_COLUMN_PX + ACTIONS_COLUMN_PX;

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
    <div className="rounded-lg border border-border" role="table" aria-rowcount={rows.length}>
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
                  className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-text-faint"
                >
                  <button
                    type="button"
                    onClick={() => onSort?.(col)}
                    className="flex items-center gap-1"
                    aria-label={`Sort by ${col}`}
                  >
                    {col}
                    {active ? <span aria-hidden>{sortDescending ? "▼" : "▲"}</span> : null}
                  </button>
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
                    className="border-b border-border font-mono text-sm hover:bg-surface-2"
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
                          {cellDisplay(value).text}
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
            className="rounded-sm px-2 py-1 disabled:opacity-40"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={!hasNextPage}
            onClick={onNextPage}
            className="rounded-sm px-2 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
