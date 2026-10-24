import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogLine } from "../../lib/tauri";

const ROW_HEIGHT = 22;

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

/** `2026-07-30T14:02:11.482Z` -> `14:02:11.482`; anything unparsed is shown as-is. */
function shortTime(timestamp: string | null): string {
  if (!timestamp) return "";
  const match = /(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(timestamp);
  return match ? match[1] : timestamp;
}

export function LogStream({
  lines,
  filter,
  levels = [],
}: {
  lines: LogLine[];
  filter: string;
  /** Exact level multi-select. Empty means no level constraint. */
  levels?: string[];
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return lines.filter((l) => {
      if (needle && !l.raw.toLowerCase().includes(needle)) return false;
      // An unparsed line has no level, so it can't satisfy a level filter.
      if (levels.length > 0 && (l.level === null || !levels.includes(l.level))) return false;
      return true;
    });
  }, [lines, filter, levels]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // A live tail is only useful pinned to the newest line.
  useEffect(() => {
    if (visible.length > 0) virtualizer.scrollToIndex(visible.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length]);

  if (lines.length === 0) {
    return (
      <div className="log-empty">
        No log lines yet. Add a file, command, or Docker source to start capturing output.
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="log-empty">
        No lines match {filter.trim() ? `"${filter}"` : "the current filter"}.
      </div>
    );
  }

  return (
    <div ref={parentRef} className="log-stream font-mono text-xs" data-testid="log-stream">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const l = visible[item.index];
          return (
            <div
              key={l.id}
              data-testid="log-line"
              data-level={l.level ?? undefined}
              title={l.raw}
              className="log-line absolute left-0"
              style={{ top: 0, transform: `translateY(${item.start}px)`, height: item.size }}
            >
              <span className="log-line-time w-24 shrink-0 tabular-nums text-text-muted">{shortTime(l.timestamp)}</span>
              <span className={`w-12 shrink-0 font-bold ${levelClass(l.level)}`}>{l.level ?? ""}</span>
              <span className="min-w-0 truncate text-text">{l.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
