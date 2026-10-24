import type { ReactNode } from "react";
import { LogIcon } from "./LogIcon";
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
  addControl,
  addForm,
}: {
  sources: LogSourceStatus[];
  /** `null` means "all sources". */
  activeSourceId: string | null;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  addControl?: ReactNode;
  addForm?: ReactNode;
}) {
  return (
    <aside className="log-sidebar" aria-label="Log sources">
      <div className="log-sidebar-heading">
        <span>Sources</span>
        {addControl ?? <button onClick={onAdd} aria-label="Add log source" className="log-icon-button"><LogIcon name="plus" /></button>}
      </div>
      <div className="log-source-list">
        <button onClick={() => onSelect(null)} aria-current={activeSourceId === null} className="log-source-button log-all-sources">
          All sources <span className="ml-auto text-[11px] font-normal text-text-faint">{sources.length}</span>
        </button>
        {sources.map((source) => {
          const selected = activeSourceId === source.id;
          const note = selected ? detail(source) : null;
          return (
            <div key={source.id} className="log-source-group">
              <div className="log-source-row">
                <button onClick={() => onSelect(source.id)} aria-current={selected} title={source.path} className="log-source-button">
                  <span data-testid={`kind-${source.id}`} className="log-kind-icon" aria-hidden="true">
                    <LogIcon name={source.kind === "command" ? (/^docker(?:\s|$)/.test(source.path) ? "docker" : "command") : "file"} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{source.label}</span>
                  <span data-testid={`status-${source.id}`} data-state={source.state} title={source.state} aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass(source.state)}`} />
                </button>
                <button aria-label={`Remove ${source.label}`} onClick={() => onRemove(source.id)} className="log-remove-button"><LogIcon name="close" size={12} /></button>
              </div>
              {note ? <div className={`log-source-detail ${source.state === "exited" ? "text-text-muted" : "text-danger"}`}>{note}</div> : null}
            </div>
          );
        })}
      </div>
      {addForm ? <div className="log-add-area">{addForm}</div> : null}
    </aside>
  );
}
