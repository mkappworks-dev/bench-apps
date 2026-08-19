import { useState } from "react";
import { DockShell } from "../shell/DockShell";
import { SecondaryButton } from "../ui/SecondaryButton";
import { useAppStore } from "../../store/useAppStore";
import { groupByTable, type ConflictReport, type PendingChange } from "../../lib/pendingChanges";
import { invokeApplyChanges } from "../../lib/tauri";

/** Spec §10: the panel colour-codes the kind. This is semantic colour used for
 *  what it is reserved for — real state — not decoration: update is provisional
 *  (`--warning`), insert creates (`--success`), delete destroys (`--danger`),
 *  and a raw statement makes no such claim, so it stays neutral. */
const KIND_CLASS: Record<PendingChange["kind"], string> = {
  update: "text-warning",
  insert: "text-success",
  delete: "text-danger",
  sql: "text-text-muted",
};

/** The row this entry targets, for the entry's header line. */
function describeTarget(entry: PendingChange): string {
  if (entry.kind === "update" || entry.kind === "delete") {
    return `${entry.pk_column} = ${entry.pk_value}`;
  }
  return "";
}

function DisplayValue({ value }: { value: string | null }) {
  return value === null ? <span className="italic">NULL</span> : <>{value}</>;
}

function EntryBody({ entry }: { entry: PendingChange }) {
  if (entry.kind === "update") {
    return (
      <>
        <span className="text-text-faint">{entry.column}</span>
        <span className="text-danger line-through">
          <DisplayValue value={entry.old_value} />
        </span>
        <span aria-hidden className="text-text-faint">
          →
        </span>
        <span className="font-semibold text-success">
          <DisplayValue value={entry.new_value} />
        </span>
      </>
    );
  }
  if (entry.kind === "insert") {
    return (
      <>
        {Object.entries(entry.values).map(([column, value]) => (
          <span key={column} className="flex items-center gap-1.5">
            <span className="text-text-faint">{column}</span>
            <span className="font-semibold text-success">
              <DisplayValue value={value} />
            </span>
          </span>
        ))}
      </>
    );
  }
  if (entry.kind === "delete") {
    return <span className="text-danger line-through">{describeTarget(entry)}</span>;
  }
  // A staged statement is re-run at Apply, so the effect the run reported
  // travels with it — a divergence should be visible, not silent (spec §12).
  return (
    <>
      <span className="whitespace-pre-wrap">{entry.statement}</span>
      <span className="text-text-faint">· {entry.previewed_effect} when run</span>
    </>
  );
}

/** Spec §10: reported honestly rather than silently overwriting. The wording
 *  separates the two facts a failed guard can carry — the row moved, or the
 *  row is gone — because "expected pending, found nothing" would describe a
 *  deleted row as a NULL. */
function conflictMessage(conflict: ConflictReport): string {
  const where = `${conflict.table} ${conflict.description}`;
  if (conflict.row_missing) {
    return `Nothing was written. ${where} no longer exists — someone deleted it after this change was staged.`;
  }
  const expected = conflict.expected ?? "NULL";
  const found = conflict.found ?? "NULL";
  return `Nothing was written. ${where} was staged against ${conflict.column} = ${expected}, but it now holds ${found}.`;
}

export function PendingPanel({
  connectionId,
  onClose,
  onApplied,
}: {
  connectionId: string | null;
  onClose: () => void;
  /** Called only after a commit that actually wrote. The grid lives in a
   *  DbTab, out of this panel's reach, and its rows are stale the moment Apply
   *  succeeds — without a refetch every applied cell would visibly snap back
   *  to its pre-Apply value as the staged overlay clears. */
  onApplied: () => void;
}) {
  const pending = useAppStore((s) => s.pending);
  const discardPendingAt = useAppStore((s) => s.discardPendingAt);
  const discardAllPending = useAppStore((s) => s.discardAllPending);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function apply() {
    if (!connectionId || applying || pending.length === 0) return;
    setApplying(true);
    setProblem(null);
    try {
      const outcome = await invokeApplyChanges(connectionId, pending);
      if (outcome.conflict) {
        // The transaction rolled back whole, so the set is still exactly what
        // the user staged. Clearing it here would cost them their work over a
        // failure that wrote nothing.
        setProblem(conflictMessage(outcome.conflict));
        return;
      }
      discardAllPending();
      onApplied();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  const groups = groupByTable(pending);

  return (
    <DockShell
      label="Pending changes"
      closeLabel="Close pending changes"
      title="Pending changes"
      onClose={onClose}
      footer={
        pending.length > 0 ? (
          // Spec §14: the ROW sets 30px (h-7.5) for both buttons.
          <div className="flex gap-2 border-t border-border px-3 py-2.5">
            <SecondaryButton className="h-7.5" disabled={applying} onClick={discardAllPending}>
              Discard all
            </SecondaryButton>
            <button
              type="button"
              disabled={applying || !connectionId}
              onClick={() => void apply()}
              className="h-7.5 flex-1 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on hover:bg-accent-strong disabled:opacity-40"
            >
              {applying ? "Applying…" : `Apply ${pending.length}`}
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {problem ? (
          <div role="alert" className="rounded-sm border border-border bg-danger-bg px-2.5 py-1.5 text-xs text-danger">
            {problem}
          </div>
        ) : null}

        {pending.length === 0 ? (
          <div className="text-xs text-text-faint">
            Nothing staged. Editing a cell, inserting a row or deleting a row collects here — then
            Apply commits them together in one transaction.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-1.5">
              <div className="text-[10.5px] font-bold uppercase tracking-wide text-text-faint">
                {group.label}
              </div>
              {group.entries.map(({ entry, index }) => (
                <div key={index} className="rounded-sm border border-border bg-surface px-2.5 py-2">
                  <div className="mb-1.25 flex items-center gap-1.5 font-mono text-[10.5px] text-text-faint">
                    <span className={`font-bold uppercase tracking-wide ${KIND_CLASS[entry.kind]}`}>
                      {entry.kind}
                    </span>
                    <span>{describeTarget(entry)}</span>
                    <button
                      type="button"
                      // Named by what it drops, not "Discard": several of
                      // these are on screen at once, and identical accessible
                      // names would make them indistinguishable.
                      aria-label={`Discard this ${entry.kind}`}
                      disabled={applying}
                      onClick={() => discardPendingAt(index)}
                      className="ml-auto rounded-sm px-1 text-text-faint hover:bg-danger-bg hover:text-danger disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-text-muted">
                    <EntryBody entry={entry} />
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </DockShell>
  );
}
