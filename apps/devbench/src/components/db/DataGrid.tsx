export function DataGrid({ columns, rows }: { columns: string[]; rows: (string | null)[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full font-mono text-sm">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="whitespace-nowrap border-b border-border bg-surface-2 px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-text-faint"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-surface-2">
              {row.map((cell, j) => (
                <td key={j} className="whitespace-nowrap border-b border-border px-3 py-1.75 tabular-nums text-text">
                  {cell ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
