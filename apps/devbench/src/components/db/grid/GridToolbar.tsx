import { useEffect, useState } from "react";
import { ColumnsPopover } from "./ColumnsPopover";
import { FilterPopover } from "./FilterPopover";
import { SortPopover } from "./SortPopover";
import { downloadText, toCsv, toJson } from "./exportRows";
import { visualColumns, type GridLayout } from "./gridLayout";
import { activeConditions, activeSortTerms, type ColumnFamily, type FilterCondition, type SortTerm } from "./types";

const LIMITS = [25, 50, 100, 250, 500, 1000];
type PopoverId = "filter" | "sort" | "columns" | "export" | null;

export function GridToolbar({
  columns,
  rows,
  layout,
  onLayoutChange,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  page,
  pageCount,
  onPageChange,
  limit,
  onLimitChange,
  onRefresh,
  onInsert,
  familyOf,
}: {
  columns: string[];
  rows: (string | null)[][];
  layout: GridLayout;
  onLayoutChange: (layout: GridLayout) => void;
  filter: FilterCondition[];
  onFilterChange: (filter: FilterCondition[]) => void;
  sort: SortTerm[];
  onSortChange: (sort: SortTerm[]) => void;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  limit: number;
  onLimitChange: (limit: number) => void;
  onRefresh: () => void;
  /** Slice 3 wires this to the insert panel; until then the button is absent. */
  onInsert?: () => void;
  familyOf: (column: string) => ColumnFamily;
}) {
  const [open, setOpen] = useState<PopoverId>(null);
  const [pageField, setPageField] = useState(String(page));

  // useState's initial value is only read on mount — every other path that
  // changes `page` (Prev/Next, or a reset from filter/sort/limit changes)
  // has to be caught here, not just the commitPage path below.
  useEffect(() => {
    setPageField(String(page));
  }, [page]);

  const close = () => setOpen(null);

  // Counts describe what is acting on the grid right now, so a rule that is
  // switched off or still missing its value is not counted.
  const badges: Record<string, number> = {
    filter: activeConditions(filter).length,
    sort: activeSortTerms(sort).length,
    columns: layout.hidden.length,
    export: 0,
  };

  function trigger(id: Exclude<PopoverId, null>, label: string) {
    const count = badges[id];
    return (
      <button
        type="button"
        title={label}
        aria-expanded={open === id}
        onClick={() => setOpen(open === id ? null : id)}
        className={`inline-flex h-6.5 items-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-xs font-medium ${
          count ? "bg-surface-2 text-text" : "text-text-muted"
        } hover:bg-surface-2 hover:text-text`}
      >
        <span className="tb-label">{label}</span>
        {count ? (
          <span className="inline-flex h-3.75 min-w-3.75 items-center justify-center rounded-full bg-accent px-1 text-[10.5px] font-bold text-accent-on">
            {count}
          </span>
        ) : null}
      </button>
    );
  }

  function commitPage() {
    const parsed = Number.parseInt(pageField, 10);
    // Out of range clamps rather than erroring — a page beyond the end is a
    // typo, not a request for an empty grid.
    const next = Math.min(Math.max(1, Number.isNaN(parsed) ? 1 : parsed), Math.max(1, pageCount));
    setPageField(String(next));
    onPageChange(next);
  }

  const exportColumns = visualColumns(columns, layout);
  const exportRows = rows.map((row) => exportColumns.map((c) => row[columns.indexOf(c)] ?? null));

  return (
    <div className="relative">
      {/* container-type is what lets the labels collapse on PANE width rather
          than window width — the toolbar shrinks when the dock opens. */}
      <div className="@container flex items-center gap-1 border-b border-border bg-surface px-2 py-1.25">
        {onInsert ? (
          <button
            type="button"
            title="Insert row"
            onClick={onInsert}
            className="inline-flex h-6.5 items-center gap-1.5 rounded-sm bg-accent px-2 text-xs font-bold text-accent-on hover:bg-accent-strong"
          >
            <span className="tb-label">Insert</span>
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Refresh"
          title="Refresh"
          onClick={onRefresh}
          className="inline-flex size-6.5 items-center justify-center rounded-sm text-text-muted hover:bg-surface-2 hover:text-text"
        >
          ⟳
        </button>
        <span className="mx-1 h-4 w-px shrink-0 bg-border" />
        {trigger("filter", "Filter")}
        {trigger("sort", "Sort")}
        {trigger("columns", "Columns")}
        {trigger("export", "Export")}
        <span className="min-w-2 flex-1" />
        <div className="flex items-center gap-0.5 text-xs text-text-faint">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="inline-flex h-6 w-5.5 items-center justify-center rounded-sm hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            ‹
          </button>
          <input
            aria-label="Page number"
            value={pageField}
            onChange={(e) => setPageField(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commitPage()}
            onBlur={commitPage}
            className="h-6 w-8.5 rounded-sm border border-border bg-bg text-center font-mono text-xs text-text"
          />
          <span className="whitespace-nowrap px-1.5">of {pageCount}</span>
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
            className="inline-flex h-6 w-5.5 items-center justify-center rounded-sm hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            ›
          </button>
          <select
            aria-label="Rows per page"
            value={limit}
            onChange={(e) => {
              onLimitChange(Number(e.target.value));
              onPageChange(1);
            }}
            className="h-6 rounded-sm bg-transparent px-1 text-xs text-text-muted"
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {open ? (
        <div className="absolute left-2 top-full z-50 mt-1.5 rounded-lg border border-border bg-surface shadow-lg">
          {open === "filter" ? (
            <FilterPopover
              columns={columns}
              familyOf={familyOf}
              applied={filter}
              onApply={onFilterChange}
              onClose={close}
            />
          ) : null}
          {open === "sort" ? (
            <SortPopover columns={columns} applied={sort} onApply={onSortChange} onClose={close} />
          ) : null}
          {open === "columns" ? (
            <ColumnsPopover columns={columns} layout={layout} onChange={onLayoutChange} />
          ) : null}
          {open === "export" ? (
            <div className="min-w-82.5 p-2.5">
              <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
                Export — this page
              </div>
              <button
                type="button"
                onClick={() => {
                  downloadText("rows.csv", "text/csv", toCsv(exportColumns, exportRows));
                  close();
                }}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                CSV
              </button>
              <button
                type="button"
                onClick={() => {
                  downloadText("rows.json", "application/json", toJson(exportColumns, exportRows));
                  close();
                }}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                JSON
              </button>
              <div className="mt-1.5 text-xs text-text-faint">
                Exports the {rows.length} rows on this page, in the column order shown.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
