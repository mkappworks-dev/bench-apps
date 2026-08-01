import { useEffect, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid } from "./DataGrid";
import { invokeListTableRows, invokeListWatchedTables, invokeSetWatchedTable, type TableRows } from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

export function DbTab({
  watchedTables,
  onToggleWatch,
  table,
  onPatchState,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  table: string | null;
  onPatchState: (patch: { table: string }) => void;
}) {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  async function fetchRows(t: string) {
    if (!activeConnectionId) return;
    setError(null);
    try {
      setTableRows(await invokeListTableRows(activeConnectionId, t));
    } catch (err) {
      setTableRows(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Fires on mount if `table` arrives already set (a deep link creating this
  // tab), again whenever the schema tree patches it, and again if the active
  // connection changes underneath an already-selected table.
  useEffect(() => {
    if (table) void fetchRows(table);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, activeConnectionId]);

  // Watch state is scoped per connection, not just per app. Re-hydrating
  // whenever activeConnectionId changes keeps it in sync with the picker.
  useEffect(() => {
    if (!activeConnectionId) return;
    invokeListWatchedTables(activeConnectionId)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [activeConnectionId, setWatchedTables]);

  async function handleToggleWatch(table: string) {
    if (!activeConnectionId) return;
    const nextWatched = !watchedTables.has(table);
    onToggleWatch(table);
    try {
      await invokeSetWatchedTable(activeConnectionId, table, nextWatched);
    } catch {
      // Roll the optimistic toggle back rather than leaving the UI claiming a
      // table is watched when the correlation engine will not see it.
      onToggleWatch(table);
    }
  }

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connectionId={activeConnectionId}
        watchedTables={watchedTables}
        onToggleWatch={handleToggleWatch}
        onSelectTable={(t) => onPatchState({ table: t })}
        onConnectionChange={setActiveConnectionId}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {!activeConnectionId ? (
          <div className="text-sm text-text-faint">Select a connection to browse its data.</div>
        ) : error ? (
          <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
        ) : tableRows ? (
          <DataGrid columns={tableRows.columns} rows={tableRows.rows} />
        ) : null}
      </div>
    </div>
  );
}
