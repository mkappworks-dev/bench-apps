import { tableKey } from "./tableIdentity";
import type { QualifiedTable } from "./tauri";

// connection_id is frontend-only — without it, a change staged against dev would apply against staging once the picker moved.
export type PendingChange =
  | {
      kind: "update";
      connection_id: string;
      table: QualifiedTable;
      pk_column: string;
      pk_value: string;
      column: string;
      // ALWAYS the stored value, never the staged one — what `IS NOT DISTINCT FROM` compares against.
      old_value: string | null;
      new_value: string | null;
    }
  | {
      kind: "insert";
      connection_id: string;
      table: QualifiedTable;
      values: Record<string, string | null>;
    }
  | {
      kind: "delete";
      connection_id: string;
      table: QualifiedTable;
      pk_column: string;
      pk_value: string;
    }
  | {
      kind: "sql";
      connection_id: string;
      table: QualifiedTable | null;
      statement: string;
      previewed_effect: string;
    };

export type UpdateChange = Extract<PendingChange, { kind: "update" }>;

export interface ConflictReport {
  index: number;
  table: string;
  description: string;
  column: string | null;
  expected: string | null;
  found: string | null;
  // Distinct from `found: null`, which is a row present holding NULL.
  row_missing: boolean;
}

export interface ApplyOutcome {
  applied: number;
  conflict: ConflictReport | null;
}

/** NUL, not `:`: a colon can occur inside a primary-key value, which would let
 *  ("a:b", "c") and ("a", "b:c") collide. NUL cannot occur in an identifier,
 *  a connection id, or a text value Postgres will store. */
function updateKey(
  connectionId: string,
  table: QualifiedTable,
  pkValue: string,
  column: string,
): string {
  return `${connectionId}\u0000${tableKey(table)}\u0000${pkValue}\u0000${column}`;
}

// `null` IS the SQL NULL; the string "NULL" is four ordinary characters, so identity comparison already is the typed comparison.
export function sameStoredValue(a: string | null, b: string | null): boolean {
  return a === b;
}

function updateIndex(pending: PendingChange[], key: string): number {
  return pending.findIndex(
    (p) =>
      p.kind === "update" &&
      updateKey(p.connection_id, p.table, p.pk_value, p.column) === key,
  );
}

export function discardAt(pending: PendingChange[], index: number): PendingChange[] {
  return pending.filter((_, i) => i !== index);
}

// By identity, not value: the set may have grown during the round trip, and Apply must drop only what it SENT.
export function removeEntries(
  pending: PendingChange[],
  entries: PendingChange[],
): PendingChange[] {
  return pending.filter((p) => !entries.includes(p));
}

export function entriesForOtherConnections(
  pending: PendingChange[],
  connectionId: string | null,
): PendingChange[] {
  if (!connectionId) return pending;
  return pending.filter((p) => p.connection_id !== connectionId);
}

export function stageUpdate(pending: PendingChange[], entry: UpdateChange): PendingChange[] {
  const at = updateIndex(
    pending,
    updateKey(entry.connection_id, entry.table, entry.pk_value, entry.column),
  );
  if (sameStoredValue(entry.old_value, entry.new_value)) {
    return at >= 0 ? discardAt(pending, at) : pending;
  }
  if (at < 0) return [...pending, entry];
  return pending.map((p, i) => (i === at ? entry : p));
}

// A staged NULL and "nothing staged" are different facts — collapsing them would make a cell staged to NULL render its stored value.
export function stagedUpdateFor(
  pending: PendingChange[],
  connectionId: string,
  table: QualifiedTable,
  pkValue: string,
  column: string,
): { staged: true; value: string | null } | { staged: false } {
  const at = updateIndex(pending, updateKey(connectionId, table, pkValue, column));
  if (at < 0) return { staged: false };
  const hit = pending[at];
  return hit.kind === "update" ? { staged: true, value: hit.new_value } : { staged: false };
}

function deleteIndex(
  pending: PendingChange[],
  connectionId: string,
  table: QualifiedTable,
  pkValue: string,
): number {
  return pending.findIndex(
    (p) =>
      p.kind === "delete" &&
      p.connection_id === connectionId &&
      tableKey(p.table) === tableKey(table) &&
      p.pk_value === pkValue,
  );
}

export function toggleDelete(
  pending: PendingChange[],
  connectionId: string,
  table: QualifiedTable,
  pkColumn: string,
  pkValue: string,
): PendingChange[] {
  const at = deleteIndex(pending, connectionId, table, pkValue);
  if (at >= 0) return discardAt(pending, at);
  return [
    ...pending,
    { kind: "delete", connection_id: connectionId, table, pk_column: pkColumn, pk_value: pkValue },
  ];
}

export function hasStagedDelete(
  pending: PendingChange[],
  connectionId: string,
  table: QualifiedTable,
  pkValue: string,
): boolean {
  return deleteIndex(pending, connectionId, table, pkValue) >= 0;
}

// Index into the WHOLE set, not the grouped view — a discard button and ConflictReport.index both address it directly.
export interface IndexedChange {
  entry: PendingChange;
  index: number;
}

export function indexChanges(pending: PendingChange[]): IndexedChange[] {
  return pending.map((entry, index) => ({ entry, index }));
}

export interface PendingGroup {
  label: string;
  entries: IndexedChange[];
}

export function groupByTable(entries: IndexedChange[]): PendingGroup[] {
  const groups: PendingGroup[] = [];
  entries.forEach(({ entry, index }) => {
    const label = entry.table ? tableKey(entry.table) : "SQL";
    let group = groups.find((g) => g.label === label);
    if (!group) {
      group = { label, entries: [] };
      groups.push(group);
    }
    group.entries.push({ entry, index });
  });
  return groups;
}
