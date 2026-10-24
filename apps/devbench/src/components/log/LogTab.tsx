import { useCallback, useEffect, useRef, useState } from "react";
import { LogSourcesSidebar } from "./LogSourcesSidebar";
import { AddLogSourcePopup, LOG_SOURCE_OPTIONS, type AddSourceKind } from "./AddLogSourcePopup";
import { Menu } from "../ui/Menu";
import { LogIcon } from "./LogIcon";
import "./log.css";
import { LogStream } from "./LogStream";
import { LevelChips } from "./LevelChips";
import { SearchBar, type SearchQuery } from "./SearchBar";
import { SearchResults } from "./SearchResults";
import {
  invokeAddLogSource,
  invokeListLogSources,
  invokeReadLogLines,
  invokeRemoveLogSource,
  invokeSearchLogLines,
  type AddLogSourceInput,
  type LogLine,
  type LogSourceStatus,
} from "../../lib/tauri";

/** How often the frontend drains newly-tailed lines from the Rust buffer. */
const POLL_INTERVAL_MS = 500;
/** How many lines the UI keeps rendered. Matches the Rust buffer's own cap. */
const MAX_RENDERED_LINES = 5_000;
const SEARCH_LIMIT = 500;

const EMPTY_SEARCH: SearchQuery = { query: "", level: "", afterMs: null, beforeMs: null };

export function LogTab({
  sourceId,
  mode,
  onPatchState,
}: {
  sourceId: string | null;
  mode: "live" | "search";
  onPatchState: (patch: Record<string, unknown>) => void;
}) {
  const [sources, setSources] = useState<LogSourceStatus[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [levels, setLevels] = useState<string[]>([]);
  const [addKind, setAddKind] = useState<AddSourceKind | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [search, setSearch] = useState<SearchQuery>(EMPTY_SEARCH);
  const [results, setResults] = useState<LogLine[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
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
    // Search mode reads SQLite on demand; polling the live buffer behind it
    // would burn IPC for a view nobody is looking at.
    if (mode !== "live") return;
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
  }, [sourceId, mode, refreshSources]);

  async function handleAdd(input: AddLogSourceInput) {
    setAddError(null);
    try {
      await invokeAddLogSource(input);
      setAddKind(null);
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

  async function runSearch() {
    setSearching(true);
    setSearchError(null);
    try {
      const found = await invokeSearchLogLines({
        query: search.query.trim() || undefined,
        level: search.level || undefined,
        sourceId: sourceId ?? undefined,
        afterMs: search.afterMs ?? undefined,
        beforeMs: search.beforeMs ?? undefined,
        limit: SEARCH_LIMIT,
      });
      setResults(found);
    } catch (err) {
      setResults([]);
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearched(true);
      setSearching(false);
    }
  }

  function toggleLevel(level: string) {
    setLevels((prev) => (prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]));
  }

  const live = sources.some((source) => source.state === "live" && (sourceId === null || source.id === sourceId));

  return (
    <div className="log-tool -m-6">
      <LogSourcesSidebar sources={sources} activeSourceId={sourceId}
        onSelect={(id) => onPatchState({ sourceId: id })} onRemove={handleRemove} onAdd={() => setAddKind("file")}
        addControl={<Menu label="Add log source" options={LOG_SOURCE_OPTIONS} onSelect={(kind) => { setAddError(null); setAddKind(kind as AddSourceKind); }}
          triggerClassName="log-icon-button" trigger={<LogIcon name="plus" />} />}
        addForm={addKind ? <AddLogSourcePopup key={addKind} initialKind={addKind} onSubmit={handleAdd} onCancel={() => setAddKind(null)} error={addError} /> : null}
      />
      <div className="log-main">
        <div className="log-toolbar">
          {mode === "live" ? (
            <>
              <input aria-label="Filter live logs" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="log-control log-live-filter" />
              <LevelChips selected={levels} onToggle={toggleLevel} />
            </>
          ) : <span className="log-history-label">Persisted history</span>}
          <div className="log-toolbar-end">
            <div className="log-mode-switch" role="group" aria-label="Log mode">
              <ModeButton mode="live" current={mode} onSelect={onPatchState} label="Live" />
              <ModeButton mode="search" current={mode} onSelect={onPatchState} label="Search" />
            </div>
            {mode === "live" ? <span className="log-live-indicator" role="status"><span className={`log-live-dot ${live ? "is-live" : ""}`} />{live ? "Live" : "Idle"}</span> : null}
          </div>
        </div>
        {mode === "live" ? (
          <>
            {dropped > 0 ? <div className="border-b border-border bg-warning-bg px-3 py-1.5 text-xs text-warning">{dropped} earlier line{dropped === 1 ? "" : "s"} scrolled out of the buffer and are not shown.</div> : null}
            <div className="min-h-0 flex-1 overflow-hidden"><LogStream lines={lines} filter={filter} levels={levels} /></div>
          </>
        ) : (
          <>
            <SearchBar value={search} onChange={setSearch} onSubmit={runSearch} busy={searching} />
            <div className="min-h-0 flex-1 overflow-hidden"><SearchResults lines={results} sources={sources} searched={searched} error={searchError} /></div>
          </>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  mode,
  current,
  onSelect,
  label,
}: {
  mode: "live" | "search";
  current: "live" | "search";
  onSelect: (patch: Record<string, unknown>) => void;
  label: string;
}) {
  const active = current === mode;
  return (
    <button
      onClick={() => onSelect({ mode })}
      aria-pressed={active}
      // Search mode also renders a "Search" submit button; naming the toggle
      // "<mode> mode" keeps the two apart for assistive tech.
      aria-label={`${label} mode`}
      className="log-mode-button"
    >
      {label}
    </button>
  );
}
