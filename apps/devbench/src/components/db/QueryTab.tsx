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

/** Exported for the browser gate, which measures the grip against these
 * rather than trusting the CSS. */
export const MIN_EDITOR_PX = 90;
export const MAX_EDITOR_PX = 560;
const DEFAULT_EDITOR_PX = 220;
/** Matches useTabController's own write debounce. */
const WRITE_DEBOUNCE_MS = 300;

export function QueryTab({
  tab,
  onOpenQuery,
  onCloseQueryTabs,
  watchedTables,
  onToggleWatch,
}: {
  tab: Tab;
  onOpenQuery: (queryId: string) => void;
  onCloseQueryTabs: (queryId: string) => void;
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
}) {
  const queryId = typeof tab.state.queryId === "string" ? tab.state.queryId : null;
  // PINNED is the document's identity — captured at open, never patched, and what
  // this query RUNS against. ACTIVE is only where the rail is browsing.
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
  // Captured at run time, not re-read from `query.sql`: staging off the live field
  // would record an effect for a statement never previewed.
  const [result, setResult] = useState<{ preview: QueryPreview; statement: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Set only when the automatic rollback FAILED: the transaction is gone and the
  // statement may have committed, so this replaces the "rolled back" reassurance.
  const [rollbackFailure, setRollbackFailure] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

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

  // Drops only the trailing persist; the keystrokes are already in the store.
  useEffect(() => {
    const timers = writeTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  function onNameChange(name: string) {
    if (!queryId) return;
    // Store first, synchronously: the label reads out of the store, and nothing may
    // write back into the field the caret is sitting in.
    patchSavedQuery(queryId, { name });
    debouncedWrite("name", () => invokeRenameSavedQuery(queryId, name));
  }

  function onSqlChange(sql: string) {
    if (!queryId) return;
    patchSavedQuery(queryId, { sql });
    // A result describes the statement that produced it, so editing the SQL makes it
    // stale — otherwise Add to pending could record an effect this statement never had.
    setResult(null);
    setRunError(null);
    setRollbackFailure(null);
    debouncedWrite("sql", () => invokeSetSavedQuerySql(queryId, sql));
  }

  /** Bare phrase: PendingPanel owns the "when run" suffix at render time. */
  function effectLabel(n: number): string {
    return `${n} row${n === 1 ? "" : "s"} affected`;
  }

  async function run() {
    // pinnedConnectionId, never activeConnectionId: a query runs against the
    // connection it was written for, whatever the rail is browsing.
    if (running || !pinnedConnectionId || !query) return;
    const statement = query.sql;
    setRunError(null);
    setResult(null);
    setRollbackFailure(null);
    setRunning(true);
    try {
      const preview = await invokePreviewQuery(pinnedConnectionId, statement);
      // §15: rolled back in the continuation that received it, so no lock is held while
      // the user decides. A FAILED rollback means the statement may have committed —
      // never tell the user nothing was written when we cannot prove it.
      void invokeRollbackPreview(preview.preview_id).catch((err) =>
        setRollbackFailure(err instanceof Error ? err.message : String(err)),
      );
      setResult({ preview, statement });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  function stage() {
    if (!pinnedConnectionId || !result || result.preview.rows_affected == null) return;
    if (rollbackFailure) return;
    addPendingSql(pinnedConnectionId, result.statement, effectLabel(result.preview.rows_affected));
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
        onCloseQueryTabs={onCloseQueryTabs}
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
            <span aria-hidden="true" className="inline-flex">
              <PlayIcon />
            </span>
            <span>Run query</span>
            <span aria-hidden="true" className="text-[10.5px] font-semibold opacity-70">⌘⏎</span>
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
                // This tab stages against its PINNED connection; PendingPanel and Apply are
                // scoped to the ACTIVE one.
                if (pinnedConnectionId) setActiveConnectionId(pinnedConnectionId);
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
              {rollbackFailure ? (
                <div className="flex items-start gap-2 rounded-lg border border-border bg-danger-bg p-2.5 text-xs text-danger">
                  <span className="shrink-0 rounded-full bg-danger px-2 py-0.5 font-bold text-accent-on">RAN</span>
                  <span>
                    this run's transaction could not be rolled back, so whether the statement was
                    written is unknown — check the database before doing anything else. Staging is
                    blocked until you run again. ({rollbackFailure})
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-text-faint">
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 font-bold text-text-faint">RAN</span>
                  <span>
                    ran in a transaction that was rolled back — nothing is written unless you add it to
                    Pending and Apply
                  </span>
                </div>
              )}
              {result.preview.rows_affected === null ? (
                <DataGrid columns={result.preview.columns} rows={result.preview.rows} />
              ) : (
                <div className="text-xs text-text-faint">
                  {result.preview.rows_affected} row{result.preview.rows_affected === 1 ? "" : "s"} affected
                  — no rows returned.
                </div>
              )}
              {/* 28px, set by the row rather than by each button (§14). */}
              <div className="flex justify-end gap-2">
                <SecondaryButton className="h-7" onClick={() => setResult(null)}>
                  Discard
                </SecondaryButton>
                <button
                  type="button"
                  disabled={result.preview.rows_affected === null || rollbackFailure !== null}
                  onClick={stage}
                  title={
                    rollbackFailure !== null
                      ? "This run's transaction could not be rolled back, so its effect is unknown. Run it again before staging anything."
                      : result.preview.rows_affected === null
                        ? "Only a statement that reported an affected row count can be staged."
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
