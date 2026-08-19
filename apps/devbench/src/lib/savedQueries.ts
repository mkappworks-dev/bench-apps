/** Wire-compatible with the Rust `SavedQuery`. Field names are snake_case
 *  because serde reads them exactly as written, the same way `TableRows`
 *  already carries `pk_column`. */
export interface SavedQuery {
  id: string;
  connection_id: string;
  name: string;
  sql: string;
  /** Epoch milliseconds. Orders the rail; a rename never changes it. */
  created_at: number;
}

/** The list is global while a connection is not — same shape, and same
 *  reason, as `pending` (see `pendingChanges.ts`). The rail loads one
 *  connection's queries at a time, and a query tab pinned to a different
 *  connection has already contributed its own entry, so loading must merge
 *  rather than replace or that tab's label goes blank. */
export function mergeSavedQueries(existing: SavedQuery[], incoming: SavedQuery[]): SavedQuery[] {
  const byId = new Map(existing.map((q) => [q.id, q]));
  incoming.forEach((q) => byId.set(q.id, q));
  return [...byId.values()];
}

/** Sorted the same way `list_saved_queries` sorts, so the rail does not
 *  reorder between a server list and a locally-merged one. */
export function queriesForConnection(all: SavedQuery[], connectionId: string | null): SavedQuery[] {
  if (!connectionId) return [];
  return all
    .filter((q) => q.connection_id === connectionId)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

/** `null` rather than `undefined` for a miss: a query tab whose row has not
 *  loaded yet and one whose row is genuinely gone both render a fallback
 *  label, and no caller benefits from telling them apart. */
export function savedQueryById(all: SavedQuery[], id: string | null): SavedQuery | null {
  if (!id) return null;
  return all.find((q) => q.id === id) ?? null;
}
