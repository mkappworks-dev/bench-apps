import { useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { HistorySidebar } from "./HistorySidebar";
import type { FireRequestOutput, HistoryEntry } from "../../lib/tauri";

export function ApiTab() {
  const [result, setResult] = useState<FireRequestOutput | null>(null);

  function handleHistorySelect(entry: HistoryEntry) {
    setResult({
      status_code: entry.status_code,
      body: entry.response_body,
      duration_ms: entry.duration_ms,
    });
  }

  return (
    <div className="-m-6 flex h-full">
      <HistorySidebar onSelect={handleHistorySelect} />
      <div className="mx-auto flex max-w-180 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <RequestBuilder onResult={setResult} />
        <ResponseViewer result={result} />
      </div>
    </div>
  );
}
