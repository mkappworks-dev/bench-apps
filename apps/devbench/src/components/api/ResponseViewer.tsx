import type { FireRequestOutput } from "../../lib/tauri";

export function ResponseViewer({ result }: { result: FireRequestOutput | null }) {
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
      </div>
      <pre className="whitespace-pre-wrap rounded-b-lg border-t border-border bg-surface-2 p-3 font-mono text-sm text-text">
        {result.body}
      </pre>
    </div>
  );
}
