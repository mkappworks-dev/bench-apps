import type { LogLine } from "../../lib/tauri";

function levelClass(level: string | null): string {
  switch (level) {
    case "ERROR":
    case "FATAL":
      return "text-danger";
    case "WARN":
      return "text-warning";
    default:
      return "text-text-faint";
  }
}

/** Search results can span days, so they carry the date the live tail omits. */
function stamp(capturedAtMs: number): string {
  const d = new Date(capturedAtMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Historical results — a plain scrollable list, deliberately not `LogStream`.
 * A live tail pins itself to the newest line; a result set the user is reading
 * must not move under them.
 */
export function SearchResults({
  lines,
  searched,
  error,
}: {
  lines: LogLine[];
  /** False until a search has actually run, so "no results" and "nothing
   *  searched yet" render as the different states they are. */
  searched: boolean;
  error: string | null;
}) {
  if (error) {
    return <div className="m-3 rounded-sm bg-danger-bg px-2 py-1 text-xs text-danger">{error}</div>;
  }
  if (!searched) {
    return (
      <div className="p-4 text-sm text-text-faint">
        Search persisted log history — including sources you have since removed.
      </div>
    );
  }
  if (lines.length === 0) {
    return <div className="p-4 text-sm text-text-faint">No stored lines match this search.</div>;
  }

  return (
    <div className="h-full overflow-y-auto font-mono text-xs" data-testid="search-results">
      {lines.map((l) => (
        <div
          key={l.id}
          data-testid="search-result"
          className="flex items-baseline gap-2.5 border-b border-border px-3 py-1"
        >
          <span className="w-36 shrink-0 tabular-nums text-text-faint">{stamp(l.captured_at_ms)}</span>
          <span className={`w-12 shrink-0 font-bold ${levelClass(l.level)}`}>{l.level ?? ""}</span>
          <span className="break-all text-text">{l.message}</span>
        </div>
      ))}
    </div>
  );
}
