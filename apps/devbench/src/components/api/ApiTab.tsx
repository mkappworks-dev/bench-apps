import { useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { HistorySidebar } from "./HistorySidebar";
import { Rollup } from "../rollup/Rollup";
import { useAppStore } from "../../store/useAppStore";
import type { CorrelationResult, DbConnectInput, HistoryEntry } from "../../lib/tauri";

const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

export function ApiTab({ onOpenTableInDb }: { onOpenTableInDb: (table: string) => void }) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const [correlation, setCorrelation] = useState<CorrelationResult | null>(null);
  const [sending, setSending] = useState(false);

  function handleSendStart() {
    setSending(true);
    setCorrelation(null);
  }

  function handleResult(result: CorrelationResult) {
    setSending(false);
    setCorrelation(result);
  }

  function handleHistorySelect(entry: HistoryEntry) {
    setSending(false);
    setCorrelation({
      response: { status_code: entry.status_code, body: entry.response_body, duration_ms: entry.duration_ms },
      table_diffs: [],
    });
  }

  function handleTableClick(table: string) {
    setActiveTab("db");
    onOpenTableInDb(table);
  }

  return (
    <div className="-m-6 flex h-full">
      <HistorySidebar onSelect={handleHistorySelect} />
      <div className="mx-auto flex max-w-180 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <RequestBuilder
          connection={DEV_CONNECTION}
          watchedTables={watchedTables}
          onSendStart={handleSendStart}
          onResult={handleResult}
        />
        <ResponseViewer result={correlation?.response ?? null} />
        {correlation || sending ? (
          <div>
            <div className="m-0.5 text-[11.5px] font-bold uppercase tracking-wide text-text-faint">
              What happened
            </div>
            <div className="rounded-lg border border-border bg-surface">
              <Rollup diffs={correlation?.table_diffs ?? []} loading={sending} onTableClick={handleTableClick} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
