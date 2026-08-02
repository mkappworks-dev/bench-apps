/** Wire-compatible with the Rust `FilterOp` (serde snake_case). */
export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "lt"
  | "contains"
  | "starts_with"
  | "is_null"
  | "is_not_null"
  | "is_true"
  | "is_false";

export interface FilterCondition {
  column: string;
  op: FilterOp;
  /** null for operators that take no value. */
  value: string | null;
  /** An unticked rule is kept but excluded from the query. */
  enabled: boolean;
}

export interface SortTerm {
  column: string;
  descending: boolean;
  enabled: boolean;
}

/** Operators that need no value — used for both the UI and the inert check. */
export const VALUELESS_OPS: FilterOp[] = ["is_null", "is_not_null", "is_true", "is_false"];

export const OP_LABELS: Record<FilterOp, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  lt: "<",
  contains: "contains",
  starts_with: "starts with",
  is_null: "is null",
  is_not_null: "is not null",
  is_true: "is true",
  is_false: "is false",
};

/** Slice 1 infers the family from the value, as the grid already does.
 *  Slice 2 replaces this with the real type from `describe_columns`. */
export type ColumnFamily = "text" | "number" | "boolean";

export const OPERATORS_FOR_FAMILY: Record<ColumnFamily, FilterOp[]> = {
  text: ["eq", "ne", "contains", "starts_with", "is_null", "is_not_null"],
  number: ["eq", "ne", "gt", "lt", "is_null", "is_not_null"],
  boolean: ["is_true", "is_false", "is_null", "is_not_null"],
};

export function inferFamily(sampleValue: string | null): ColumnFamily {
  if (sampleValue === "true" || sampleValue === "false") return "boolean";
  if (sampleValue !== null && /^-?\d+(\.\d+)?$/.test(sampleValue)) return "number";
  return "text";
}

/** A condition the backend will skip: unticked, or needing a value it lacks. */
export function isActiveCondition(condition: FilterCondition): boolean {
  if (!condition.enabled) return false;
  if (VALUELESS_OPS.includes(condition.op)) return true;
  return (condition.value ?? "").trim() !== "";
}

export function activeConditions(conditions: FilterCondition[]): FilterCondition[] {
  return conditions.filter(isActiveCondition);
}

export function activeSortTerms(terms: SortTerm[]): SortTerm[] {
  return terms.filter((t) => t.enabled);
}
