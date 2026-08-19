import { useState } from "react";
import type { FireRequestOutput, HeaderPair } from "../../lib/tauri";

export interface SentRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string | null;
}

export function ResponseViewer({
  result,
  sentRequest = null,
}: {
  result: FireRequestOutput | null;
  /** Set only when `result` was restored from History — shows what was actually sent, read-only. */
  sentRequest?: SentRequest | null;
}) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  if (!result) return null;
  const isSuccess = result.status_code >= 200 && result.status_code < 300;

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 p-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-bold ${
            isSuccess ? "bg-success-bg text-success" : "bg-danger-bg text-danger"
          }`}
        >
          {result.status_code}
        </span>
        <span className="text-xs font-semibold text-text-muted">{result.duration_ms}ms</span>
        <div className="ml-auto flex gap-3">
          <button
            type="button"
            onClick={() => setTab("body")}
            aria-selected={tab === "body"}
            className={`text-xs font-bold uppercase ${tab === "body" ? "text-text" : "text-text-faint"}`}
          >
            Body
          </button>
          <button
            type="button"
            onClick={() => setTab("headers")}
            aria-selected={tab === "headers"}
            className={`text-xs font-bold uppercase ${tab === "headers" ? "text-text" : "text-text-faint"}`}
          >
            Headers
          </button>
        </div>
      </div>
      {sentRequest ? (
        <details className="border-t border-border p-3 text-sm text-text-faint">
          <summary className="cursor-pointer">
            Sent: {sentRequest.method} {sentRequest.url} · {sentRequest.headers.length} header
            {sentRequest.headers.length === 1 ? "" : "s"}
            {sentRequest.body ? ` · ${sentRequest.body.length}B body` : " · no body"}
          </summary>
          {sentRequest.headers.length > 0 ? (
            <table className="mt-2 w-full font-mono text-xs">
              <tbody>
                {sentRequest.headers.map((h, i) => (
                  <tr key={i}>
                    <td className="pr-3 text-text-faint">{h.key}</td>
                    <td className="text-text-muted">{h.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {sentRequest.body ? (
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-text-muted">
              {sentRequest.body}
            </pre>
          ) : null}
        </details>
      ) : null}
      {tab === "body" ? (
        <pre className="whitespace-pre-wrap rounded-b-lg border-t border-border bg-surface-2 p-3 font-mono text-sm text-text">
          {result.body}
        </pre>
      ) : (
        <table className="w-full rounded-b-lg border-t border-border bg-surface-2 font-mono text-sm">
          <tbody>
            {result.headers.length === 0 ? (
              <tr>
                <td className="p-3 text-text-faint">No headers.</td>
              </tr>
            ) : (
              result.headers.map((h, i) => (
                <tr key={i} className="border-t border-border first:border-t-0">
                  <td className="p-3 pr-4 text-text-faint">{h.key}</td>
                  <td className="p-3 text-text">{h.value}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
