import { useState } from "react";
import { invokeRunCorrelatedRequest, type CorrelationResult, type DbConnectInput, type HeaderPair } from "../../lib/tauri";
import { RequestTabs, type ReqTab } from "./composer/RequestTabs";
import type { KeyValueRow } from "./composer/KeyValueEditor";
import type { BodyType } from "./composer/BodyEditor";
import { DEFAULT_AUTH, resolveAuthHeader, resolveAuthQueryParam, type AuthState } from "./composer/AuthEditor";
import { splitUrlAndParams, joinUrlAndParams } from "./composer/urlParams";

export function RequestBuilder({
  connection,
  watchedTables,
  // `lib/tauri.ts` already normalises to `null`; this default only satisfies
  // the exact-payload assertion in RequestBuilder.test.tsx.
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
  const [headers, setHeaders] = useState<KeyValueRow[]>([]);
  const [body, setBody] = useState("");
  const [bodyType, setBodyType] = useState<BodyType>("none");
  const [auth, setAuth] = useState<AuthState>(DEFAULT_AUTH);
  const [activeReqTab, setActiveReqTab] = useState<ReqTab>("headers");
  const [sending, setSending] = useState(false);

  const { base, params } = splitUrlAndParams(url);

  function handleParamsChange(rows: KeyValueRow[]) {
    setUrl(joinUrlAndParams(base, rows));
  }

  function buildHeaders(): HeaderPair[] {
    const resolved: HeaderPair[] = headers
      .filter((h) => h.enabled !== false && h.key)
      .map((h) => ({ key: h.key, value: h.value }));
    const authHeader = resolveAuthHeader(auth);
    if (authHeader) resolved.push(authHeader);
    return resolved;
  }

  function buildUrl(): string {
    const authParam = resolveAuthQueryParam(auth);
    if (!authParam) return url;
    const { base: b, params: p } = splitUrlAndParams(url);
    return joinUrlAndParams(b, [...p, { key: authParam.key, value: authParam.value }]);
  }

  async function handleSend() {
    setSending(true);
    onSendStart?.();
    try {
      const result = await invokeRunCorrelatedRequest({
        request: {
          method,
          url: buildUrl(),
          headers: buildHeaders(),
          body: bodyType === "none" ? undefined : body,
        },
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
    <div className="flex flex-col gap-2.5 rounded-t-lg border border-b-0 border-border bg-surface p-3">
      <div className="flex gap-2">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="rounded-sm border border-border bg-surface-2 px-2.5 py-2 font-bold text-text"
        >
          <option>GET</option>
          <option>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
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
      <RequestTabs
        activeTab={activeReqTab}
        onTabChange={setActiveReqTab}
        params={params}
        onParamsChange={handleParamsChange}
        headers={headers}
        onHeadersChange={setHeaders}
        body={body}
        bodyType={bodyType}
        onBodyChange={setBody}
        onBodyTypeChange={setBodyType}
        auth={auth}
        onAuthChange={setAuth}
      />
    </div>
  );
}
