import { useCallback, useEffect, useState } from "react";
import {
  invokeListConnections,
  invokeDeleteConnection,
  invokeTestSavedConnection,
  type ConnectionSummary,
} from "../../lib/tauri";
import { ConnectionModal } from "./ConnectionModal";

type ModalState = { mode: "add" } | { mode: "edit"; connection: ConnectionSummary } | null;

export function ConnectionsPane() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [statuses, setStatuses] = useState<Record<string, "ok" | "error">>({});
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const refresh = useCallback(async () => {
    try {
      setConnections(await invokeListConnections());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function test(id: string) {
    try {
      await invokeTestSavedConnection(id);
      setStatuses((prev) => ({ ...prev, [id]: "ok" }));
    } catch {
      setStatuses((prev) => ({ ...prev, [id]: "error" }));
    }
  }

  async function remove(id: string) {
    await invokeDeleteConnection(id).catch(() => {});
    await refresh();
  }

  return (
    <div className="max-w-160">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-text">Connections</h2>
          <p className="mt-1 text-sm text-text-muted">
            Databases DevBench can browse, query, and watch. Passwords are stored in your OS keychain, never here.
          </p>
        </div>
        <button
          onClick={() => setModal({ mode: "add" })}
          className="shrink-0 rounded-sm bg-accent px-3 py-2 text-sm font-bold text-accent-on"
        >
          + Add connection
        </button>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        {connections.length === 0 ? (
          <div className="rounded-lg border border-border p-4 text-sm text-text-faint">
            No connections configured. Add one to browse and query a database.
          </div>
        ) : (
          connections.map((c) => (
            <div key={c.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text">{c.name}</div>
                  <div className="truncate font-mono text-xs text-text-muted">
                    {c.engine} · {c.host}:{c.port}/{c.database}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {statuses[c.id] ? (
                    <span
                      className={`rounded-sm px-2 py-0.5 text-[11px] font-semibold ${
                        statuses[c.id] === "ok" ? "bg-success-bg text-success" : "bg-danger-bg text-danger"
                      }`}
                    >
                      {statuses[c.id] === "ok" ? "Connected" : "Error"}
                    </span>
                  ) : null}
                  <button
                    aria-label={`Test ${c.name}`}
                    onClick={() => void test(c.id)}
                    className="rounded-sm px-2 py-1 text-xs text-text-muted hover:bg-surface-2"
                  >
                    Test
                  </button>
                  <button
                    aria-label={`Edit ${c.name}`}
                    onClick={() => setModal({ mode: "edit", connection: c })}
                    className="rounded-sm px-2 py-1 text-xs text-text-muted hover:bg-surface-2"
                  >
                    Edit
                  </button>
                  <button
                    aria-label={`Delete ${c.name}`}
                    onClick={() => void remove(c.id)}
                    className="rounded-sm px-2 py-1 text-xs text-text-faint hover:bg-surface-2 hover:text-text"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      {error ? <div className="mt-2 text-xs text-danger">{error}</div> : null}

      {modal ? (
        <ConnectionModal
          existing={modal.mode === "edit" ? modal.connection : null}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
