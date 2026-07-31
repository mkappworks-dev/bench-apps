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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    invokeDbConnectAndListTables(connection)
      .then(setTables)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
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
      {error ? (
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
                className={`h-2.5 w-2.5 flex-shrink-0 rounded-full border ${
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
