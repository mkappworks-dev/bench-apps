import { useState } from "react";
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
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
}) {
  const [tableRows, setTableRows] = useState<TableRows | null>(null);

  async function handleSelectTable(table: string) {
    const rows = await invokeListTableRows(DEV_CONNECTION, table);
    setTableRows(rows);
  }

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connection={DEV_CONNECTION}
        watchedTables={watchedTables}
        onToggleWatch={onToggleWatch}
        onSelectTable={handleSelectTable}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {tableRows ? <DataGrid columns={tableRows.columns} rows={tableRows.rows} /> : null}
      </div>
    </div>
  );
}
