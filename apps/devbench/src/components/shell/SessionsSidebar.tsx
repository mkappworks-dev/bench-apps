import { useCallback, useEffect, useRef, useState } from "react";
import { NewSessionDialog } from "./NewSessionDialog";
import { useAppStore } from "../../store/useAppStore";
import {
  invokeArchiveSession,
  invokeCreateSession,
  invokeGetSettings,
  invokeListSessions,
  invokeSetSetting,
  type Session,
} from "../../lib/tauri";

export function SessionsSidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);

  // Reconciliation needs the list itself, not just the state setter, so
  // `refresh` returns what it fetched.
  const refresh = useCallback(async (): Promise<Session[]> => {
    try {
      const listed = await invokeListSessions();
      setSessions(listed);
      return listed;
    } catch {
      setSessions([]);
      return [];
    }
  }, []);

  // Persisting is best-effort: the in-memory selection is what the current
  // view actually depends on, so a failed write must never block it.
  const selectSession = useCallback(
    (id: string | null) => {
      setActiveSessionId(id);
      void invokeSetSetting("active_session_id", id ?? "").catch(() => {});
    },
    [setActiveSessionId],
  );

  // A ref, not state: flipping it must not trigger a re-render, and it must
  // be readable synchronously by the time the next refresh runs.
  const reconciled = useRef(false);

  useEffect(() => {
    void (async () => {
      const listed = await refresh();

      // Runs once, and only after the list resolves. Validating a stored id
      // against a list that has not loaded would clear a perfectly good
      // selection on every launch; re-running it after a create or archive
      // would overwrite whatever the user just selected.
      if (reconciled.current) return;
      reconciled.current = true;

      try {
        const { active_session_id: storedId } = await invokeGetSettings();
        if (!storedId) return;
        if (listed.some((s) => s.id === storedId)) {
          setActiveSessionId(storedId);
        } else {
          // Names an archived or deleted session. Drop it rather than
          // leaving the app scoped to something absent from the sidebar.
          void invokeSetSetting("active_session_id", "").catch(() => {});
        }
      } catch {
        // Settings unreadable — stay unscoped rather than guessing.
      }
    })();
  }, [refresh, setActiveSessionId]);

  async function handleCreate(name: string) {
    setShowNew(false);
    try {
      const created = await invokeCreateSession(name);
      selectSession(created.id);
      await refresh();
    } catch {
      await refresh();
    }
  }

  async function handleArchive(id: string) {
    try {
      await invokeArchiveSession(id);
      if (activeSessionId === id) selectSession(null);
    } finally {
      await refresh();
    }
  }

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? sessions.filter(
        (s) => s.name.toLowerCase().includes(needle) || (s.kind ?? "").toLowerCase().includes(needle),
      )
    : sessions;

  return (
    // Ghosty: transparent, hairline division, no blur.
    <aside aria-label="Sessions" className="flex w-60 min-w-60 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border p-2.5 text-xs font-bold text-text-muted">
        Sessions
        <button
          onClick={() => setShowNew(true)}
          className="rounded-sm px-1.5 py-0.5 transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          New session
        </button>
      </div>

      <div className="p-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          className="w-full rounded-sm border border-border bg-bg px-2 py-1.5 text-xs text-text"
        />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        {visible.length === 0 ? (
          <div className="p-2 text-xs text-text-faint">
            {sessions.length === 0
              ? "No sessions yet. Create one to name and return to an investigation."
              : `No sessions match “${query}”.`}
          </div>
        ) : (
          visible.map((session) => (
            <div key={session.id} className="flex items-center gap-1">
              <button
                onClick={() => selectSession(session.id)}
                aria-current={activeSessionId === session.id}
                className={`flex flex-1 items-center justify-between gap-2 rounded-sm p-2 text-left text-xs transition-colors duration-150 ${
                  activeSessionId === session.id
                    ? "bg-surface-2 text-text"
                    : "text-text-muted hover:bg-surface-2"
                }`}
              >
                <span className="truncate">{session.name}</span>
                {/* Auto-inferred tag for scanning — never a gate on which
                    tools are visible (v1 spec). */}
                {session.kind ? (
                  <span className="shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-faint">
                    {session.kind}
                  </span>
                ) : null}
              </button>
              <button
                aria-label={`Archive ${session.name}`}
                onClick={() => void handleArchive(session.id)}
                className="rounded-sm px-1.5 text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border p-1.5">
        {/* The spec's single Settings entry point. Deliberately not in the
            topbar, to avoid two ways in. */}
        <button
          onClick={onOpenSettings}
          className="w-full rounded-sm p-2 text-left text-xs text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          Settings
        </button>
      </div>

      <NewSessionDialog open={showNew} onCreate={handleCreate} onCancel={() => setShowNew(false)} />
    </aside>
  );
}
