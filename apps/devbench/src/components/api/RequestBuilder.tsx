import { useState } from "react";
import { invokeRunCorrelatedRequest, type CorrelationResult, type DbConnectInput } from "../../lib/tauri";
import { Menu, ChevronIcon } from "../ui/Menu";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }));

export function RequestBuilder({
  connection,
  watchedTables,
  // `lib/tauri.ts` already normalises to `null`; this default only satisfies
  // the exact-payload assertion in RequestBuilder.test.tsx.
  sessionId = null,
  method,
  url,
  onPatchState,
  onResult,
  onSendStart,
  onError,
}: {
  connection: DbConnectInput;
  watchedTables: Set<string>;
  /** Attributes the fired request's history entry to this session. `null` = unattributed. */
  sessionId?: string | null;
  method: string;
  url: string;
  onPatchState: (patch: { method?: string; url?: string }) => void;
  onResult: (result: CorrelationResult) => void;
  onSendStart?: () => void;
  onError?: (message: string) => void;
}) {
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
      <Menu
        label="Method"
        options={METHODS}
        value={method}
        onSelect={(m) => onPatchState({ method: m })}
        trigger={
          <>
            {method}
            <ChevronIcon />
          </>
        }
        triggerClassName="flex h-9 w-28 shrink-0 items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 font-mono text-sm font-semibold text-text transition-colors duration-150 hover:border-text-faint hover:bg-surface-2"
      />
      <input
        value={url}
        onChange={(e) => onPatchState({ url: e.target.value })}
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
