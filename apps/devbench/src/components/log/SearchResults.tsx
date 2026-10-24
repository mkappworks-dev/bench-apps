import type { LogLine, LogSourceStatus } from "../../lib/tauri";

function levelClass(level: string | null): string {
  switch (level) {
    case "ERROR":
    case "FATAL":
      return "text-danger";
    case "WARN":
      return "text-warning";
    default:
      return "text-text-muted";
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
  sources = [],
  searched,
  error,
}: {
  lines: LogLine[];
  sources?: Pick<LogSourceStatus, "id" | "label">[];
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
      <div className="log-empty">
        Search persisted log history — including sources you have since removed.
      </div>
    );
  }
  if (lines.length === 0) {
    return <div className="log-empty">No stored lines match this search.</div>;
  }

  const labels = new Map(sources.map((source) => [source.id, source.label]));

  return (
    <div className="log-search-results" data-testid="search-results">
      <p className="log-search-meta">{lines.length} stored line{lines.length === 1 ? "" : "s"} shown · newest first</p>
      <div className="log-results-list font-mono">
        {lines.map((line) => (
          <div key={line.id} data-testid="search-result" className="log-search-row">
            <span className="tabular-nums text-text-muted">{stamp(line.captured_at_ms)}</span>
            <span className="log-search-source min-w-0 truncate text-text-muted" title={line.source_id}>{labels.get(line.source_id) ?? line.source_id}</span>
            <span className={`log-search-level font-bold ${levelClass(line.level)}`}>{line.level ?? ""}</span>
            <span className="log-search-message min-w-0 whitespace-pre-wrap break-words text-text">{line.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
