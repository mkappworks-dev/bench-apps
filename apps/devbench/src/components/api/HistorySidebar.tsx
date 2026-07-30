import { useEffect, useState } from "react";
import { invokeListHistory, type HistoryEntry } from "../../lib/tauri";

export function HistorySidebar({
  onSelect,
  refreshKey,
}: {
  onSelect: (entry: HistoryEntry) => void;
  /** Bump this (e.g. a counter) to trigger a refetch, such as after a new entry is saved. */
  refreshKey?: number;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    // Non-critical: if listing history fails, an empty sidebar is an acceptable
    // degraded state — but the rejection must not go unhandled.
    invokeListHistory()
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [refreshKey]);

  return (
    <aside className="w-55 min-w-55 border-r border-border overflow-y-auto">
      <div className="border-b border-border p-2.5 text-xs font-bold text-text-muted">History</div>
      <div className="flex flex-col gap-0.5 p-1.5">
        {entries.map((entry) => (
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
        ))}
      </div>
    </aside>
  );
}
