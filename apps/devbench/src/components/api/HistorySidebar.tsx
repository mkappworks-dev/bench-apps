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

  // `sessionId` is a dependency, not just an argument: switching sessions
  // must refetch, or the sidebar keeps rendering the previous session's
  // requests under the new session's heading.
  useEffect(() => {
    // Refetching alone is not enough: across a session switch two reads are in
    // flight and nothing orders their resolution. If the older one lands last
    // it overwrites the newer, putting the previous session's requests under
    // this session's heading — the exact failure scoping exists to prevent.
    let cancelled = false;

    // A failed read is tracked separately from an empty one. Collapsing both
    // into "no entries" would render a fetch failure as "No requests yet." —
    // telling the user they fired nothing when the truth is we could not
    // look (PRODUCT.md principle 4).
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
          // Creating a session auto-selects it, so an empty scoped list is
          // the first thing a new session shows. Saying nothing at all here
          // reads as a broken fetch rather than as "nothing yet" — but a
          // genuine failure must not be dressed up as emptiness either.
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
