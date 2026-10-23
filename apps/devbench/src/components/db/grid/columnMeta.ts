import type { ColumnFamily } from "./types";

/** Wire-compatible with the Rust `ForeignKeyRef`. */
export interface ForeignKeyRef {
  schema: string;
  table: string;
  column: string;
}

/** Wire-compatible with the Rust `ColumnInfo`. Field names are snake_case
 *  because serde emits them exactly as written, the same way `TableRows`
 *  already carries `pk_column`. */
export interface ColumnInfo {
  name: string;
  /** Postgres physical type name: `int4`, `text`, `bool`, `timestamptz`. */
  udt: string;
  nullable: boolean;
  default_expr: string | null;
  /** The database assigns this value — identity, generated, or serial. */
  is_identity: boolean;
  references: ForeignKeyRef | null;
}

const BOOLEAN_UDTS = new Set(["bool"]);

/** Spec §4 gives numerics and dates one operator set, because `>` and `<`
 *  answer something for both. The family names the operator set it selects,
 *  not a JavaScript type — which is why a timestamp lands under "number". */
const ORDERED_UDTS = new Set([
  "int2", "int4", "int8", "float4", "float8", "numeric", "money",
  "date", "timestamp", "timestamptz", "time", "timetz",
]);

const NUMERIC_UDTS = new Set(["int2", "int4", "int8", "float4", "float8", "numeric", "money"]);

/** Narrower than the `"number"` filter family, which also covers dates because
 *  `>` and `<` answer something for both. This one drives a real `<input
 *  type="number">` in the insert panel, where a date would be unusable. */
export function isNumericUdt(udt: string): boolean {
  return NUMERIC_UDTS.has(udt);
}

export function familyOfUdt(udt: string): ColumnFamily {
  if (BOOLEAN_UDTS.has(udt)) return "boolean";
  if (ORDERED_UDTS.has(udt)) return "number";
  return "text";
}

export function columnInfoOf(meta: ColumnInfo[], column: string): ColumnInfo | null {
  return meta.find((c) => c.name === column) ?? null;
}

/** Text is the fallback rather than an error: metadata is absent on the first
 *  render and after a failed describe, and text's operators work on any
 *  column, so the filter stays usable instead of disappearing. */
export function familyOfColumn(meta: ColumnInfo[], column: string): ColumnFamily {
  const info = columnInfoOf(meta, column);
  return info ? familyOfUdt(info.udt) : "text";
}

export function fkTargetOf(meta: ColumnInfo[], column: string): ForeignKeyRef | null {
  return columnInfoOf(meta, column)?.references ?? null;
}

/** Spec §8: the link icon marks a value you can follow. NULL follows nowhere,
 *  and `<unsupported type>` is not the value — it is the grid reporting it
 *  could not decode one, so there is nothing to look up. */
export function canFollow(meta: ColumnInfo[], column: string, value: string | null): boolean {
  return fkTargetOf(meta, column) !== null && value !== null && value !== "<unsupported type>";
}

export function describeTarget(target: ForeignKeyRef): string {
  return `${target.schema}.${target.table}.${target.column}`;
}
