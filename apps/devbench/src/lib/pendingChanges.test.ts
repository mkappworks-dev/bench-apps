import { describe, expect, it } from "vitest";
import {
  discardAt,
  groupByTable,
  hasStagedDelete,
  sameStoredValue,
  stageUpdate,
  stagedUpdateFor,
  toggleDelete,
  type PendingChange,
  type UpdateChange,
} from "./pendingChanges";

const ORDERS = { schema: "public", name: "orders" };
const USERS = { schema: "public", name: "users" };

function edit(pkValue: string, column: string, oldValue: string | null, newValue: string | null): UpdateChange {
  return {
    kind: "update",
    table: ORDERS,
    pk_column: "id",
    pk_value: pkValue,
    column,
    old_value: oldValue,
    new_value: newValue,
  };
}

describe("pendingChanges", () => {
  it("stages a cell that differs from its stored value", () => {
    const next = stageUpdate([], edit("1", "status", "pending", "shipped"));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: "update", column: "status", new_value: "shipped" });
  });

  it("replaces the entry for a cell rather than appending a second one", () => {
    const once = stageUpdate([], edit("1", "status", "pending", "shipped"));
    const twice = stageUpdate(once, edit("1", "status", "pending", "cancelled"));
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ new_value: "cancelled" });
  });

  // Spec §10: without this the set is append-only, "Pending 2" would be a lie,
  // and Apply would write a value that is already there.
  it("leaves no pending change when a boolean is toggled back to its stored value", () => {
    const on = stageUpdate([], edit("1", "paid", "false", "true"));
    const off = stageUpdate(on, edit("1", "paid", "false", "false"));
    expect(off).toEqual([]);
  });

  it("leaves no pending change when a text edit is typed back to its stored value", () => {
    const changed = stageUpdate([], edit("1", "status", "pending", "shipped"));
    const back = stageUpdate(changed, edit("1", "status", "pending", "pending"));
    expect(back).toEqual([]);
  });

  it("keeps one entry per cell, not one per row", () => {
    let pending: PendingChange[] = [];
    pending = stageUpdate(pending, edit("1", "status", "pending", "shipped"));
    pending = stageUpdate(pending, edit("1", "notes", null, "checked"));
    expect(pending).toHaveLength(2);
  });

  // A text column holding the four characters N-U-L-L is a value; a real NULL
  // is the absence of one. Comparing display strings would silently drop the
  // change that turns one into the other.
  it('never treats a text value of "NULL" as equal to a real NULL', () => {
    expect(sameStoredValue("NULL", null)).toBe(false);
    expect(sameStoredValue(null, null)).toBe(true);
    expect(sameStoredValue("NULL", "NULL")).toBe(true);
  });

  it("distinguishes a staged NULL from nothing staged", () => {
    const pending = stageUpdate([], edit("1", "notes", "something", null));
    expect(stagedUpdateFor(pending, ORDERS, "1", "notes")).toEqual({ staged: true, value: null });
    expect(stagedUpdateFor(pending, ORDERS, "1", "status")).toEqual({ staged: false });
  });

  it("does not confuse the same primary key in two different tables", () => {
    const pending = stageUpdate([], edit("1", "status", "pending", "shipped"));
    expect(stagedUpdateFor(pending, USERS, "1", "status")).toEqual({ staged: false });
  });

  it("toggles a row delete on and back off", () => {
    const staged = toggleDelete([], ORDERS, "id", "7");
    expect(staged).toHaveLength(1);
    expect(hasStagedDelete(staged, ORDERS, "7")).toBe(true);
    expect(toggleDelete(staged, ORDERS, "id", "7")).toEqual([]);
  });

  it("groups by table in first-appearance order, keeping each entry's index in the whole set", () => {
    const pending: PendingChange[] = [
      edit("1", "status", "pending", "shipped"),
      { kind: "delete", table: USERS, pk_column: "id", pk_value: "9" },
      edit("2", "status", "pending", "failed"),
      { kind: "sql", table: null, statement: "DELETE FROM audit", previewed_effect: "3 rows affected" },
    ];
    const groups = groupByTable(pending);
    expect(groups.map((g) => g.label)).toEqual(["public.orders", "public.users", "SQL"]);
    expect(groups[0].entries.map((e) => e.index)).toEqual([0, 2]);
    expect(groups[2].entries[0].index).toBe(3);
  });

  it("discards one entry by its index in the whole set", () => {
    const pending: PendingChange[] = [
      edit("1", "status", "pending", "shipped"),
      edit("2", "status", "pending", "failed"),
    ];
    expect(discardAt(pending, 0)).toHaveLength(1);
    expect(discardAt(pending, 0)[0]).toMatchObject({ pk_value: "2" });
  });
});
