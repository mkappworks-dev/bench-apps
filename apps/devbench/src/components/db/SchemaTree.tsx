import { useEffect, useState } from "react";
import {
  invokeDbConnectAndListTables,
  invokeListConnections,
  type ConnectionSummary,
  type TableInfo,
} from "../../lib/tauri";
import { Menu, ChevronIcon } from "../ui/Menu";

export function SchemaTree({
  connectionId,
  watchedTables,
  onToggleWatch,
  onSelectTable,
  onConnectionChange,
}: {
  connectionId: string | null;
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  onSelectTable: (table: string) => void;
  onConnectionChange: (connectionId: string) => void;
}) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  // Distinct from `connections.length === 0`: a failed fetch must not read as
  // "you have no connections configured" — those call for different actions.
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invokeListConnections()
      .then((list) => {
        setConnections(list);
        setConnectionsError(null);
      })
      .catch((err) => setConnectionsError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    setError(null);
    if (!connectionId) {
      setTables([]);
      return;
    }
    invokeDbConnectAndListTables(connectionId)
      .then(setTables)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [connectionId]);

  function select(name: string) {
    setSelected(name);
    onSelectTable(name);
  }

  const current = connections.find((c) => c.id === connectionId);
  const connectionOptions = connections.map((c) => ({ value: c.id, label: c.name }));

  return (
    <aside className="w-50 min-w-50 border-r border-border">
      <div className="border-b border-border p-2">
        {connectionsError ? (
          <div
            className="rounded-sm border border-border bg-danger-bg px-2 py-1.5 text-xs font-bold text-danger"
            title={connectionsError}
          >
            Couldn't load connections
          </div>
        ) : connections.length === 0 ? (
          <div className="px-1 py-1.5 text-xs font-bold text-text-faint">No connections</div>
        ) : (
          <Menu
            label="Connection"
            options={connectionOptions}
            value={connectionId ?? undefined}
            onSelect={onConnectionChange}
            trigger={
              <>
                <span className="truncate">{current?.name ?? "Select connection"}</span>
                <ChevronIcon />
              </>
            }
            triggerClassName="flex h-8 w-full items-center justify-between gap-2 rounded-sm border border-border bg-surface px-2.5 text-xs font-bold text-text transition-colors duration-150 hover:border-text-faint hover:bg-surface-2"
          />
        )}
      </div>
      {connectionsError ? (
        <div className="rounded-lg m-1.5 border border-border bg-danger-bg p-2.5 text-xs text-danger">
          Couldn't load connections: {connectionsError}
        </div>
      ) : !connectionId ? (
        <div className="m-1.5 rounded-lg border border-border p-2.5 text-xs text-text-faint">
          {connections.length === 0
            ? "Add a connection in Settings to browse a database."
            : "Select a connection to browse its tables."}
        </div>
      ) : error ? (
        <div className="rounded-lg m-1.5 border border-border bg-danger-bg p-2.5 text-xs text-danger">
          {error}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 p-1.5">
          {tables.map((t) => (
            <div
              key={`${t.schema}.${t.name}`}
              className={`flex items-center gap-1.5 rounded-sm p-1.5 ${
                selected === t.name ? "bg-surface-2 text-text" : "text-text-muted"
              }`}
            >
              {/* Siblings, not nested: a <button> inside a <button> is invalid
                  HTML and yields unpredictable focus and activation. */}
              <button
                type="button"
                aria-label={`watch ${t.name}`}
                aria-pressed={watchedTables.has(t.name)}
                onClick={() => onToggleWatch(t.name)}
                className={`h-2.5 w-2.5 shrink-0 rounded-full border ${
                  watchedTables.has(t.name) ? "border-text bg-text" : "border-text-faint"
                }`}
              />
              <button
                type="button"
                aria-label={`Browse ${t.name}`}
                aria-current={selected === t.name}
                onClick={() => select(t.name)}
                className="flex-1 truncate text-left"
              >
                {t.name}
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
