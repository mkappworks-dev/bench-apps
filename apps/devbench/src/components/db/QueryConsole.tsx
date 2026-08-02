import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { DataGrid } from "./DataGrid";
import { invokeCommitPreview, invokePreviewQuery, invokeRollbackPreview, type QueryPreview } from "../../lib/tauri";

const DEFAULT_HEIGHT_PX = 220;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 560;

type Phase = "idle" | "preview" | "committed";

function isExpiredPreviewError(message: string): boolean {
  return message.includes("no open preview");
}

export function QueryConsole({ connectionId }: { connectionId: string }) {
  const [sql, setSql] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<QueryPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT_PX);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  // Bumped whenever the preview/request currently in view stops being the
  // one a landing response should apply to (SQL edited, or the console
  // itself unmounted). Continuations capture this before their `await` and
  // compare it after — same shape as DbTab's editGenerationRef, applied to a
  // console instead of a single cell.
  const generationRef = useRef(0);

  // Mirrors phase/preview/pending for the unmount cleanup below, which reads
  // stale closure values otherwise (an effect with a `[]` dep array only
  // ever sees the state from its first render).
  const stateRef = useRef({ phase, preview, pending });
  useEffect(() => {
    stateRef.current = { phase, preview, pending };
  }, [phase, preview, pending]);

  // Closing the drawer unmounts this component (DbTab renders it only while
  // consoleOpen). An uncommitted preview left open at that moment holds a
  // real transaction and row lock — the same hazard Task 12 hit for
  // abandoned cell edits — so it gets rolled back here rather than left for
  // the sweep's full ~2-minute window. A commit/rollback already in flight
  // (`pending`) owns deciding that preview's fate already; racing it with a
  // second rollback here would be redundant, not protective.
  useEffect(() => {
    return () => {
      generationRef.current++;
      const { phase, preview, pending } = stateRef.current;
      if (phase === "preview" && preview && !pending) {
        void invokeRollbackPreview(preview.preview_id).catch(() => {});
      }
    };
  }, []);

  function onHandleMouseMove(e: MouseEvent) {
    if (!dragState.current) return;
    const dy = dragState.current.startY - e.clientY;
    setHeight(Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, dragState.current.startHeight + dy)));
  }

  function onHandleMouseUp() {
    dragState.current = null;
    window.removeEventListener("mousemove", onHandleMouseMove);
    window.removeEventListener("mouseup", onHandleMouseUp);
  }

  function onHandleMouseDown(e: ReactMouseEvent) {
    dragState.current = { startY: e.clientY, startHeight: height };
    window.addEventListener("mousemove", onHandleMouseMove);
    window.addEventListener("mouseup", onHandleMouseUp);
  }

  function onSqlChange(value: string) {
    setSql(value);
    generationRef.current++;
    setPhase("idle");
    setPreview(null);
    setError(null);
    // Deliberately does not roll back a materialized preview here: the
    // transaction stays open (and will still expire via the sweep) — this
    // console just has no way back to that preview_id once the SQL it
    // previewed has changed. Contrast with the unmount cleanup above, which
    // does roll back, because closing the drawer is the point past which
    // nothing could ever act on that preview_id again.
  }

  async function runPreview() {
    if (pending) return;
    // Re-running Preview (e.g. same SQL, clicked again) abandons whatever
    // was previously materialized here — unlike a text edit, it's being
    // immediately replaced by a fresh request, so there's no reason to
    // leave the old transaction open for the sweep.
    if (phase === "preview" && preview) {
      void invokeRollbackPreview(preview.preview_id).catch(() => {});
    }
    generationRef.current++;
    const generation = generationRef.current;
    setError(null);
    setPending(true);
    try {
      const result = await invokePreviewQuery(connectionId, sql);
      if (generation !== generationRef.current) {
        // The SQL changed or the console unmounted while this was in
        // flight — nobody's watching this preview_id. Roll it back
        // immediately rather than leak it for the sweep's window.
        void invokeRollbackPreview(result.preview_id).catch(() => {});
        return;
      }
      setPreview(result);
      setPhase("preview");
      setPending(false);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }

  async function commit() {
    if (phase !== "preview" || !preview || pending) return;
    const generation = generationRef.current;
    const target = preview;
    setError(null);
    setPending(true);
    try {
      await invokeCommitPreview(target.preview_id);
    } catch (err) {
      if (generation !== generationRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(
        isExpiredPreviewError(message)
          ? "This preview expired before you committed it (previews auto-expire after 2 minutes) — nothing was written. Preview again to retry."
          : `Commit failed — nothing was written: ${message}`,
      );
      // The preview_id is unusable regardless of which branch failed (sqlx
      // consumes the transaction on both a successful and a failed commit).
      setPhase("idle");
      setPreview(null);
      setPending(false);
      return;
    }
    if (generation !== generationRef.current) {
      // The write committed for real and can't be undone — but there's no
      // live console left in this generation to show that against, so
      // there's nothing further to reconcile locally.
      return;
    }
    setPhase("committed");
    setPending(false);
  }

  async function rollback() {
    if (phase !== "preview" || !preview || pending) return;
    const generation = generationRef.current;
    const target = preview;
    setPending(true);
    try {
      await invokeRollbackPreview(target.preview_id);
    } catch (err) {
      if (generation === generationRef.current) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isExpiredPreviewError(message)) setError(message);
      }
    }
    if (generation !== generationRef.current) return;
    setPhase("idle");
    setPreview(null);
    setPending(false);
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-surface" style={{ height }}>
      <div
        onMouseDown={onHandleMouseDown}
        className="flex h-3.5 shrink-0 cursor-row-resize items-center justify-center"
        aria-label="Resize query console"
        role="separator"
        aria-orientation="horizontal"
      >
        <div className="h-1 w-9 rounded-full bg-border" aria-hidden />
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wide text-text-faint">Query console</span>
        <span className="text-[11px] text-text-faint">— single statement per run</span>
        <button
          type="button"
          disabled={pending}
          onClick={() => void runPreview()}
          className="ml-auto rounded-sm bg-accent px-3 py-1 text-xs font-bold text-accent-on disabled:opacity-50"
        >
          Preview
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        <textarea
          value={sql}
          onChange={(e) => onSqlChange(e.target.value)}
          placeholder="SELECT * FROM orders LIMIT 10;"
          className="min-h-14 rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-sm text-text"
        />
        {error ? <div className="text-xs text-danger">{error}</div> : null}
        {phase === "preview" && preview ? (
          <>
            <div className="flex items-center gap-2 text-xs text-text-faint">
              <span className="rounded-full bg-surface-2 px-2 py-0.5 font-bold text-text-faint">PREVIEW</span>
              <span>held in an open transaction — not yet committed</span>
            </div>
            {preview.rows_affected === null ? (
              <DataGrid columns={preview.columns} rows={preview.rows} />
            ) : (
              <div className="text-xs text-text-faint">
                {preview.rows_affected} row{preview.rows_affected === 1 ? "" : "s"} affected — no rows returned.
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => void rollback()}
                className="rounded-sm border border-border px-3 py-1.5 text-xs text-text-muted disabled:opacity-50"
              >
                Rollback
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void commit()}
                className="rounded-sm bg-accent px-3 py-1.5 text-xs font-bold text-accent-on disabled:opacity-50"
              >
                Commit
              </button>
            </div>
          </>
        ) : null}
        {phase === "committed" && preview ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-success-bg px-2 py-0.5 font-bold text-success">✓ COMMITTED</span>
            <span className="text-text-faint">
              {preview.rows_affected === null
                ? `${preview.rows.length} row${preview.rows.length === 1 ? "" : "s"}`
                : `${preview.rows_affected} row${preview.rows_affected === 1 ? "" : "s"} affected`}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
