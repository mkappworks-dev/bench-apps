import type { QualifiedTable } from "./tauri";

/** Tab state persisted before schemas existed holds a bare name. Treat it as
 *  public rather than dropping the selection — the same assumption migration
 *  0007 makes for watched tables, for the same reason. `table` is typed
 *  `unknown` because every caller reads it out of a tab's untyped state bag
 *  (`Record<string, unknown>`) — anything that isn't a string or a
 *  `{schema, name}` object resolves to `null` rather than being passed
 *  through as if it were validated. */
export function normalizeTable(table: unknown): QualifiedTable | null {
  if (typeof table === "string") return { schema: "public", name: table };
  if (
    typeof table === "object" &&
    table !== null &&
    typeof (table as { schema?: unknown }).schema === "string" &&
    typeof (table as { name?: unknown }).name === "string"
  ) {
    return table as QualifiedTable;
  }
  return null;
}
