import type { TableDiff } from "../../lib/tauri";

function summarize(diff: TableDiff): string {
  const parts: string[] = [];
  if (diff.inserted > 0) parts.push(`${diff.inserted} inserted`);
  if (diff.updated > 0) parts.push(`${diff.updated} updated`);
  if (diff.deleted > 0) parts.push(`${diff.deleted} deleted`);
  return parts.join(", ");
}

export function Rollup({
  diffs,
  loading,
  watchedTableCount,
  onTableClick,
}: {
  /**
   * `null` means diff data isn't available at all (e.g. a history-selected
   * entry, which doesn't capture diff data) — distinct from `[]`, which means
   * diffs genuinely were computed and nothing changed.
   */
  diffs: TableDiff[] | null;
  loading: boolean;
  /** How many tables are currently watched — disambiguates "nothing changed" from "nothing is being watched". */
  watchedTableCount: number;
  onTableClick: (table: string) => void;
}) {
  if (loading) {
    return (
      <div data-testid="rollup-loading" className="flex gap-4.5 p-3">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  if (diffs === null) {
    return <div className="p-3 text-text-faint">Diff not available for past requests.</div>;
  }

  if (diffs.length === 0 && watchedTableCount === 0) {
    return (
      <div className="p-3 text-text-faint">
        No tables are being watched — select tables in the DB tab to see what a request changes.
      </div>
    );
  }

  if (diffs.length === 0) {
    return (
      <div className="p-3 text-text-faint">
        No observed effects — nothing in the watched tables changed.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-5 p-3">
      {diffs.map((diff) => (
        <button
          key={diff.table}
          onClick={() => onTableClick(diff.table)}
          className="flex items-center gap-1.5 font-semibold text-text hover:text-accent"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-text-faint" />
          {diff.table} <span className="font-normal text-text-muted">{summarize(diff)}</span>
          <span className="font-bold text-accent">→</span>
        </button>
      ))}
    </div>
  );
}
