import { useEffect, useState } from "react";
import { invokeListHistory, type HistoryEntry } from "../../lib/tauri";

export function HistorySidebar({ onSelect }: { onSelect: (entry: HistoryEntry) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    invokeListHistory().then(setEntries);
  }, []);

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
