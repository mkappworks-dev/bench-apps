import type { LogSourceStatus } from "../../lib/tauri";

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
        {sources.map((source) => (
          <div key={source.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <button
                onClick={() => onSelect(source.id)}
                aria-current={activeSourceId === source.id}
                className={`flex flex-1 items-center gap-1.5 rounded-sm p-2 text-left text-xs ${
                  activeSourceId === source.id ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    source.state === "live" ? "bg-success" : "bg-danger"
                  }`}
                />
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
            {source.error ? (
              <div className="mx-2 rounded-sm bg-danger-bg px-2 py-1 text-[11px] text-danger">{source.error}</div>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
