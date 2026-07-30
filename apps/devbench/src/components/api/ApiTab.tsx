import { useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { HistorySidebar } from "./HistorySidebar";
import { Rollup } from "../rollup/Rollup";
import { useAppStore } from "../../store/useAppStore";
import type { CorrelationResult, DbConnectInput, FireRequestOutput, HistoryEntry, TableDiff } from "../../lib/tauri";

const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

/**
 * What's shown in the response viewer / rollup. `tableDiffs` is deliberately
 * `TableDiff[] | null` rather than always `[]`: `null` means diff data isn't
 * available at all (a history-selected entry), `[]` means diffs were actually
 * computed and nothing changed — the two are not the same claim.
 */
interface DisplayResult {
  response: FireRequestOutput;
  tableDiffs: TableDiff[] | null;
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

  function handleResult(correlation: CorrelationResult) {
    setSending(false);
    setResult({ response: correlation.response, tableDiffs: correlation.table_diffs });
    // The backend writes a history entry as part of a successful correlated
    // request; bump the refresh key so the sidebar (which only fetches on
    // mount otherwise) picks up the new entry now, not on next remount.
    setHistoryRefreshKey((k) => k + 1);
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
      tableDiffs: null,
    });
  }

  function handleTableClick(table: string) {
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
                diffs={result?.tableDiffs ?? null}
                loading={sending}
                watchedTableCount={watchedTables.size}
                onTableClick={handleTableClick}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
