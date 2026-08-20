/** Wire-compatible with the Rust `SavedQuery`; serde reads the names as written. */
export interface SavedQuery {
  id: string;
  connection_id: string;
  name: string;
  sql: string;
  /** Epoch milliseconds. Orders the rail; a rename never changes it. */
  created_at: number;
}

/** Global while a connection is not. Loading must MERGE rather than replace: a
 *  query tab pinned elsewhere has already contributed its entry, and replacing
 *  would blank that tab's label. */
export function mergeSavedQueries(existing: SavedQuery[], incoming: SavedQuery[]): SavedQuery[] {
  const byId = new Map(existing.map((q) => [q.id, q]));
  incoming.forEach((q) => byId.set(q.id, q));
  return [...byId.values()];
}

/** Sorted as `list_saved_queries` sorts, so the rail does not reorder between a
 *  server list and a locally-merged one. */
export function queriesForConnection(all: SavedQuery[], connectionId: string | null): SavedQuery[] {
  if (!connectionId) return [];
  return all
    .filter((q) => q.connection_id === connectionId)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

/** `null` for a miss: not-yet-loaded and genuinely-gone both render a fallback. */
export function savedQueryById(all: SavedQuery[], id: string | null): SavedQuery | null {
  if (!id) return null;
  return all.find((q) => q.id === id) ?? null;
}
