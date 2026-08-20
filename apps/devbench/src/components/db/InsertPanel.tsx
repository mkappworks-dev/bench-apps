import { useState } from "react";
import { DockShell } from "../shell/DockShell";
import { SecondaryButton } from "../ui/SecondaryButton";
import { familyOfUdt, isNumericUdt, type ColumnInfo } from "./grid/columnMeta";
import { useAppStore, type InsertTarget } from "../../store/useAppStore";
import { tableKey } from "../../lib/tableIdentity";

// The database assigns identity, generated and serial columns, so they are shown (the row's shape should be honest) but never typed into.
function isAssigned(column: ColumnInfo): boolean {
  return column.is_identity;
}

// Required means "the database will reject the row without it": NOT NULL, no default, and not assigned by the database itself.
function isRequired(column: ColumnInfo): boolean {
  return !isAssigned(column) && !column.nullable && column.default_expr === null;
}

export function InsertPanel({ target, onClose }: { target: InsertTarget; onClose: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const addPendingInsert = useAppStore((s) => s.addPendingInsert);
  const setDockPanel = useAppStore((s) => s.setDockPanel);

  const editable = target.columns.filter((c) => !isAssigned(c));
  const filled = editable.filter((c) => (draft[c.name] ?? "").trim() !== "");
  // Two ways to stage an empty insert and fail the whole Apply transaction: no editable columns yet
  // (describe_columns still loading), or every column optional and none of them typed into.
  const missing =
    editable.length === 0 ||
    filled.length === 0 ||
    editable.some((c) => isRequired(c) && !(draft[c.name] ?? "").trim());

  function stage() {
    if (missing) return;
    // A blank field is omitted, not sent as NULL — an omitted column takes its default (or NULL with none),
    // while an explicit NULL would override a default the user chose not to touch.
    const values: Record<string, string | null> = {};
    for (const column of editable) {
      const typed = (draft[column.name] ?? "").trim();
      if (typed !== "") values[column.name] = typed;
    }
    // target's own connectionId, not whatever the picker points at now — the form was built from THIS connection's metadata.
    addPendingInsert(target.connectionId, target.table, values);
    setDockPanel("pending");
  }

  return (
    <DockShell
      label="Insert row"
      closeLabel="Close insert row"
      title={`Insert row · ${tableKey(target.table)}`}
      onClose={onClose}
      footer={
        // SecondaryButton deliberately carries no height of its own — the row sets h-7.5 for both buttons.
        <div className="flex gap-2 border-t border-border px-3 py-2.5">
          <SecondaryButton className="h-7.5" onClick={onClose}>
            Cancel
          </SecondaryButton>
          <button
            type="button"
            disabled={missing}
            onClick={stage}
            className="h-7.5 flex-1 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on hover:bg-accent-strong disabled:opacity-40"
          >
            Stage insert
          </button>
        </div>
      }
    >
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {target.columns.map((column) => {
          const assigned = isAssigned(column);
          const required = isRequired(column);
          const label = (
            <span className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-text-faint">
              {column.name}
              {required ? <span className="text-danger">*</span> : null}
              <span className="font-medium normal-case tracking-normal text-text-faint">
                {assigned ? "— assigned by the database" : column.udt}
              </span>
            </span>
          );

          const fieldClass =
            "rounded-sm border border-border bg-bg px-2 py-1.5 font-mono text-xs text-text read-only:cursor-not-allowed read-only:bg-surface-2 read-only:text-text-faint";

          return (
            <label key={column.name} className="flex flex-col gap-1">
              {label}
              {assigned ? (
                <input readOnly value="" placeholder="auto" className={fieldClass} />
              ) : familyOfUdt(column.udt) === "boolean" ? (
                <select
                  value={draft[column.name] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [column.name]: e.target.value })}
                  className={fieldClass}
                >
                  <option value="">{column.default_expr ?? "NULL"} (default)</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  type={isNumericUdt(column.udt) ? "number" : "text"}
                  value={draft[column.name] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [column.name]: e.target.value })}
                  placeholder={column.default_expr ?? (column.nullable ? "NULL" : "")}
                  className={fieldClass}
                />
              )}
            </label>
          );
        })}
        <div className="text-xs text-text-faint">
          Blank means the database decides — defaults are shown as placeholders. Saving stages the
          insert; nothing is written until you Apply.
        </div>
      </div>
    </DockShell>
  );
}
