import { useEffect, useRef, useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { HistorySidebar } from "./HistorySidebar";
import { Rollup, type RollupData } from "../rollup/Rollup";
import { useAppStore } from "../../store/useAppStore";
import {
  invokeCollectCorrelationWindow,
  type CorrelationResult,
  type DbConnectInput,
  type FireRequestOutput,
  type HistoryEntry,
} from "../../lib/tauri";

const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

interface DisplayResult {
  /** Which send this pane shows. `null` when restored from history. */
  correlationId: string | null;
  response: FireRequestOutput;
  rollup: RollupData;
}

export function ApiTab({
  onOpenTableInDb,
  onOpenEmail,
}: {
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (emailId: number | null) => void;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

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
    if (!belongsToCurrentSession(sendSessionId)) return;
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
    });
    setHistoryRefreshKey((k) => k + 1);

    try {
      const window = await invokeCollectCorrelationWindow(correlation.correlation_id, correlation.history_id);
      // Re-checked after the await: a whole window has passed, so the user may
      // have moved on.
      if (!belongsToCurrentSession(sendSessionId)) return;
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
      if (!belongsToCurrentSession(sendSessionId)) return;
      setResult((prev) => {
        if (prev === null || prev.correlationId !== correlation.correlation_id) return prev;
        return { ...prev, rollup: { ...prev.rollup, logLines: null, emails: null, windowOpen: false } };
      });
    }
  }

  function handleError(message: string) {
    // Same misattribution as the success path: the banner would blame the new
    // investigation for the old one's request.
    if (!belongsToCurrentSession(activeSessionId)) return;
    setSending(false);
    setError(message);
  }

  function handleHistorySelect(entry: HistoryEntry) {
    setSending(false);
    setError(null);
    setResult({
      // Matches no live id, so an outstanding send cannot fill in a history view.
      correlationId: null,
      response: { status_code: entry.status_code, body: entry.response_body, duration_ms: entry.duration_ms },
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
    });
  }

  function handleOpenDb(table: string) {
    setActiveTab("db");
    onOpenTableInDb(table);
  }

  function handleOpenEmail(emailId: number | null) {
    setActiveTab("email");
    onOpenEmail(emailId);
  }

  return (
    <div className="-m-6 flex h-full">
      <HistorySidebar
        onSelect={handleHistorySelect}
        refreshKey={historyRefreshKey}
        sessionId={activeSessionId}
      />
      <div className="mx-auto flex max-w-180 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <RequestBuilder
          connection={DEV_CONNECTION}
          watchedTables={watchedTables}
          sessionId={activeSessionId}
          onSendStart={handleSendStart}
          onResult={handleResult}
          onError={handleError}
        />
        {error ? (
          <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
        ) : null}
        <ResponseViewer result={result?.response ?? null} />
        {result || sending ? (
          <div>
            <div className="m-0.5 text-[11.5px] font-bold uppercase tracking-wide text-text-faint">
              What happened
            </div>
            <div className="rounded-lg border border-border bg-surface">
              <Rollup
                data={result?.rollup ?? null}
                loading={sending}
                onOpenDb={handleOpenDb}
                onOpenLog={() => setActiveTab("log")}
                onOpenEmail={handleOpenEmail}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
