import { SecondaryButton } from "../../ui/SecondaryButton";
import type { GridLayout } from "./gridLayout";

export function ColumnsPopover({
  columns,
  layout,
  onChange,
}: {
  columns: string[];
  layout: GridLayout;
  onChange: (layout: GridLayout) => void;
}) {
  const toggleHidden = (column: string) =>
    onChange({
      ...layout,
      hidden: layout.hidden.includes(column)
        ? layout.hidden.filter((c) => c !== column)
        : [...layout.hidden, column],
    });

  const togglePinned = (column: string) =>
    onChange({
      ...layout,
      pinned: layout.pinned.includes(column)
        ? layout.pinned.filter((c) => c !== column)
        : [...layout.pinned, column],
    });

  return (
    <div className="min-w-82.5 p-2.5">
      <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
        Columns
      </div>
      {/* Every column is listed, hidden ones included — otherwise hiding a
          column would remove the only control that brings it back. */}
      {columns.map((column) => (
        <div key={column} className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-xs text-text-muted hover:bg-surface-2">
          <input
            type="checkbox"
            aria-label={`Show ${column}`}
            checked={!layout.hidden.includes(column)}
            onChange={() => toggleHidden(column)}
            className="size-3.5 shrink-0 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent"
          />
          <span className="min-w-0 flex-1 truncate font-mono">{column}</span>
          <button
            type="button"
            aria-label={layout.pinned.includes(column) ? `Unfreeze ${column}` : `Freeze ${column}`}
            aria-pressed={layout.pinned.includes(column)}
            onClick={() => togglePinned(column)}
            className={`shrink-0 rounded-sm p-1 ${layout.pinned.includes(column) ? "text-text" : "text-text-faint"} hover:text-text`}
          >
            📌
          </button>
        </div>
      ))}
      <div className="mt-3 flex items-center justify-between gap-2">
        <SecondaryButton className="h-6.5" onClick={() => onChange({ ...layout, hidden: [] })}>
          Show all
        </SecondaryButton>
        <span />
      </div>
    </div>
  );
}
