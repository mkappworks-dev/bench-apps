import { useEffect, useRef, useState } from "react";
import { invokeListHistory, type HistoryEntry } from "../../lib/tauri";

export function HistorySidebar({
  onSelect,
  refreshKey,
  sessionId,
  focusId,
}: {
  onSelect: (entry: HistoryEntry) => void;
  /** Bump this (e.g. a counter) to trigger a refetch, such as after a new entry is saved. */
  refreshKey?: number;
  /** `null`/omitted = unscoped: every request ever fired. Otherwise only this session's. */
  sessionId?: string | null;
  /** Deep-linked from Email's "Sent by" chip — selects and highlights this entry once it's in `entries`. */
  focusId?: string | null;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [failed, setFailed] = useState(false);
  // Distinguishes "still fetching" from "fetched, and the focused entry just
  // isn't in the result" — needed to show the deep-link note below only once
  // we actually know it's missing, not while the read is still in flight.
  const [loading, setLoading] = useState(true);
  // The actually-highlighted row: seeded from focusId once, then follows
  // manual clicks — never re-read from focusId, which never clears.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which focusId has already triggered onSelect — see the effect below.
  const consumedFocusId = useRef<string | null>(null);

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
    setSelectedId(null);
    setLoading(true);

    // Tracked separately from an empty list — collapsing them would render a
    // fetch failure as "No requests yet." (PRODUCT.md principle 4).
    invokeListHistory(sessionId)
      .then((loaded) => {
        if (cancelled) return;
        setEntries(loaded);
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setFailed(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey, sessionId]);

  // onSelect is a fresh closure every render (ApiTab's handleHistorySelect
  // isn't memoized), so without the ref guard this loops: onSelect ->
  // ApiTab re-renders -> a new onSelect -> the effect fires again. The same
  // guard also lets a focusId that arrives before the fetch resolves retry
  // once `entries` updates, instead of being silently dropped.
  useEffect(() => {
    if (!focusId || consumedFocusId.current === focusId) return;
    const match = entries.find((e) => e.id === focusId);
    if (!match) return;
    consumedFocusId.current = focusId;
    setSelectedId(match.id);
    onSelect(match);
  }, [focusId, entries, onSelect]);

  // History only ever loads the 50 most recent requests, but mail retention
  // is 5,000 messages — so a "Sent by" chip on any older email deep-links to
  // an entry that will never be in `entries`. Without this, that chip
  // silently switches to the API tab and does nothing.
  const focusNotFound = Boolean(focusId) && !loading && !failed && !entries.some((e) => e.id === focusId);

  return (
    <aside className="w-55 min-w-55 border-r border-border overflow-y-auto">
      <div className="border-b border-border p-2.5 text-xs font-bold text-text-muted">History</div>
      {focusNotFound ? (
        <div className="border-b border-border p-2 text-xs text-text-faint">
          That request is older than what's shown here.
        </div>
      ) : null}
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
              onClick={() => {
                setSelectedId(entry.id);
                onSelect(entry);
              }}
              aria-current={selectedId === entry.id}
              className={`flex flex-col gap-0.5 rounded-sm p-2 text-left hover:bg-surface-2 ${
                selectedId === entry.id ? "bg-surface-2" : ""
              }`}
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
