import { useState } from "react";
import { SecondaryButton } from "../../ui/SecondaryButton";
import {
  OPERATORS_FOR_FAMILY,
  OP_LABELS,
  VALUELESS_OPS,
  type ColumnFamily,
  type FilterCondition,
  type FilterOp,
} from "./types";

export function FilterPopover({
  columns,
  familyOf,
  applied,
  onApply,
  onClose,
}: {
  columns: string[];
  familyOf: (column: string) => ColumnFamily;
  applied: FilterCondition[];
  onApply: (conditions: FilterCondition[]) => void;
  onClose: () => void;
}) {
  // Snapshot on mount: Cancel restores exactly this, and nothing the user
  // types here reaches the query until Apply.
  const [draft, setDraft] = useState<FilterCondition[]>(() => applied.map((c) => ({ ...c })));

  function update(index: number, patch: Partial<FilterCondition>) {
    setDraft((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  return (
    <div className="min-w-82.5 p-2.5">
      <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
        Filter — applied as a WHERE clause
      </div>

      {draft.length === 0 ? (
        <div className="mb-2 text-xs text-text-faint">No conditions yet.</div>
      ) : null}

      {draft.map((condition, index) => {
        const operators = OPERATORS_FOR_FAMILY[familyOf(condition.column)];
        const needsValue = !VALUELESS_OPS.includes(condition.op);
        return (
          <div key={index} className="mb-1.5 flex items-center gap-1.5">
            <input
              type="checkbox"
              aria-label={`Include ${condition.column} condition`}
              checked={condition.enabled}
              onChange={(e) => update(index, { enabled: e.target.checked })}
              className="size-3.5 shrink-0 appearance-none rounded border border-text-faint checked:border-accent checked:bg-accent"
            />
            <select
              aria-label={`Filter column, condition ${index + 1}`}
              value={condition.column}
              onChange={(e) => {
                // The old operator may not exist for the new column's type.
                const nextColumn = e.target.value;
                update(index, { column: nextColumn, op: OPERATORS_FOR_FAMILY[familyOf(nextColumn)][0] });
              }}
              className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 text-xs text-text"
            >
              {columns.map((column) => (
                <option key={column} value={column}>{column}</option>
              ))}
            </select>
            <select
              aria-label={`Filter operator, condition ${index + 1}`}
              value={condition.op}
              onChange={(e) => update(index, { op: e.target.value as FilterOp })}
              className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 text-xs text-text"
            >
              {operators.map((op) => (
                <option key={op} value={op}>{OP_LABELS[op]}</option>
              ))}
            </select>
            {needsValue ? (
              <input
                aria-label="Filter value"
                value={condition.value ?? ""}
                onChange={(e) => update(index, { value: e.target.value })}
                placeholder="value"
                className="h-6.5 min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 font-mono text-xs text-text"
              />
            ) : null}
            <button
              type="button"
              aria-label={`Remove condition on ${condition.column}`}
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
            setDraft((prev) => [
              ...prev,
              { column: columns[0], op: OPERATORS_FOR_FAMILY[familyOf(columns[0])][0], value: "", enabled: true },
            ])
          }
        >
          + Add filter
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
