import type { ComposerDraft, SavedHeaderRow } from "../../lib/apiComposer";
import { useEffect, useState } from "react";
import { invokeRunCorrelatedRequest, type CorrelationResult, type QualifiedTable, type HeaderPair } from "../../lib/tauri";
import { Menu, ChevronIcon } from "../ui/Menu";
import { RequestTabs, type ReqTab } from "./composer/RequestTabs";
import type { KeyValueRow } from "./composer/KeyValueEditor";
import type { BodyType } from "./composer/BodyEditor";
import { DEFAULT_AUTH, resolveAuthHeader, resolveAuthQueryParam, type AuthState } from "./composer/AuthEditor";
import { splitUrlAndParams, joinUrlAndParams } from "./composer/urlParams";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }));

export function RequestBuilder({
  connectionId,
  watchedTables,
  // `lib/tauri.ts` already normalises to `null`; this default only satisfies
  // the exact-payload assertion in RequestBuilder.test.tsx.
  sessionId = null,
  method,
  url,
  onPatchState,
  headers = [],
  body = "",
  bodyType = "none",
  auth = DEFAULT_AUTH,
  activeReqTab = "headers",
  resetKey = 0,
  onSave,
  saving = false,
  onResult,
  onSendStart,
  onError,
}: {
  /** `null` when no connection is selected yet — Send stays a no-op until one is. */
  connectionId: string | null;
  /** Real identities, not `"schema.name"` keys — this goes straight onto the
   *  wire, and a Postgres identifier can legally contain a dot. */
  watchedTables: QualifiedTable[];
  method: string;
  url: string;
  onPatchState: (patch: Partial<ComposerDraft>) => void;
  headers?: SavedHeaderRow[];
  body?: string;
  bodyType?: BodyType;
  auth?: AuthState;
  activeReqTab?: ReqTab;
  resetKey?: number;
  onSave?: () => void;
  saving?: boolean;
  /** Attributes the fired request's history entry to this session. `null` = unattributed. */
  sessionId?: string | null;
  onResult: (result: CorrelationResult) => void;
  onSendStart?: () => void;
  onError?: (message: string) => void;
}) {
  const [paramsDraft, setParamsDraft] = useState<{ url: string; rows: KeyValueRow[] } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setParamsDraft((draft) => draft?.url === url ? draft : null);
  }, [url]);

  useEffect(() => { setParamsDraft(null); }, [resetKey]);

  const { base, params: parsedParams, fragment } = splitUrlAndParams(url);
  const params = paramsDraft?.url === url ? paramsDraft.rows : parsedParams;

  function handleParamsChange(rows: KeyValueRow[]) {
    const nextUrl = joinUrlAndParams(base, rows, fragment);
    setParamsDraft({ url: nextUrl, rows });
    onPatchState({ url: nextUrl });
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
    const { base: b, params: p, fragment: f } = splitUrlAndParams(url);
    return joinUrlAndParams(b, [...p, { key: authParam.key, value: authParam.value }], f);
  }

  async function handleSend() {
    if (!connectionId) return;
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
        connectionId,
        watchedTables,
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
    <div className="api-composer flex min-w-0 flex-col gap-2.5">
      <div className="api-request-bar flex min-w-0 gap-2">
        <Menu
          closeOnSelect
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
          triggerClassName="api-method flex h-9 w-28 shrink-0 items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 font-mono text-sm font-semibold text-text transition-colors duration-150 hover:border-text-faint hover:bg-surface-2"
        />
        <input
          aria-label="Request URL"
          value={url}
          onChange={(e) => {
            setParamsDraft(null);
            onPatchState({ url: e.target.value });
          }}
          placeholder="/api/orders"
          className="api-url h-9 min-w-0 flex-1 rounded-sm border border-border bg-bg px-2.5 font-mono text-sm text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        {onSave ? <button type="button" onClick={onSave} disabled={saving}
          className="api-save h-9 shrink-0 rounded-sm border border-border px-3 text-sm font-semibold text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {saving ? "Saving…" : "Save"}
        </button> : null}
        <button
          type="button"
          onClick={handleSend}
          disabled={sending || !connectionId}
          title={!connectionId ? "Select a connection first" : undefined}
          className="api-send h-9 min-w-21 shrink-0 rounded-sm bg-accent px-4 text-sm font-semibold text-accent-on transition-colors hover:bg-accent-strong disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <RequestTabs
        activeTab={activeReqTab}
        onTabChange={(activeReqTab) => onPatchState({ activeReqTab })}
        params={params}
        onParamsChange={handleParamsChange}
        headers={headers}
        onHeadersChange={(rows) => onPatchState({ headers: rows.map((row) => ({ ...row, enabled: row.enabled !== false })) })}
        body={body}
        bodyType={bodyType}
        onBodyChange={(body) => onPatchState({ body })}
        onBodyTypeChange={(bodyType) => onPatchState({ bodyType })}
        auth={auth}
        onAuthChange={(auth) => onPatchState({ auth })}
      />
    </div>
  );
}
