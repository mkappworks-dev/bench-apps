export interface QueryRollbackFailure {
  queryId: string;
  connectionId: string;
  message: string;
}

export type QueryRollbackFailures = Record<string, QueryRollbackFailure>;
const STORAGE_KEY = "devbench:query-rollback-failures";

export function queryRollbackKey(queryId: string, connectionId: string): string {
  return JSON.stringify([connectionId, queryId]);
}

export function readQueryRollbackFailures(): QueryRollbackFailures {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const failures: QueryRollbackFailures = {};
    for (const value of Object.values(parsed)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<QueryRollbackFailure>;
      if (typeof entry.queryId === "string" && typeof entry.connectionId === "string" && typeof entry.message === "string") {
        failures[queryRollbackKey(entry.queryId, entry.connectionId)] = { queryId: entry.queryId, connectionId: entry.connectionId, message: entry.message };
      }
    }
    return failures;
  } catch { return {}; }
}

export function writeQueryRollbackFailures(failures: QueryRollbackFailures): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(failures)); } catch { /* Storage can be unavailable; the live warning remains in the store. */ }
}
