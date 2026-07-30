import { useState } from "react";
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

export function ApiTab({ onOpenTableInDb }: { onOpenTableInDb: (table: string) => void }) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  function handleSendStart() {
    setSending(true);
    setResult(null);
    setError(null);
  }

  // Phase 1 landed: paint the response and the DB diffs immediately, then let
  // the correlation window finish in the background and fill in the Log chip.
  async function handleResult(correlation: CorrelationResult) {
    setSending(false);
    setResult({
      response: correlation.response,
      rollup: {
        tableDiffs: correlation.table_diffs,
        watchedTableCount: watchedTables.size,
        logLines: null,
        logLinesTruncated: false,
        dbError: correlation.db_error,
        windowOpen: true,
      },
    });
    setHistoryRefreshKey((k) => k + 1);

    try {
      const window = await invokeCollectCorrelationWindow(correlation.correlation_id);
      setResult((prev) =>
        prev
          ? {
              ...prev,
              rollup: {
                ...prev.rollup,
                logLines: window.log_lines,
                logLinesTruncated: window.log_lines_truncated,
                windowOpen: false,
              },
            }
          : prev,
      );
    } catch {
      // The window could not be collected (app restarted, id expired). Closing
      // it as "not observed" is honest; claiming zero lines would not be.
      setResult((prev) =>
        prev ? { ...prev, rollup: { ...prev.rollup, logLines: null, windowOpen: false } } : prev,
      );
    }
  }

  function handleError(message: string) {
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
        dbError: null,
        windowOpen: false,
      },
    });
  }

  function handleOpenDb(table: string) {
    setActiveTab("db");
    onOpenTableInDb(table);
  }

  return (
    <div className="-m-6 flex h-full">
      <HistorySidebar onSelect={handleHistorySelect} refreshKey={historyRefreshKey} />
      <div className="mx-auto flex max-w-180 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <RequestBuilder
          connection={DEV_CONNECTION}
          watchedTables={watchedTables}
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
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
