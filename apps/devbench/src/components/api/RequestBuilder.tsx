import { useState } from "react";
import { invokeRunCorrelatedRequest, type CorrelationResult, type DbConnectInput } from "../../lib/tauri";

export function RequestBuilder({
  connection,
  watchedTables,
  onResult,
  onSendStart,
}: {
  connection: DbConnectInput;
  watchedTables: Set<string>;
  onResult: (result: CorrelationResult) => void;
  onSendStart?: () => void;
}) {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    setSending(true);
    onSendStart?.();
    try {
      const result = await invokeRunCorrelatedRequest({
        request: { method, url, body: undefined },
        connection,
        watchedTables: Array.from(watchedTables),
      });
      onResult(result);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex gap-2 rounded-t-lg border border-b-0 border-border bg-surface p-3">
      <select
        value={method}
        onChange={(e) => setMethod(e.target.value)}
        className="rounded-sm border border-border bg-surface-2 px-2.5 py-2 font-bold text-text"
      >
        <option>GET</option>
        <option>POST</option>
        <option>PUT</option>
        <option>DELETE</option>
      </select>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="/api/orders"
        className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-text"
      />
      <button
        onClick={handleSend}
        disabled={sending}
        className="min-w-21 rounded-sm bg-accent px-4 font-bold text-accent-on disabled:opacity-60"
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
