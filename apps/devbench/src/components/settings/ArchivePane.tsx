import { useCallback, useEffect, useState } from "react";
import {
  invokeDeleteSession,
  invokeListArchivedSessions,
  invokeRestoreSession,
  type Session,
} from "../../lib/tauri";

export function ArchivePane() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSessions(await invokeListArchivedSessions());
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function restore(id: string) {
    await invokeRestoreSession(id).catch(() => {});
    await refresh();
  }

  async function confirmDelete(id: string) {
    await invokeDeleteSession(id).catch(() => {});
    setConfirmingId(null);
    await refresh();
  }

  return (
    <div className="max-w-160">
      <h2 className="text-lg font-bold text-text">Archive</h2>
      <p className="mt-1 text-sm text-text-muted">
        Sessions removed from the sidebar, kept here until restored or deleted.
      </p>

      <div className="mt-6 flex flex-col gap-2">
        {sessions.length === 0 ? (
          <div className="rounded-lg border border-border p-4 text-sm text-text-faint">
            Nothing archived. Removing a session from the sidebar puts it here — it is never deleted
            outright.
          </div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-text">{s.name}</div>
                  <div className="text-[11px] text-text-faint">
                    Archived {s.archived_at ? new Date(s.archived_at).toLocaleDateString() : "—"}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    aria-label={`Restore ${s.name}`}
                    onClick={() => void restore(s.id)}
                    className="rounded-sm border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-2"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => setConfirmingId(s.id)}
                    className="rounded-sm px-2.5 py-1 text-xs text-text-faint hover:bg-surface-2 hover:text-danger"
                  >
                    Delete forever
                  </button>
                </div>
              </div>
              {confirmingId === s.id ? (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-sm bg-danger-bg px-2 py-1.5">
                  <span className="text-xs text-danger">
                    Delete "{s.name}" permanently? This cannot be undone.
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmingId(null)}
                      className="rounded-sm px-2 py-0.5 text-xs text-text-muted"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void confirmDelete(s.id)}
                      className="rounded-sm bg-danger px-2 py-0.5 text-xs font-bold text-accent-on"
                    >
                      Confirm delete
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
