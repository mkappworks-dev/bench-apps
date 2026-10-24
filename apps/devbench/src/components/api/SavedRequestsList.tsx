import type { SavedRequest } from "../../lib/tauri";
import { Menu } from "../ui/Menu";

export function SavedRequestsList({ items, loading, error, selectedId, sessionId, onSelect, onRename, onDelete }: {
  items: SavedRequest[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  sessionId: string | null;
  onSelect: (request: SavedRequest) => void;
  onRename: (request: SavedRequest) => void;
  onDelete: (request: SavedRequest) => void;
}) {
  return (
    <section aria-label="Saved requests" aria-busy={loading} className="border-b border-border">
      <h2 className="border-b border-border p-2.5 text-xs font-bold text-text-muted">Saved</h2>
      {loading ? <p className="p-3 text-xs text-text-muted">Loading saved requests…</p> : null}
      {error ? <p role="alert" className="p-3 text-xs text-danger">Couldn't load saved requests. {error}</p> : null}
      {!loading && !error && items.length === 0 ? <p className="p-3 text-xs text-text-muted">
        {sessionId ? "No saved requests in this session yet." : "No saved requests yet."}
      </p> : null}
      <div className="flex flex-col gap-0.5 p-1.5">
        {items.map((request) => (
          <div key={request.id} className={`group flex min-w-0 items-center rounded-sm hover:bg-surface-2 ${selectedId === request.id ? "bg-surface-2" : ""}`}>
            <button type="button" aria-label={`Load saved request ${request.name}`} aria-current={selectedId === request.id}
              onClick={() => onSelect(request)} className="min-w-0 flex-1 rounded-sm p-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
              <span title={request.name} className="block truncate text-xs font-semibold text-text">{request.name}</span>
              <span title={`${request.method} ${request.url}`} className="mt-0.5 block truncate font-mono text-xs text-text-muted">{request.method} {request.url}</span>
            </button>
            <Menu label={`Actions for ${request.name}`} options={[{ value: "rename", label: "Rename" }, { value: "delete", label: "Delete" }]}
              onSelect={(action) => action === "rename" ? onRename(request) : onDelete(request)}
              trigger={<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>}
              triggerClassName="mr-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 hover:text-text group-hover:opacity-100 group-focus-within:opacity-100 data-[popup-open]:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent" />
          </div>
        ))}
      </div>
    </section>
  );
}
