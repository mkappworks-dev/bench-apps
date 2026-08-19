import { tableKey } from "./tableIdentity";
import type { QualifiedTable } from "./tauri";

/** Wire-compatible with the Rust `PendingChange`. Field names are snake_case
 *  because serde reads them exactly as written, the same way `TableRows`
 *  already carries `pk_column`. */
export type PendingChange =
  | {
      kind: "update";
      table: QualifiedTable;
      pk_column: string;
      pk_value: string;
      column: string;
      /** ALWAYS the stored database value, never the currently staged one.
       *  This is what makes the set a diff instead of a log, and what the
       *  backend's `IS NOT DISTINCT FROM` guard compares against. */
      old_value: string | null;
      new_value: string | null;
    }
  | { kind: "insert"; table: QualifiedTable; values: Record<string, string | null> }
  | { kind: "delete"; table: QualifiedTable; pk_column: string; pk_value: string }
  | { kind: "sql"; table: QualifiedTable | null; statement: string; previewed_effect: string };

export type UpdateChange = Extract<PendingChange, { kind: "update" }>;

/** Wire-compatible with the Rust `ConflictReport`. */
export interface ConflictReport {
  index: number;
  table: string;
  description: string;
  column: string | null;
  expected: string | null;
  found: string | null;
  /** The primary key matched no row at all — distinct from `found: null`,
   *  which means the row is there holding NULL. */
  row_missing: boolean;
}

/** Wire-compatible with the Rust `ApplyOutcome`. */
export interface ApplyOutcome {
  applied: number;
  conflict: ConflictReport | null;
}

/** A NUL byte separates the parts, not a `:`. A colon can occur inside a
 *  primary-key value, which would let ("a:b", "c") and ("a", "b:c") key to the
 *  same string and cross two unrelated cells' entries. NUL cannot occur in a
 *  Postgres identifier, nor in a text value Postgres will store. */
function updateKey(table: QualifiedTable, pkValue: string, column: string): string {
  return `${tableKey(table)}\u0000${pkValue}\u0000${column}`;
}

/** Spec §10: comparison runs on typed values, not display strings.
 *
 *  On this wire a value is `string | null`, where `null` IS the SQL NULL and
 *  the string "NULL" is four ordinary characters. So identity comparison
 *  already IS the typed comparison the spec asks for, and the failure the spec
 *  warns about — a text cell holding "NULL" testing equal to a real NULL —
 *  cannot arise. This function exists so that reasoning has one home and one
 *  test, rather than being re-derived at every call site. */
export function sameStoredValue(a: string | null, b: string | null): boolean {
  return a === b;
}

function updateIndex(pending: PendingChange[], key: string): number {
  return pending.findIndex(
    (p) => p.kind === "update" && updateKey(p.table, p.pk_value, p.column) === key,
  );
}

export function discardAt(pending: PendingChange[], index: number): PendingChange[] {
  return pending.filter((_, i) => i !== index);
}

/** Spec §10: staging is an upsert-or-delete, not an append. A cell set back to
 *  its stored value removes its entry rather than adding a second one that
 *  cancels the first — otherwise toggling a checkbox twice would read
 *  "Pending 2" and Apply would write a value that is already there. */
export function stageUpdate(pending: PendingChange[], entry: UpdateChange): PendingChange[] {
  const at = updateIndex(pending, updateKey(entry.table, entry.pk_value, entry.column));
  if (sameStoredValue(entry.old_value, entry.new_value)) {
    return at >= 0 ? discardAt(pending, at) : pending;
  }
  if (at < 0) return [...pending, entry];
  return pending.map((p, i) => (i === at ? entry : p));
}

/** A discriminated result rather than `string | null | undefined`: a staged
 *  NULL and "nothing staged" are different facts, and collapsing them would
 *  make a cell staged to NULL render its stored value instead. */
export function stagedUpdateFor(
  pending: PendingChange[],
  table: QualifiedTable,
  pkValue: string,
  column: string,
): { staged: true; value: string | null } | { staged: false } {
  const at = updateIndex(pending, updateKey(table, pkValue, column));
  if (at < 0) return { staged: false };
  const hit = pending[at];
  // Narrowing only — updateIndex matches no other kind.
  return hit.kind === "update" ? { staged: true, value: hit.new_value } : { staged: false };
}

function deleteIndex(pending: PendingChange[], table: QualifiedTable, pkValue: string): number {
  return pending.findIndex(
    (p) => p.kind === "delete" && tableKey(p.table) === tableKey(table) && p.pk_value === pkValue,
  );
}

/** Staging the same row twice means "undo that", not "delete it twice" — the
 *  row action is the only control for it, so it has to be its own undo. */
export function toggleDelete(
  pending: PendingChange[],
  table: QualifiedTable,
  pkColumn: string,
  pkValue: string,
): PendingChange[] {
  const at = deleteIndex(pending, table, pkValue);
  if (at >= 0) return discardAt(pending, at);
  return [...pending, { kind: "delete", table, pk_column: pkColumn, pk_value: pkValue }];
}

export function hasStagedDelete(
  pending: PendingChange[],
  table: QualifiedTable,
  pkValue: string,
): boolean {
  return deleteIndex(pending, table, pkValue) >= 0;
}

export interface PendingGroup {
  label: string;
  /** `index` is the position in the WHOLE set, not in this group — a discard
   *  button and a `ConflictReport` both address that same position. */
  entries: { entry: PendingChange; index: number }[];
}

/** Spec §10: the panel groups by table. A `sql` entry has no table, so it
 *  files under its own heading rather than under one it might have touched. */
export function groupByTable(pending: PendingChange[]): PendingGroup[] {
  const groups: PendingGroup[] = [];
  pending.forEach((entry, index) => {
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
