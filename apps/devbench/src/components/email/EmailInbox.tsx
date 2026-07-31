import type { EmailSummary } from "../../lib/tauri";

function shortTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function EmailInbox({
  emails,
  selectedId,
  onSelect,
  onClear,
}: {
  emails: EmailSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onClear: () => void;
}) {
  return (
    <aside className="flex w-70 min-w-70 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border p-2.5 text-xs font-bold text-text-muted">
        Inbox
        {emails.length > 0 ? (
          <button onClick={onClear} className="rounded-sm px-1.5 py-0.5 hover:bg-surface-2">
            Clear inbox
          </button>
        ) : null}
      </div>
      {emails.length === 0 ? (
        <div className="p-4 text-xs text-text-faint">
          No mail caught yet. Point your backend's SMTP host at{" "}
          <code className="font-mono">localhost</code> and the port shown below.
        </div>
      ) : (
        <div className="flex flex-col overflow-y-auto">
          {emails.map((email) => (
            <button
              key={email.id}
              onClick={() => onSelect(email.id)}
              aria-current={selectedId === email.id}
              className={`flex flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left ${
                selectedId === email.id ? "bg-surface-2" : "hover:bg-surface-2"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold text-text">{email.subject}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-text-faint">
                  {shortTime(email.captured_at_ms)}
                </span>
              </div>
              <span className="truncate font-mono text-xs text-text-muted">{email.from}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
