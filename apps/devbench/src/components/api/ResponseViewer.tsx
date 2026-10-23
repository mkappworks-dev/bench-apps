import { useState } from "react";
import type { FireRequestOutput, HeaderPair } from "../../lib/tauri";
import { Tabs } from "../ui/Tabs";

export interface SentRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string | null;
}

function HeaderTable({ headers, label }: { headers: HeaderPair[]; label: string }) {
  return (
    <table aria-label={label} className="api-header-table w-full table-fixed font-mono text-xs">
      <tbody>
        {headers.length === 0 ? <tr><td className="p-3 text-text-muted">No headers.</td></tr> : headers.map((header, index) => (
          <tr key={index} className="border-t border-border first:border-t-0">
            <th scope="row" className="w-2/5 p-3 text-left align-top font-normal text-text-muted [overflow-wrap:anywhere]">{header.key}</th>
            <td className="p-3 align-top text-text [overflow-wrap:anywhere]">{header.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResponseViewer({ result, sentRequest = null }: {
  result: FireRequestOutput | null;
  /** Only history has a read-only sent-request disclosure. */
  sentRequest?: SentRequest | null;
}) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  if (!result) return null;
  const statusClass = result.status_code >= 400 ? "bg-danger-bg text-danger"
    : result.status_code >= 300 ? "bg-warning-bg text-warning"
    : result.status_code >= 200 ? "bg-success-bg text-success" : "bg-surface-2 text-text-muted";
  return (
    <section aria-label="Response" className="api-response min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as "body" | "headers")}>
        <div className="api-response-head flex flex-wrap items-center gap-2.5 p-3">
          <h2 className="text-sm font-semibold text-text">Response</h2>
          <span className={`rounded-sm px-2 py-0.5 font-mono text-xs font-semibold tabular-nums ${statusClass}`}>{result.status_code}</span>
          <span className="font-mono text-xs tabular-nums text-text-muted">{result.duration_ms}ms</span>
          <Tabs.List aria-label="Response format" activateOnFocus className="ml-auto flex gap-3">
            {(["body", "headers"] as const).map((value) => (
              <Tabs.Tab key={value} value={value}
                className="rounded-sm py-1 text-xs font-semibold text-text-muted hover:text-text data-[active]:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                {value === "body" ? "Body" : "Headers"}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </div>
        {sentRequest ? (
          <details className="api-sent border-t border-border text-sm text-text-muted">
            <summary className="cursor-pointer px-3 py-2.5 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
              Sent: {sentRequest.method} {sentRequest.url} · {sentRequest.headers.length} header{sentRequest.headers.length === 1 ? "" : "s"}
              {sentRequest.body !== null ? ` · ${new TextEncoder().encode(sentRequest.body).length}B body` : " · no body"}
            </summary>
            {sentRequest.headers.length > 0 ? <HeaderTable headers={sentRequest.headers} label="Sent headers" /> : null}
            {sentRequest.body !== null ? <pre className="whitespace-pre-wrap px-3 pb-3 font-mono text-xs [overflow-wrap:anywhere]">{sentRequest.body}</pre> : null}
          </details>
        ) : null}
        <Tabs.Panel value="body" className="border-t border-border bg-surface-2">
          <pre className="whitespace-pre-wrap p-3 font-mono text-sm leading-relaxed text-text [overflow-wrap:anywhere]">{result.body || "Empty response body."}</pre>
        </Tabs.Panel>
        <Tabs.Panel value="headers" className="border-t border-border bg-surface-2">
          <HeaderTable headers={result.headers} label="Response headers" />
        </Tabs.Panel>
      </Tabs.Root>
    </section>
  );
}
