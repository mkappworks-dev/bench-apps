import { useEffect, useState } from "react";
import { invokeDbConnectAndListTables, type DbConnectInput, type TableInfo } from "../../lib/tauri";

export function SchemaTree({
  connection,
  watchedTables,
  onToggleWatch,
  onSelectTable,
}: {
  connection: DbConnectInput;
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  onSelectTable: (table: string) => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    invokeDbConnectAndListTables(connection).then(setTables);
  }, [connection]);

  function select(name: string) {
    setSelected(name);
    onSelectTable(name);
  }

  return (
    <aside className="w-50 min-w-50 border-r border-border">
      <div className="border-b border-border p-2.5 text-xs font-bold text-text-muted">
        {connection.database}
      </div>
      <div className="flex flex-col gap-0.5 p-1.5">
        {tables.map((t) => (
          <div
            key={`${t.schema}.${t.name}`}
            onClick={() => select(t.name)}
            className={`flex items-center gap-1.5 rounded-sm p-1.5 ${
              selected === t.name ? "bg-surface-2 text-text" : "text-text-muted"
            }`}
          >
            <button
              aria-label={`watch ${t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleWatch(t.name);
              }}
              className={`h-2.5 w-2.5 flex-shrink-0 rounded-full border ${
                watchedTables.has(t.name) ? "border-text bg-text" : "border-text-faint"
              }`}
            />
            <span>{t.name}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
