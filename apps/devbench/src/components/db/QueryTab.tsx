import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ConnectionRail } from "./ConnectionRail";
import { DataGrid } from "./DataGrid";
import { SecondaryButton } from "../ui/SecondaryButton";
import { useAppStore, type Tab } from "../../store/useAppStore";
import { savedQueryById } from "../../lib/savedQueries";
import {
  invokePreviewQuery,
  invokeRenameSavedQuery,
  invokeRollbackPreview,
  invokeSetSavedQuerySql,
  type QualifiedTable,
  type QueryPreview,
} from "../../lib/tauri";

/** §3b's range for the editor. Exported for the browser gate, which measures
 *  the grip against them rather than trusting the CSS. */
export const MIN_EDITOR_PX = 90;
export const MAX_EDITOR_PX = 560;
const DEFAULT_EDITOR_PX = 220;
/** Matches useTabController's own write debounce; a query's name and SQL are
 *  the same kind of thing as tab state — typed continuously, persisted
 *  occasionally. */
const WRITE_DEBOUNCE_MS = 300;

export function QueryTab({
  tab,
  onOpenQuery,
  watchedTables,
  onToggleWatch,
}: {
  tab: Tab;
  onOpenQuery: (queryId: string) => void;
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
}) {
  const queryId = typeof tab.state.queryId === "string" ? tab.state.queryId : null;
  // Two connections, deliberately distinct (settled in Task 5). PINNED is part
  // of the document's identity: captured at open, never patched, and what this
  // query RUNS against. ACTIVE is only where the rail is browsing, which the
  // user may move without retargeting this tab.
  const pinnedConnectionId = typeof tab.state.connectionId === "string" ? tab.state.connectionId : null;
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const savedQueries = useAppStore((s) => s.savedQueries);
  const patchSavedQuery = useAppStore((s) => s.patchSavedQuery);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const pending = useAppStore((s) => s.pending);
  const dockPanel = useAppStore((s) => s.dockPanel);
  const setDockPanel = useAppStore((s) => s.setDockPanel);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const addPendingSql = useAppStore((s) => s.addPendingSql);
  const query = savedQueryById(savedQueries, queryId);

  const [editorHeight, setEditorHeight] = useState(DEFAULT_EDITOR_PX);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);
  const writeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [result, setResult] = useState<QueryPreview | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // One timer per field, keyed, so renaming does not cancel a pending SQL
  // write or vice versa.
  function debouncedWrite(key: string, write: () => Promise<unknown>) {
    const existing = writeTimers.current.get(key);
    if (existing !== undefined) clearTimeout(existing);
    writeTimers.current.set(
      key,
      setTimeout(() => {
        writeTimers.current.delete(key);
        void write().catch(() => {});
      }, WRITE_DEBOUNCE_MS),
    );
  }

  // A tab closed mid-debounce would otherwise fire a write against an
  // unmounted component. The keystrokes are already in the store either way;
  // this only drops the trailing persist, which the next edit re-schedules.
  useEffect(() => {
    const timers = writeTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  function onNameChange(name: string) {
    if (!queryId) return;
    // Store first, synchronously: the tab label reads out of the store, so
    // this is what makes the label track the field without anything writing
    // back into the field the caret is sitting in.
    patchSavedQuery(queryId, { name });
    debouncedWrite("name", () => invokeRenameSavedQuery(queryId, name));
  }

  function onSqlChange(sql: string) {
    if (!queryId) return;
    patchSavedQuery(queryId, { sql });
    debouncedWrite("sql", () => invokeSetSavedQuerySql(queryId, sql));
  }

  /** §12: the effect the run reported, carried into the pending entry so a
   *  divergence at Apply is visible rather than silent. Only ever built for a
   *  statement that reported a count — a SELECT cannot be staged. */
  function effectLabel(n: number): string {
    return `${n} row${n === 1 ? "" : "s"} affected when run`;
  }

  async function run() {
    // pinnedConnectionId, never activeConnectionId: a query runs against the
    // connection it was written for, whatever the rail happens to be browsing.
    if (running || !pinnedConnectionId || !query) return;
    setRunError(null);
    setResult(null);
    setRunning(true);
    try {
      const preview = await invokePreviewQuery(pinnedConnectionId, query.sql);
      // Rolled back here, in the continuation that received it — not on a
      // later click and not in an unmount cleanup. Nothing holds a lock while
      // the user decides, and an unmount mid-flight still lands here because
      // this chain is not tied to React's lifecycle. What gets staged is the
      // STATEMENT; Apply re-runs it (§12), so this transaction has no future.
      void invokeRollbackPreview(preview.preview_id).catch(() => {});
      setResult(preview);
    } catch (err) {
      // A failed preview_query never returned a preview_id — there is no
      // transaction of ours to roll back.
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  function stage() {
    if (!pinnedConnectionId || !query || result?.rows_affected == null) return;
    addPendingSql(pinnedConnectionId, query.sql, effectLabel(result.rows_affected));
    setResult(null);
  }

  function onGripMouseMove(e: MouseEvent) {
    if (!dragState.current) return;
    const dy = e.clientY - dragState.current.startY;
    setEditorHeight(
      Math.min(MAX_EDITOR_PX, Math.max(MIN_EDITOR_PX, dragState.current.startHeight + dy)),
    );
  }

  function onGripMouseUp() {
    dragState.current = null;
    window.removeEventListener("mousemove", onGripMouseMove);
    window.removeEventListener("mouseup", onGripMouseUp);
  }

  function onGripMouseDown(e: ReactMouseEvent) {
    dragState.current = { startY: e.clientY, startHeight: editorHeight };
    window.addEventListener("mousemove", onGripMouseMove);
    window.addEventListener("mouseup", onGripMouseUp);
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0">
      <ConnectionRail
        connectionId={activeConnectionId}
        selected={null}
        watchedTables={watchedTables}
        onToggleWatch={onToggleWatch}
        onSelectTable={() => {}}
        onConnectionChange={setActiveConnectionId}
        initialSegment="queries"
        activeQueryId={queryId}
        onOpenQuery={onOpenQuery}
      />
      {/* The tint lives on the pane's chrome. The editor and results below
          re-assert --bg, because what you write and what comes back are
          ordinary content (§3b). */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-query-tint">
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border pl-3 pr-2.5">
          {/* Run leads, the name follows: on a tab whose purpose is executing
              something, the action is the subject. */}
          <button
            type="button"
            disabled={running || !pinnedConnectionId}
            onClick={() => void run()}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm bg-accent px-3 text-xs font-bold text-accent-on transition-opacity duration-150 disabled:opacity-50"
          >
            <PlayIcon />
            <span>Run query</span>
            <span className="text-[10.5px] font-semibold opacity-70">⌘⏎</span>
          </button>
          <input
            aria-label="Query name"
            spellCheck={false}
            value={query?.name ?? ""}
            onChange={(e) => onNameChange(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-2 text-[13.5px] font-semibold text-text outline-none hover:border-border focus:border-text-faint focus:bg-bg"
          />
          {pending.length > 0 ? (
            <SecondaryButton
              className="h-7 gap-1.5"
              aria-pressed={dockPanel === "pending"}
              onClick={() => {
                setDockPanel("pending");
                setChatOpen(true);
              }}
            >
              <span>Pending</span>
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-lg bg-accent px-1 text-[10.5px] font-bold text-accent-on">
                {pending.length}
              </span>
            </SecondaryButton>
          ) : null}
        </div>

        {/* Full bleed: the editor is the content of this pane, not a field
            sitting inside it, so it runs edge to edge with no gutter. */}
        <div className="relative shrink-0 border-b border-border bg-bg" style={{ height: editorHeight }}>
          <textarea
            aria-label="SQL"
            spellCheck={false}
            value={query?.sql ?? ""}
            onChange={(e) => onSqlChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run();
              }
            }}
            className="block h-full w-full resize-none border-0 bg-transparent px-3.5 pb-5 pt-3 font-mono text-xs leading-[1.6] text-text outline-none"
          />
          {/* Full-width hit zone, small centred grip: the affordance reads as
              "bottom middle", not a bar spanning the pane. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize query editor"
            onMouseDown={onGripMouseDown}
            className="group absolute inset-x-0 bottom-0 flex h-3.5 cursor-row-resize items-center justify-center"
          >
            <div className="h-1 w-9 rounded-full bg-border transition-colors duration-150 group-hover:bg-text-faint" aria-hidden />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto bg-bg px-3.5 py-3">
          {runError ? <div className="text-xs text-danger">{runError}</div> : null}
          {result ? (
            <>
              <div className="flex items-center gap-2 text-xs text-text-faint">
                <span className="rounded-full bg-surface-2 px-2 py-0.5 font-bold text-text-faint">RAN</span>
                <span>
                  ran in a transaction that was rolled back — nothing is written unless you add it to
                  Pending and Apply
                </span>
              </div>
              {result.rows_affected === null ? (
                <DataGrid columns={result.columns} rows={result.rows} />
              ) : (
                <div className="text-xs text-text-faint">
                  {result.rows_affected} row{result.rows_affected === 1 ? "" : "s"} affected — no rows
                  returned.
                </div>
              )}
              {/* 28px, set by the row rather than by each button (§14). */}
              <div className="flex justify-end gap-2">
                <SecondaryButton className="h-7" onClick={() => setResult(null)}>
                  Discard
                </SecondaryButton>
                <button
                  type="button"
                  disabled={result.rows_affected === null}
                  onClick={stage}
                  title={
                    result.rows_affected === null
                      ? "Re-running a query that returns rows writes nothing, so there is nothing to stage."
                      : undefined
                  }
                  className="inline-flex h-7 items-center rounded-sm bg-accent px-3 text-xs font-bold text-accent-on disabled:opacity-50"
                >
                  Add to pending
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}
