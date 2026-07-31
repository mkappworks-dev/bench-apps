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

  // The current session, as a ref. The continuations below closed over an
  // earlier render, so reading `activeSessionId` there yields the value at send
  // time — which is exactly what we want for one side of the comparison, and
  // exactly what we must not use for the other. This ref is the live side.
  const activeSessionIdRef = useRef(activeSessionId);

  // Switching investigations must not leave the previous session's response
  // and rollup on screen. The rollup describes what one specific request
  // caused; keeping it visible beside a history list that no longer contains
  // that request attributes those effects to the wrong investigation.
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    setResult(null);
    setError(null);
    // Also drop the in-flight indicator. The send itself is abandoned below, so
    // leaving this true would strand the new session on a rollup skeleton that
    // nothing will ever fill in.
    setSending(false);
  }, [activeSessionId]);

  /**
   * A correlated send is not a tight race: it stays outstanding for the whole
   * correlation window — 5s by default, configurable to 60 — so firing a
   * request and then switching investigation while it collects is ordinary
   * use, not an edge case. Anything arriving for a session we have left
   * describes an investigation the user is no longer in, and is dropped.
   *
   * `sendSessionId` must be each send's *own* session, so callers pass the
   * `activeSessionId` their closure captured rather than reading a shared ref:
   * a second send would overwrite a single mutable slot, and the first send's
   * late window would then sail through the guard.
   */
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
    // `activeSessionId` here is this render's value, and an in-flight send
    // holds the `onResult` from the render it was fired in — so this is the
    // session the request belongs to, not the one on screen now.
    const sendSessionId = activeSessionId;
    if (!belongsToCurrentSession(sendSessionId)) return;
    setSending(false);
    setResult({
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
      const window = await invokeCollectCorrelationWindow(correlation.correlation_id);
      // Re-checked after the await, not just before it: this continuation lands
      // a full correlation window later, and by then `prev` may be a different
      // request's result in a different session. Splicing these log lines and
      // emails into it would attribute one investigation's side effects to
      // another request entirely.
      if (!belongsToCurrentSession(sendSessionId)) return;
      setResult((prev) =>
        prev
          ? {
              ...prev,
              rollup: {
                ...prev.rollup,
                logLines: window.log_lines,
                logLinesTruncated: window.log_lines_truncated,
                emails: window.emails,
                emailsTruncated: window.emails_truncated,
                windowOpen: false,
              },
            }
          : prev,
      );
    } catch {
      // The window could not be collected (app restarted, id expired). Closing
      // it as "not observed" is honest; claiming zero lines would not be.
      // Same session check as the success path — this lands just as late.
      if (!belongsToCurrentSession(sendSessionId)) return;
      setResult((prev) =>
        prev
          ? { ...prev, rollup: { ...prev.rollup, logLines: null, emails: null, windowOpen: false } }
          : prev,
      );
    }
  }

  function handleError(message: string) {
    // A send that fails after the user moved on is the same misattribution as
    // one that succeeds: the banner would blame the new investigation for a
    // request belonging to the old one.
    if (!belongsToCurrentSession(activeSessionId)) return;
    setSending(false);
    setError(message);
  }

  function handleHistorySelect(entry: HistoryEntry) {
    setSending(false);
    setError(null);
    setResult({
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
