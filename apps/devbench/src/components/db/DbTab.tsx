import { useEffect, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid } from "./DataGrid";
import {
  invokeListTableRows,
  invokeListWatchedTables,
  invokeSetWatchedTable,
  type DbConnectInput,
  type TableRows,
} from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

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
  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  async function fetchRows(t: string) {
    setError(null);
    try {
      setTableRows(await invokeListTableRows(DEV_CONNECTION, t));
    } catch (err) {
      setTableRows(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Fires on mount if `table` arrives already set (a deep link creating this
  // tab), and again whenever the schema tree patches it — one path, not two.
  useEffect(() => {
    if (table) void fetchRows(table);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  // Watch state lives in SQLite, keyed by connection. Hydrate on mount so a
  // restart does not silently reset what the user is watching — which would
  // make the next rollup report "no tables are being watched" for a session
  // the user believes is still configured.
  useEffect(() => {
    invokeListWatchedTables(DEV_CONNECTION)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [setWatchedTables]);

  async function handleToggleWatch(table: string) {
    const nextWatched = !watchedTables.has(table);
    onToggleWatch(table);
    try {
      await invokeSetWatchedTable(DEV_CONNECTION, table, nextWatched);
    } catch {
      // Roll the optimistic toggle back rather than leaving the UI claiming a
      // table is watched when the correlation engine will not see it.
      onToggleWatch(table);
    }
  }

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connection={DEV_CONNECTION}
        watchedTables={watchedTables}
        onToggleWatch={handleToggleWatch}
        onSelectTable={(t) => onPatchState({ table: t })}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {error ? (
          <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
        ) : tableRows ? (
          <DataGrid columns={tableRows.columns} rows={tableRows.rows} />
        ) : null}
      </div>
    </div>
  );
}
