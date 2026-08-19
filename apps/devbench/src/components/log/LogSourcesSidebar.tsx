import type { LogSourceStatus } from "../../lib/tauri";

const STATUS_CLASS: Record<string, string> = {
  live: "bg-success",
  exited: "bg-text-faint",
  error: "bg-danger",
};

/** An exited command is not an error — it ran and finished. */
function statusClass(state: string): string {
  return STATUS_CLASS[state] ?? "bg-danger";
}

function detail(source: LogSourceStatus): string | null {
  if (source.state === "exited") {
    const code = source.exit_code === null ? "unknown" : String(source.exit_code);
    return `exited (code ${code}) — not auto-restarted`;
  }
  return source.error;
}

export function LogSourcesSidebar({
  sources,
  activeSourceId,
  onSelect,
  onRemove,
  onAdd,
}: {
  sources: LogSourceStatus[];
  /** `null` means "all sources". */
  activeSourceId: string | null;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <aside className="flex w-55 min-w-55 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border p-2.5 text-xs font-bold text-text-muted">
        Sources
        <button onClick={onAdd} className="rounded-sm px-1.5 py-0.5 text-text-muted hover:bg-surface-2">
          + Add
        </button>
      </div>
      <div className="flex flex-col gap-0.5 overflow-y-auto p-1.5">
        <button
          onClick={() => onSelect(null)}
          aria-current={activeSourceId === null}
          className={`rounded-sm p-2 text-left text-xs ${
            activeSourceId === null ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
          }`}
        >
          All sources
        </button>
        {sources.map((source) => {
          const selected = activeSourceId === source.id;
          const note = selected ? detail(source) : null;
          return (
            <div key={source.id} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onSelect(source.id)}
                  aria-current={selected}
                  className={`flex flex-1 items-center gap-1.5 rounded-sm p-2 text-left text-xs ${
                    selected ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
                  }`}
                >
                  <span
                    data-testid={`status-${source.id}`}
                    data-state={source.state}
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass(source.state)}`}
                  />
                  <span
                    data-testid={`kind-${source.id}`}
                    aria-hidden="true"
                    className="shrink-0 font-mono text-text-faint"
                  >
                    {source.kind === "command" ? "$" : "≡"}
                  </span>
                  <span className="truncate">{source.label}</span>
                </button>
                <button
                  aria-label={`Remove ${source.label}`}
                  onClick={() => onRemove(source.id)}
                  className="rounded-sm px-1.5 text-text-faint hover:bg-surface-2 hover:text-text"
                >
                  ✕
                </button>
              </div>
              {note ? (
                <div className="mx-2 rounded-sm bg-danger-bg px-2 py-1 text-[11px] text-danger">{note}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
