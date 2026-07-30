import { useEffect, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid } from "./DataGrid";
import { invokeListTableRows, type DbConnectInput, type TableRows } from "../../lib/tauri";

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
  focusTable,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  focusTable: string | null;
}) {
  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSelectTable(table: string) {
    setError(null);
    try {
      const rows = await invokeListTableRows(DEV_CONNECTION, table);
      setTableRows(rows);
    } catch (err) {
      setTableRows(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (focusTable) handleSelectTable(focusTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTable]);

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connection={DEV_CONNECTION}
        watchedTables={watchedTables}
        onToggleWatch={onToggleWatch}
        onSelectTable={handleSelectTable}
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
