import { readComposerDraft, composerContents, fromSavedRequest, toSavedRequestInput, type ComposerDraft } from "../../lib/apiComposer";
import "./api.css";
import { useEffect, useRef, useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer, type SentRequest } from "./ResponseViewer";
import { SavedRequestsList } from "./SavedRequestsList";
import { useSavedRequests, publishSavedRequestChange } from "./useSavedRequests";
import { HistorySidebar } from "./HistorySidebar";
import { Rollup, type RollupData } from "../rollup/Rollup";
import { useAppStore, type Tab } from "../../store/useAppStore";
import {
  invokeCollectCorrelationWindow,
  invokeCreateSavedRequest,
  invokeUpdateSavedRequest,
  invokeRenameSavedRequest,
  invokeDeleteSavedRequest,
  type SavedRequest,
  type CorrelationResult,
  type FireRequestOutput,
  type HistoryEntry,
  type QualifiedTable,
} from "../../lib/tauri";

interface DisplayResult {
  /** Which send this pane shows. `null` when restored from history. */
  correlationId: string | null;
  response: FireRequestOutput;
  rollup: RollupData;
  /** Only set when restored from History — shows what was actually sent, read-only. */
  sentRequest: SentRequest | null;
}

export function ApiTab({
  tab,
  onPatchState,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
  focusHistoryId,
}: {
  tab: Tab;
  onPatchState: (patch: Record<string, unknown>) => void;
  onOpenDb: (table: QualifiedTable) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
  /** Deep-linked from Email's "Sent by" chip — forwarded to HistorySidebar. */
  focusHistoryId?: string | null;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const watchedTableList = useAppStore((s) => s.watchedTableList);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const draft = readComposerDraft(tab.state);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  function patchDraft(patch: Partial<ComposerDraft>) {
    const next = { ...draftRef.current, ...patch };
    const dirty = draftRef.current.dirty || composerContents(next) !== composerContents(draftRef.current);
    draftRef.current = { ...next, dirty };
    onPatchState({ ...patch, dirty });
  }

  const saved = useSavedRequests(activeSessionId);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const loadEpoch = useRef(0);
  const editorEpoch = loadEpoch.current;
  const saveOperation = useRef<symbol | null>(null);
  const mounted = useRef(true);
  const sessionRef = useRef(activeSessionId);
  sessionRef.current = activeSessionId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const loaded = saved.items.find((request) => request.id === draft.loadedSavedId);
  const loadedName = loaded?.name ?? draft.loadedSavedName ?? "Saved request";

  useEffect(() => {
    if (!draft.loadedSavedId || saved.loading || saved.error || loaded) return;
    // A deleted definition becomes an unsaved draft; keep all user-entered fields.
    const patch = { loadedSavedId: null, loadedSavedName: null, loadedSavedSessionId: null, dirty: true };
    draftRef.current = { ...draftRef.current, ...patch };
    onPatchState(patch);
  }, [draft.loadedSavedId, loaded, saved.loading, saved.error, onPatchState]);

  function loadSavedRequest(request: SavedRequest) {
    loadEpoch.current += 1;
    saveOperation.current = null;
    setSaving(false);
    setSaveError(null);
    const next = fromSavedRequest(request, draftRef.current.activeReqTab);
    draftRef.current = next;
    onPatchState({ ...next });
    setResetKey((key) => key + 1);
    setResult(null);
    setError(null);
    setSending(false);
  }

  async function saveRequest() {
    if (saveOperation.current) return;
    const snapshot = draftRef.current;
    const existing = saved.items.find((request) => request.id === snapshot.loadedSavedId);
    const name = snapshot.loadedSavedId ? (existing?.name ?? snapshot.loadedSavedName ?? "Saved request") : window.prompt("Name this request");
    if (name === null) return;
    if (!name.trim()) { setSaveError("A saved request needs a name."); return; }
    const sourceSession = snapshot.loadedSavedId ? (existing ? existing.session_id : snapshot.loadedSavedSessionId) : activeSessionId;
    const input = toSavedRequestInput(snapshot, name.trim(), sourceSession);
    const epoch = loadEpoch.current;
    const session = activeSessionId;
    const operation = Symbol("save");
    saveOperation.current = operation;
    setSaving(true);
    setSaveError(null);
    const isCurrent = () => mounted.current && sessionRef.current === session && loadEpoch.current === epoch;
    try {
      const request = snapshot.loadedSavedId
        ? await invokeUpdateSavedRequest(snapshot.loadedSavedId, input)
        : await invokeCreateSavedRequest(input);
      publishSavedRequestChange({ kind: "upsert", request });
      if (!isCurrent()) return;
      const patch = { loadedSavedId: request.id, loadedSavedName: request.name, loadedSavedSessionId: request.session_id,
        dirty: composerContents(draftRef.current) !== composerContents(snapshot) };
      draftRef.current = { ...draftRef.current, ...patch };
      onPatchState(patch);
    } catch (error) {
      if (isCurrent()) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current && saveOperation.current === operation) { saveOperation.current = null; setSaving(false); }
    }
  }

  async function renameSavedRequest(request: SavedRequest) {
    const name = window.prompt("Rename saved request", request.name);
    if (name === null) return;
    if (!name.trim()) { setSaveError("A saved request needs a name."); return; }
    const session = activeSessionId;
    try {
      const renamed = await invokeRenameSavedRequest(request.id, name.trim());
      publishSavedRequestChange({ kind: "upsert", request: renamed });
      if (mounted.current && sessionRef.current === session) {
        setSaveError(null);
        if (draftRef.current.loadedSavedId === renamed.id) onPatchState({ loadedSavedName: renamed.name });
      }
    } catch (error) {
      if (mounted.current && sessionRef.current === session) setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteSavedRequest(request: SavedRequest) {
    if (!window.confirm(`Delete saved request “${request.name}”?`)) return;
    const session = activeSessionId;
    try {
      await invokeDeleteSavedRequest(request.id);
      publishSavedRequestChange({ kind: "delete", id: request.id });
      if (mounted.current && sessionRef.current === session) setSaveError(null);
    } catch (error) {
      if (mounted.current && sessionRef.current === session) setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  // The live session. Continuations below closed over an earlier render, so
  // `activeSessionId` there is the send-time value — the other side of the
  // comparison, and the one this ref must not be confused with.
  const activeSessionIdRef = useRef(activeSessionId);

  // The rollup describes one specific request. Leaving it up after a switch
  // would attribute those effects to an investigation whose history list does
  // not even contain the request.
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    setResult(null);
    setError(null);
    setSending(false);
    saveOperation.current = null;
    setSaving(false);
    setSaveError(null);
  }, [activeSessionId]);

  // A send stays outstanding for the whole correlation window (5s default, up
  // to 60), so switching investigation mid-collect is ordinary use. Callers
  // pass their closure's own `activeSessionId`; a shared ref would be
  // overwritten by a second send and let the first one's window through.
  function belongsToCurrentSession(sendSessionId: string | null) {
    return sendSessionId === activeSessionIdRef.current;
  }

  function handleSendStart() {
    setSending(true);
    setResult(null);
    setError(null);
  }

  // Phase 1 landed: paint the response and the DB diffs immediately, then let
  // the correlation window finish in the background and fill in the Log chip.
  async function handleResult(correlation: CorrelationResult) {
    // This render's value, and an in-flight send holds the `onResult` from the
    // render it fired in — so it is the send's session, not the one on screen.
    const sendSessionId = activeSessionId;
    if (!belongsToCurrentSession(sendSessionId) || editorEpoch !== loadEpoch.current) return;
    setSending(false);
    setResult({
      correlationId: correlation.correlation_id,
      response: correlation.response,
      rollup: {
        tableDiffs: correlation.table_diffs,
        watchedTableCount: watchedTables.size,
        logLines: null,
        logLinesTruncated: false,
        emails: null,
        emailsTruncated: false,
        dbError: correlation.db_error,
        windowOpen: true,
      },
      // A live send already shows what is being sent in the composer above.
      sentRequest: null,
    });
    setHistoryRefreshKey((k) => k + 1);

    try {
      const window = await invokeCollectCorrelationWindow(correlation.correlation_id, correlation.history_id);
      // Re-checked after the await: a whole window has passed, so the user may
      // have moved on.
      if (!belongsToCurrentSession(sendSessionId) || editorEpoch !== loadEpoch.current) return;
      setResult((prev) => {
        // The session check can't tell two sends in one session apart, so
        // without this an earlier send's lines merge into a later one's rollup.
        if (prev === null || prev.correlationId !== correlation.correlation_id) return prev;
        return {
          ...prev,
          rollup: {
            ...prev.rollup,
            logLines: window.log_lines,
            logLinesTruncated: window.log_lines_truncated,
            emails: window.emails,
            emailsTruncated: window.emails_truncated,
            windowOpen: false,
          },
        };
      });
    } catch {
      // Uncollectable (app restarted, id expired). Closing it as "not observed"
      // is honest; claiming zero lines would not be. Both guards again — marking
      // a *different* send "not observed" is its own false report.
      if (!belongsToCurrentSession(sendSessionId) || editorEpoch !== loadEpoch.current) return;
      setResult((prev) => {
        if (prev === null || prev.correlationId !== correlation.correlation_id) return prev;
        return { ...prev, rollup: { ...prev.rollup, logLines: null, emails: null, windowOpen: false } };
      });
    }
  }

  function handleError(message: string) {
    // Same misattribution as the success path: the banner would blame the new
    // investigation for the old one's request.
    if (!belongsToCurrentSession(activeSessionId) || editorEpoch !== loadEpoch.current) return;
    setSending(false);
    setError(message);
  }

  function handleHistorySelect(entry: HistoryEntry) {
    setSending(false);
    setError(null);
    setResult({
      // Matches no live id, so an outstanding send cannot fill in a history view.
      correlationId: null,
      response: {
        status_code: entry.status_code,
        headers: entry.response_headers,
        body: entry.response_body,
        duration_ms: entry.duration_ms,
      },
      rollup: {
        tableDiffs: null,
        watchedTableCount: watchedTables.size,
        logLines: null,
        logLinesTruncated: false,
        emails: null,
        emailsTruncated: false,
        dbError: null,
        windowOpen: false,
      },
      sentRequest: {
        method: entry.method,
        url: entry.url,
        headers: entry.request_headers,
        body: entry.request_body,
      },
    });
  }

  return (
    <div className="api-root">
      <div className="api-layout">
        <aside className="api-sidebar" aria-label="Saved requests and history">
          <SavedRequestsList items={saved.items} loading={saved.loading} error={saved.error}
            selectedId={draft.loadedSavedId} sessionId={activeSessionId}
            onSelect={loadSavedRequest} onRename={renameSavedRequest} onDelete={deleteSavedRequest} />
          <HistorySidebar
            onSelect={handleHistorySelect}
            refreshKey={historyRefreshKey}
            sessionId={activeSessionId}
            focusId={focusHistoryId}
          />
        </aside>
        <div className="api-main">
          <div className="api-main-inner">
            {draft.loadedSavedId ? <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-text-muted [overflow-wrap:anywhere]">
              <span>Editing saved request <strong className="font-semibold text-text">{loadedName}</strong></span>
              {draft.dirty ? <span className="text-xs font-semibold text-warning">● unsaved changes</span> : null}
            </div> : null}
            <RequestBuilder
              {...draft}
              connectionId={activeConnectionId}
              watchedTables={watchedTableList}
              sessionId={activeSessionId}
              onPatchState={patchDraft}
              resetKey={resetKey}
              onSave={saveRequest}
              saving={saving}
              onSendStart={handleSendStart}
              onResult={handleResult}
              onError={handleError}
            />
            {saveError ? <div role="alert" className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger [overflow-wrap:anywhere]">{saveError}</div> : null}
            {error ? (
              <div role="alert" className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger [overflow-wrap:anywhere]">{error}</div>
            ) : null}
            <ResponseViewer result={result?.response ?? null} sentRequest={result?.sentRequest ?? null} />
            {result || sending ? (
              <div>
                <div className="m-0.5 text-[11.5px] font-bold uppercase tracking-wide text-text-faint">
                  What happened
                </div>
                <div className="rounded-lg border border-border bg-surface">
                  <Rollup data={result?.rollup ?? null} loading={sending} onOpenDb={onOpenDb} onOpenLog={onOpenLog} onOpenEmail={onOpenEmail} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
