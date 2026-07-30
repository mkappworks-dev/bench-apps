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
      return "text-text-faint";
  }
}

/** `2026-07-30T14:02:11.482Z` -> `14:02:11.482`; anything unparsed is shown as-is. */
function shortTime(timestamp: string | null): string {
  if (!timestamp) return "";
  const match = /(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(timestamp);
  return match ? match[1] : timestamp;
}

export function LogStream({ lines, filter }: { lines: LogLine[]; filter: string }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((l) => l.raw.toLowerCase().includes(needle));
  }, [lines, filter]);

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
      <div className="p-4 text-sm text-text-faint">
        No log lines yet. Add a source, or pipe your backend's output with{" "}
        <code className="font-mono">yourapp 2&gt;&amp;1 | tee /tmp/devbench.log</code>.
      </div>
    );
  }

  if (visible.length === 0) {
    return <div className="p-4 text-sm text-text-faint">No lines match "{filter}".</div>;
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto font-mono text-xs" data-testid="log-stream">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const l = visible[item.index];
          return (
            <div
              key={l.id}
              data-testid="log-line"
              className="absolute left-0 flex w-full items-baseline gap-2.5 px-3"
              style={{ top: 0, transform: `translateY(${item.start}px)`, height: item.size }}
            >
              <span className="w-24 shrink-0 tabular-nums text-text-faint">{shortTime(l.timestamp)}</span>
              <span className={`w-12 shrink-0 font-bold ${levelClass(l.level)}`}>{l.level ?? ""}</span>
              <span className="truncate text-text">{l.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
