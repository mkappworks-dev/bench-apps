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

  // `null` means the fetch failed — distinct from an empty list, since only
  // an empty list is grounds for clearing a stale stored id.
  const refresh = useCallback(async (): Promise<Session[] | null> => {
    try {
      const listed = await invokeListSessions();
      setSessions(listed);
      return listed;
    } catch {
      setSessions([]);
      return null;
    }
  }, []);

  // Refs so flipping them doesn't re-render and they read synchronously
  // across an await. Two flags, two moments: `reconciled` claims the settings
  // read (set before it starts, so StrictMode's double-invoke issues only
  // one); `userSelected` vetoes applying the result (checked after the read,
  // since a click can land while it's in flight).
  const reconciled = useRef(false);
  const userSelected = useRef(false);

  // Best-effort: the in-memory selection is what the view depends on, so a
  // failed write must not block it.
  const selectSession = useCallback(
    (id: string | null) => {
      // A deliberate click outranks the launch-time stored value — the list
      // renders before the settings read resolves, so a fast click can land
      // in that gap.
      reconciled.current = true;
      userSelected.current = true;
      setActiveSessionId(id);
      void invokeSetSetting("active_session_id", id ?? "").catch(() => {});
    },
    [setActiveSessionId],
  );

  useEffect(() => {
    void (async () => {
      const listed = await refresh();
      // Don't validate a stored id against a list we never really got —
      // a transient failure would wrongly clear it.
      if (listed === null) return;

      // Once per mount (not per launch: the Settings route unmounts this
      // component), and only after the list resolves — otherwise a stored id
      // gets validated against nothing and cleared.
      if (reconciled.current) return;
      reconciled.current = true;

      try {
        const { active_session_id: storedId } = await invokeGetSettings();
        if (userSelected.current) return; // the user chose while we were reading
        if (!storedId) return;
        if (listed.some((s) => s.id === storedId)) {
          setActiveSessionId(storedId);
        } else {
          // Names an archived/deleted session — drop it rather than scope to
          // something absent from the sidebar.
          void invokeSetSetting("active_session_id", "").catch(() => {});
        }
      } catch {
        // Unreadable — stay unscoped rather than guess.
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
    <aside aria-label="Sessions" className="flex w-(--w-sidebar) min-w-(--w-sidebar) flex-col border-r border-border">
      {/* h-11 like every other top divider (rail head, pane strip, chat
          header) so the shell's first horizontal rule is one unbroken line
          across all four columns rather than four rules 1–2px apart. */}
      <div className="flex h-11 items-center justify-between border-b border-border px-2.5 text-xs font-bold text-text-muted">
        Sessions
        <button
          aria-label="New session"
          onClick={() => setShowNew(true)}
          className="grid size-6 place-items-center rounded-sm transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          <PlusIcon />
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
