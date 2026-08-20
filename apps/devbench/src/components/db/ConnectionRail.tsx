import { useEffect, useState } from "react";
import {
  invokeCreateSavedQuery,
  invokeDbConnectAndListTables,
  invokeDeleteSavedQuery,
  invokeListConnections,
  invokeListSavedQueries,
  type ConnectionSummary,
  type QualifiedTable,
  type TableInfo,
} from "../../lib/tauri";
import { Menu, ChevronIcon } from "../ui/Menu";
import { SecondaryButton } from "../ui/SecondaryButton";
import { useAppStore } from "../../store/useAppStore";
import { tableKey } from "../../lib/tableIdentity";
import { queriesForConnection } from "../../lib/savedQueries";

export function ConnectionRail({
  connectionId,
  selected,
  watchedTables,
  onToggleWatch,
  onSelectTable,
  onConnectionChange,
  // Optional so the call sites predating the queries segment keep compiling.
  initialSegment = "tables",
  activeQueryId = null,
  onOpenQuery,
  onCloseQueryTabs,
}: {
  connectionId: string | null;
  selected: QualifiedTable | null;
  /** Keyed `"schema.name"` — a bare name can't distinguish two schemas. */
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
  onSelectTable: (table: QualifiedTable) => void;
  onConnectionChange: (connectionId: string) => void;
  /** Initial value only — the user can switch, and the switch is not persisted. */
  initialSegment?: "tables" | "queries";
  /** The query this rail's host tab is showing, if it is a query tab. */
  activeQueryId?: string | null;
  /** The rail owns the saved-query record but not the tabs that show it. Required
   *  rather than defaulted: a silent no-op would let a host ship half-wired. */
  onOpenQuery: (queryId: string) => void;
  /** Same reason as `onOpenQuery`. A tab whose query is gone cannot take a
   *  keystroke (`patchSavedQuery` has no row to patch) yet survives a restart. */
  onCloseQueryTabs: (queryId: string) => void;
}) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  // Distinct from `connections.length === 0`: a failed fetch is not "none configured".
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<"tables" | "queries">(initialSegment);
  // Distinct from `error`, which belongs to the tables fetch.
  const [queryActionError, setQueryActionError] = useState<string | null>(null);
  const setRoute = useAppStore((s) => s.setRoute);
  const setSettingsPane = useAppStore((s) => s.setSettingsPane);
  const savedQueries = useAppStore((s) => s.savedQueries);
  const mergeSavedQueriesIntoStore = useAppStore((s) => s.mergeSavedQueriesIntoStore);
  const removeSavedQuery = useAppStore((s) => s.removeSavedQuery);
  const queries = queriesForConnection(savedQueries, connectionId);

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

  // On connection change, not segment change: a query tab's label reads out of this
  // list whether or not anyone has opened the Queries segment.
  useEffect(() => {
    if (!connectionId) return;
    invokeListSavedQueries(connectionId).then(mergeSavedQueriesIntoStore).catch(() => {});
  }, [connectionId, mergeSavedQueriesIntoStore]);

  async function createQuery() {
    if (!connectionId) return;
    try {
      const made = await invokeCreateSavedQuery(connectionId, "untitled query", "");
      setQueryActionError(null);
      mergeSavedQueriesIntoStore([made]);
      onOpenQuery(made.id);
    } catch (err) {
      setQueryActionError(`Couldn't create the query: ${messageOf(err)}`);
    }
  }

  // Database first: removing optimistically left the row alive in SQLite and back
  // on the next list, with the rail claiming it was gone.
  async function deleteQuery(id: string) {
    try {
      await invokeDeleteSavedQuery(id);
    } catch (err) {
      setQueryActionError(`Couldn't delete the query: ${messageOf(err)}`);
      return;
    }
    setQueryActionError(null);
    removeSavedQuery(id);
    onCloseQueryTabs(id);
  }

  const current = connections.find((c) => c.id === connectionId);
  // The host line is what stops someone browsing prod thinking it's local.
  const connectionOptions = connections.map((c) => ({
    value: c.id,
    label: c.name,
    description: `${c.host}:${c.port}/${c.database}`,
    icon: <PlugIcon />,
  }));

  return (
    <aside className="flex w-52.5 min-w-52.5 min-h-0 flex-col overflow-y-auto border-r border-border">
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
      {connectionId ? (
        <div className="border-b border-border px-2 py-1.5">
          <div role="tablist" aria-label="Rail segment" className="flex gap-0.5 rounded-sm bg-surface-2 p-0.5">
            {(["tables", "queries"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={segment === value}
                onClick={() => setSegment(value)}
                className="h-5.5 flex-1 rounded-[4px] text-[10.5px] font-bold uppercase tracking-[0.04em] text-text-faint transition-colors duration-150 hover:text-text-muted aria-selected:bg-surface aria-selected:text-text"
              >
                {value === "tables" ? "Tables" : "Queries"}
              </button>
            ))}
          </div>
        </div>
      ) : null}
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
      ) : segment === "tables" ? (
        <div className="flex flex-col gap-0.5 p-1.5">
          {tables.map((t) => {
            const key = tableKey(t);
            const isSelected = selected?.schema === t.schema && selected?.name === t.name;
            return (
              <div
                key={key}
                className={`flex items-center gap-2 rounded-sm py-1.5 px-2.25 font-mono text-xs ${
                  isSelected ? "bg-surface-2 text-text" : "text-text-muted"
                }`}
              >
                <button
                  type="button"
                  aria-label={`Browse ${key}`}
                  aria-current={isSelected}
                  onClick={() => onSelectTable({ schema: t.schema, name: t.name })}
                  className="flex-1 truncate text-left"
                >
                  {t.name}
                </button>
                {/* Siblings, not nested: a <button> inside a <button> is invalid
                    HTML and yields unpredictable focus and activation. */}
                <button
                  type="button"
                  aria-label={`watch ${key}`}
                  aria-pressed={watchedTables.has(key)}
                  onClick={() => onToggleWatch({ schema: t.schema, name: t.name })}
                  className={`ml-auto shrink-0 ${watchedTables.has(key) ? "text-text" : "text-text-faint"}`}
                >
                  <EyeIcon />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 p-1.5">
          {queryActionError ? (
            <div className="mb-1 rounded-lg border border-border bg-danger-bg p-2.5 text-xs text-danger">
              {queryActionError}
            </div>
          ) : null}
          {queries.map((q) => (
            <div
              key={q.id}
              className={`flex items-center gap-2 rounded-sm px-2.25 py-1.5 font-mono text-xs ${
                q.id === activeQueryId ? "bg-surface-2 text-text" : "text-text-muted"
              }`}
            >
              <button
                type="button"
                aria-label={`Open query ${q.name}`}
                aria-current={q.id === activeQueryId}
                onClick={() => onOpenQuery(q.id)}
                className="flex-1 truncate text-left"
              >
                {q.name}
              </button>
              <button
                type="button"
                aria-label={`Delete query ${q.name}`}
                onClick={() => void deleteQuery(q.id)}
                className="ml-auto shrink-0 text-text-faint hover:text-danger"
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          {queries.length === 0 ? (
            <div className="px-2.25 py-1.5 text-xs text-text-faint">No saved queries yet.</div>
          ) : null}
        </div>
      )}
      {connectionId && segment === "queries" ? (
        <div className="mt-auto border-t border-border p-1.5">
          <SecondaryButton className="h-7 w-full" onClick={() => void createQuery()}>
            New query
          </SecondaryButton>
        </div>
      ) : null}
    </aside>
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Monochrome, not the mockup's success-green: DESIGN.md reserves semantic color
// for actual state, never for decoration or generic interactivity.
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

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
    </svg>
  );
}
