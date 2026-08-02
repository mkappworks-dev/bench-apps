/** RFC 4180 quoting. A NULL becomes an empty field; an empty string becomes
 *  `""`, so the two stay distinguishable in the output. */
function csvField(value: string | null): string {
  if (value === null) return "";
  if (value === "" || /[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(columns: string[], rows: (string | null)[][]): string {
  const header = columns.map(csvField).join(",");
  const body = rows.map((row) => row.map(csvField).join(",")).join("\n");
  return rows.length ? `${header}\n${body}` : header;
}

export function toJson(columns: string[], rows: (string | null)[][]): string {
  const objects = rows.map((row) => {
    const object: Record<string, string | null> = {};
    columns.forEach((column, index) => {
      object[column] = row[index] ?? null;
    });
    return object;
  });
  return JSON.stringify(objects, null, 2);
}

/** Kept separate from the serialisers so those stay pure and testable. */
export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
