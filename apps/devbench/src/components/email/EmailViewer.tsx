import { useState } from "react";
import type { CapturedEmail } from "../../lib/tauri";

type ViewMode = "html" | "plain" | "raw" | "headers";

const MODES: { id: ViewMode; label: string }[] = [
  { id: "html", label: "HTML" },
  { id: "plain", label: "Plain" },
  { id: "raw", label: "Raw" },
  { id: "headers", label: "Headers" },
];

/** RFC 5322: headers are everything before the first empty line. */
function headerBlock(raw: string): string {
  const separator = raw.search(/\r?\n\r?\n/);
  return separator === -1 ? raw : raw.slice(0, separator);
}

export function EmailViewer({
  email,
  onOpenHistory,
}: {
  email: CapturedEmail | null;
  onOpenHistory?: (requestId: string) => void;
}) {
  const [mode, setMode] = useState<ViewMode>("html");

  if (!email) {
    return <div className="p-6 text-sm text-text-faint">Select a message to read it.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-4">
        <div className="text-base font-semibold text-text">{email.subject}</div>
        <div className="mt-1 font-mono text-xs text-text-muted">
          from {email.from} · to {email.to.join(", ")}
        </div>
        {email.request_id && email.request_method && email.request_url ? (
          <button
            onClick={() => onOpenHistory?.(email.request_id as string)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-text-muted hover:text-text"
          >
            Sent by{" "}
            <b className="font-mono font-semibold text-text">
              {email.request_method} {email.request_url}
            </b>{" "}
            <span className="text-text-faint">→ view in History</span>
          </button>
        ) : null}
      </div>

      <div className="flex gap-1 border-b border-border px-3 py-2" role="tablist" aria-label="Message view">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => setMode(m.id)}
            className={`rounded-sm px-2.5 py-1 text-xs font-medium ${
              mode === m.id ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {mode === "html" ? (
          email.html_body ? (
            // A caught message is untrusted input, and this webview exposes
            // `invoke` on `window`. An empty `sandbox` attribute grants NO
            // capabilities — no scripts, no forms, no same-origin — which is
            // the only safe way to render it. Never dangerouslySetInnerHTML.
            // White in both themes on purpose: mail ships no background of its
            // own and assumes the light canvas its recipient will see.
            <iframe
              title="Email HTML body"
              sandbox=""
              srcDoc={email.html_body}
              className="h-full w-full border-0 bg-white"
            />
          ) : (
            <div className="p-4 text-sm text-text-faint">This message has no HTML part.</div>
          )
        ) : null}

        {mode === "plain" ? (
          email.text_body ? (
            <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-text">{email.text_body}</pre>
          ) : (
            <div className="p-4 text-sm text-text-faint">This message has no plain-text part.</div>
          )
        ) : null}

        {mode === "raw" ? (
          <pre data-testid="email-raw" className="whitespace-pre-wrap p-4 font-mono text-xs text-text">
            {email.raw}
          </pre>
        ) : null}

        {mode === "headers" ? (
          <pre data-testid="email-headers" className="whitespace-pre-wrap p-4 font-mono text-xs text-text">
            {headerBlock(email.raw)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
