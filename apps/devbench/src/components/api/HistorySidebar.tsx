import { useEffect, useState } from "react";
import { invokeListHistory, type HistoryEntry } from "../../lib/tauri";

export function HistorySidebar({
  onSelect,
  refreshKey,
  sessionId,
}: {
  onSelect: (entry: HistoryEntry) => void;
  /** Bump this (e.g. a counter) to trigger a refetch, such as after a new entry is saved. */
  refreshKey?: number;
  /** `null`/omitted = unscoped: every request ever fired. Otherwise only this session's. */
  sessionId?: string | null;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [failed, setFailed] = useState(false);

  // `sessionId` is a dependency: switching sessions must refetch. `cancelled`
  // guards against the two in-flight reads resolving out of order.
  useEffect(() => {
    let cancelled = false;

    // Clear before the read, not just after: otherwise the previous session's
    // rows stay visible AND clickable for the whole in-flight read, and
    // clicking one repopulates the response pane with a foreign session's
    // request. `failed` resets too, but the `.catch` below sets it again on a
    // genuine failure — this only clears a PREVIOUS failure's label.
    setEntries([]);
    setFailed(false);

    // Tracked separately from an empty list — collapsing them would render a
    // fetch failure as "No requests yet." (PRODUCT.md principle 4).
    invokeListHistory(sessionId)
      .then((loaded) => {
        if (cancelled) return;
        setEntries(loaded);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey, sessionId]);

  return (
    <aside className="w-55 min-w-55 border-r border-border overflow-y-auto">
      <div className="border-b border-border p-2.5 text-xs font-bold text-text-muted">History</div>
      <div className="flex flex-col gap-0.5 p-1.5">
        {entries.length === 0 ? (
          // A new session auto-selects itself, so an empty scoped list is the
          // first thing it shows — say so explicitly rather than nothing.
          <div className="p-2 text-xs text-text-faint">
            {failed
              ? "Couldn't load history."
              : sessionId
                ? "No requests fired in this session yet."
                : "No requests yet."}
          </div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.id}
              onClick={() => onSelect(entry)}
              className="flex flex-col gap-0.5 rounded-sm p-2 text-left hover:bg-surface-2"
            >
              <div className="flex items-center gap-1.5">
                <span className="w-10 text-xs font-bold text-text-muted">{entry.method}</span>
                <span className="truncate font-mono text-xs text-text">{entry.url}</span>
              </div>
              <span className="text-xs text-text-faint">{entry.status_code}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
