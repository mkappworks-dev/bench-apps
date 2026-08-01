import { useCallback, useEffect, useRef, useState } from "react";
import { LogSourcesSidebar } from "./LogSourcesSidebar";
import { AddLogSourceForm } from "./AddLogSourceForm";
import { LogStream } from "./LogStream";
import {
  invokeAddLogSource,
  invokeListLogSources,
  invokeReadLogLines,
  invokeRemoveLogSource,
  type LogLine,
  type LogSourceStatus,
} from "../../lib/tauri";

/** How often the frontend drains newly-tailed lines from the Rust buffer. */
const POLL_INTERVAL_MS = 500;
/** How many lines the UI keeps rendered. Matches the Rust buffer's own cap. */
const MAX_RENDERED_LINES = 5_000;

export function LogTab({
  sourceId,
  onPatchState,
}: {
  sourceId: string | null;
  onPatchState: (patch: { sourceId: string | null }) => void;
}) {
  const [sources, setSources] = useState<LogSourceStatus[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const afterIdRef = useRef(0);

  const refreshSources = useCallback(async () => {
    try {
      setSources(await invokeListLogSources());
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  // Changing the source filter restarts the read cursor so the pane shows that
  // source's buffered history rather than only what arrives from now on.
  useEffect(() => {
    afterIdRef.current = 0;
    setLines([]);
    setDropped(0);
  }, [sourceId]);

  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const page = await invokeReadLogLines({
          afterId: afterIdRef.current,
          sourceId: sourceId ?? undefined,
          limit: 500,
        });
        if (cancelled) return;
        if (page.dropped > 0) setDropped((d) => d + page.dropped);
        if (page.lines.length > 0) {
          afterIdRef.current = page.next_id;
          setLines((prev) => [...prev, ...page.lines].slice(-MAX_RENDERED_LINES));
        }
      } catch {
        // A transient IPC failure is not worth tearing the pane down; the next
        // tick retries. Source-level failures surface via `source.error`.
      }
    }, POLL_INTERVAL_MS);
    void refreshSources();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sourceId, refreshSources]);

  async function handleAdd(input: { label: string; path: string }) {
    setAddError(null);
    try {
      await invokeAddLogSource(input.label, input.path);
      setShowAdd(false);
      await refreshSources();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemove(id: string) {
    try {
      await invokeRemoveLogSource(id);
      if (sourceId === id) onPatchState({ sourceId: null });
      await refreshSources();
    } catch {
      await refreshSources();
    }
  }

  return (
    <div className="-m-6 flex h-full">
      <LogSourcesSidebar
        sources={sources}
        activeSourceId={sourceId}
        onSelect={(id) => onPatchState({ sourceId: id })}
        onRemove={handleRemove}
        onAdd={() => setShowAdd(true)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {showAdd ? (
          <AddLogSourceForm onSubmit={handleAdd} onCancel={() => setShowAdd(false)} error={addError} />
        ) : null}
        <div className="flex items-center gap-2 border-b border-border p-2.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-sm text-text"
          />
          <span className="text-xs font-semibold text-text-muted">
            {sources.some((s) => s.state === "live") ? "Live" : "Idle"}
          </span>
        </div>
        {dropped > 0 ? (
          <div className="border-b border-border bg-warning-bg px-3 py-1.5 text-xs text-warning">
            {dropped} earlier line{dropped === 1 ? "" : "s"} scrolled out of the buffer and are not shown.
          </div>
        ) : null}
        <div className="flex-1 overflow-hidden">
          <LogStream lines={lines} filter={filter} />
        </div>
      </div>
    </div>
  );
}
