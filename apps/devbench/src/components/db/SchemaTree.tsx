import { useEffect, useState } from "react";
import {
  invokeDbConnectAndListTables,
  invokeListConnections,
  type ConnectionSummary,
  type TableInfo,
} from "../../lib/tauri";
import { Menu, ChevronIcon } from "../ui/Menu";
import { useAppStore } from "../../store/useAppStore";

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
  const setRoute = useAppStore((s) => s.setRoute);
  const setSettingsPane = useAppStore((s) => s.setSettingsPane);

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
  // The host line is what tells two same-named connections apart — and, more
  // to the point, what stops someone browsing prod thinking it's local.
  const connectionOptions = connections.map((c) => ({
    value: c.id,
    label: c.name,
    description: `${c.host}:${c.port}/${c.database}`,
    icon: <PlugIcon />,
  }));

  return (
    <aside className="w-52.5 min-w-52.5 min-h-0 overflow-y-auto border-r border-border">
      {/* h-11, matching the pane strip and the sessions header: this head used
          to be padding-sized (46px), which put its rule 2px below every other
          top divider in the shell — visible as a kink across the full width. */}
      <div className="flex h-11 items-center border-b border-border px-2">
        {connectionsError ? (
          <div
            className="w-full truncate rounded-sm border border-border bg-danger-bg px-2 py-1.5 text-xs font-bold text-danger"
            title={connectionsError}
          >
            Couldn't load connections
          </div>
        ) : connections.length === 0 ? (
          <div className="w-full px-1 py-1.5 text-xs font-bold text-text-faint">No connections</div>
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
            triggerClassName="flex h-7.5 w-full items-center justify-between gap-2 rounded-sm border border-border bg-surface pl-2.75 pr-2 text-xs font-semibold text-text transition-colors duration-150 hover:border-text-faint hover:bg-surface-2"
            footerLabel="Manage connections…"
            footerIcon={<GearIcon />}
            onFooterSelect={() => {
              setSettingsPane("connections");
              setRoute("settings");
            }}
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
              className={`flex items-center gap-2 rounded-sm py-1.5 px-2.25 font-mono text-xs ${
                selected === t.name ? "bg-surface-2 text-text" : "text-text-muted"
              }`}
            >
              <button
                type="button"
                aria-label={`Browse ${t.name}`}
                aria-current={selected === t.name}
                onClick={() => select(t.name)}
                className="flex-1 truncate text-left"
              >
                {t.name}
              </button>
              {/* Siblings, not nested: a <button> inside a <button> is invalid
                  HTML and yields unpredictable focus and activation. */}
              <button
                type="button"
                aria-label={`watch ${t.name}`}
                aria-pressed={watchedTables.has(t.name)}
                onClick={() => onToggleWatch(t.name)}
                className={`ml-auto shrink-0 ${watchedTables.has(t.name) ? "text-text" : "text-text-faint"}`}
              >
                <EyeIcon />
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

// Deliberately monochrome rather than the mockup's success-green "watched"
// state: DESIGN.md reserves semantic color "strictly for actual state
// (response status, the rollup's partial-failure warning) ... never for
// decoration or generic interactivity" — a watch toggle is closer to the
// latter, so it follows the same text/text-faint mapping as everything else.
function PlugIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6M15 2v6M6 8h12l-1 5a5 5 0 0 1-10 0z" />
      <path d="M12 17v5" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
