import { useState } from "react";
import { SecondaryButton } from "../../ui/SecondaryButton";
import type { SortTerm } from "./types";

export function SortPopover({
  columns,
  applied,
  onApply,
  onClose,
}: {
  columns: string[];
  applied: SortTerm[];
  onApply: (terms: SortTerm[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SortTerm[]>(() => applied.map((t) => ({ ...t })));

  function update(index: number, patch: Partial<SortTerm>) {
    setDraft((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= draft.length) return;
    setDraft((prev) => {
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  }

  // Ranks count enabled terms only — a term that is not in the ORDER BY has no
  // place in it, so giving it a number would be a lie.
  let rank = 0;

  return (
    <div className="min-w-82.5 p-2.5">
      <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
        Sort — priority runs top to bottom
      </div>

      {draft.length === 0 ? <div className="mb-2 text-xs text-text-faint">No sort yet.</div> : null}

      {draft.map((term, index) => {
        if (term.enabled) rank += 1;
        return (
          <div key={index} className="mb-1.5 flex items-center gap-1.5">
            <input
              type="checkbox"
              aria-label={`Include ${term.column} in the sort`}
              checked={term.enabled}
              onChange={(e) => update(index, { enabled: e.target.checked })}
              className="size-3.5 shrink-0 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent"
            />
            <span
              data-testid={`rank-${term.column}`}
              className={`w-3.5 shrink-0 text-center font-mono text-xs ${term.enabled ? "text-text" : "text-text-faint"}`}
            >
              {term.enabled ? rank : "—"}
            </span>
            <select
              aria-label="Sort column"
              value={term.column}
              onChange={(e) => update(index, { column: e.target.value })}
              className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 text-xs text-text"
            >
              {columns.map((column) => (
                <option key={column} value={column}>{column}</option>
              ))}
            </select>
            {/* Fixed width: ASC and DESC are different lengths, so an
                auto-sized toggle shifts every control to its right. */}
            <SecondaryButton
              className="h-6.5 w-13 font-mono"
              aria-label={`Toggle direction for ${term.column}`}
              onClick={() => update(index, { descending: !term.descending })}
            >
              {term.descending ? "DESC" : "ASC"}
            </SecondaryButton>
            <button
              type="button"
              aria-label={`Raise priority of ${term.column}`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              className="shrink-0 rounded-sm p-1 text-text-faint hover:bg-surface-2 hover:text-text disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Lower priority of ${term.column}`}
              disabled={index === draft.length - 1}
              onClick={() => move(index, 1)}
              className="shrink-0 rounded-sm p-1 text-text-faint hover:bg-surface-2 hover:text-text disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Remove sort on ${term.column}`}
              onClick={() => setDraft((prev) => prev.filter((_, i) => i !== index))}
              className="shrink-0 rounded-sm p-1 text-text-faint hover:bg-danger-bg hover:text-danger"
            >
              ✕
            </button>
          </div>
        );
      })}

      <div className="mt-3 flex items-center justify-between gap-2">
        <SecondaryButton
          className="h-6.5"
          onClick={() =>
            setDraft((prev) => [...prev, { column: columns[0], descending: false, enabled: true }])
          }
        >
          + Add sort
        </SecondaryButton>
        <span className="flex gap-2">
          <SecondaryButton className="h-6.5" onClick={onClose}>Cancel</SecondaryButton>
          <button
            type="button"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            className="h-6.5 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on hover:bg-accent-strong"
          >
            Apply
          </button>
        </span>
      </div>
    </div>
  );
}
