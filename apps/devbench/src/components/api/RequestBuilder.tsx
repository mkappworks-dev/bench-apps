import { useState } from "react";
import { invokeRunCorrelatedRequest, type CorrelationResult, type DbConnectInput } from "../../lib/tauri";

export function RequestBuilder({
  connection,
  watchedTables,
  // Omitted means the request is unattributed. Normalising to `null` here is
  // no longer what makes the invoke payload explicit — `invokeRunCorrelatedRequest`
  // already does `sessionId ?? null` in lib/tauri.ts. What this default still
  // buys is the exact-payload assertion in RequestBuilder.test.tsx, which
  // checks this component passes `sessionId: null` rather than dropping the key.
  sessionId = null,
  onResult,
  onSendStart,
  onError,
}: {
  connection: DbConnectInput;
  watchedTables: Set<string>;
  /** Attributes the fired request's history entry to this session. `null` = unattributed. */
  sessionId?: string | null;
  onResult: (result: CorrelationResult) => void;
  onSendStart?: () => void;
  onError?: (message: string) => void;
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
        sessionId,
      });
      onResult(result);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
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
