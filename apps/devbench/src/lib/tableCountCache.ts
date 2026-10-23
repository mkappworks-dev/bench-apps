import type { FilterCondition, QualifiedTable } from "./tauri";

export function createTableCountCache() {
  const entries = new Map<string, { connectionId: string; table: QualifiedTable; promise: Promise<number> }>();

  return {
    get(sessionId: string | null, connectionId: string, table: QualifiedTable, filter: FilterCondition[], load: () => Promise<number>) {
      const key = JSON.stringify([sessionId, connectionId, table.schema, table.name, filter]);
      const cached = entries.get(key);
      if (cached) return cached.promise;
      const promise = Promise.resolve().then(load);
      const entry = { connectionId, table: { ...table }, promise };
      entries.set(key, entry);
      void promise.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return promise;
    },
    invalidateConnection(connectionId: string) {
      for (const [key, entry] of entries) {
        if (entry.connectionId === connectionId) entries.delete(key);
      }
    },
    invalidateTable(connectionId: string, table: QualifiedTable) {
      for (const [key, entry] of entries) {
        if (entry.connectionId === connectionId && entry.table.schema === table.schema && entry.table.name === table.name) entries.delete(key);
      }
    },
  };
}

export const tableCountCache = createTableCountCache();
