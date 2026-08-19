import { describe, expect, it } from "vitest";
import { mergeSavedQueries, queriesForConnection, savedQueryById, type SavedQuery } from "./savedQueries";

function q(id: string, connectionId: string, name: string, createdAt: number): SavedQuery {
  return { id, connection_id: connectionId, name, sql: "", created_at: createdAt };
}

describe("mergeSavedQueries", () => {
  it("replaces an entry by id rather than appending a second copy", () => {
    const before = [q("a", "c1", "old", 1)];
    const after = mergeSavedQueries(before, [q("a", "c1", "new", 1)]);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("new");
  });

  // The rail loads one connection's list; a query tab pinned to another
  // connection has already put its own entry here. A merge that replaced the
  // array would blank that tab's label.
  it("leaves another connection's entries untouched", () => {
    const before = [q("a", "c1", "dev", 1), q("b", "c2", "staging", 1)];
    const after = mergeSavedQueries(before, [q("a", "c1", "dev renamed", 1)]);
    expect(after.map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(savedQueryById(after, "b")?.name).toBe("staging");
  });

  it("appends entries it has not seen", () => {
    const after = mergeSavedQueries([q("a", "c1", "one", 1)], [q("b", "c1", "two", 2)]);
    expect(after).toHaveLength(2);
  });
});

describe("queriesForConnection", () => {
  it("selects one connection's queries in creation order, id breaking ties", () => {
    const all = [q("z", "c1", "third", 5), q("a", "c1", "tied", 5), q("m", "c1", "first", 1), q("x", "c2", "other", 0)];
    expect(queriesForConnection(all, "c1").map((x) => x.id)).toEqual(["m", "a", "z"]);
  });

  it("is empty when no connection is selected", () => {
    expect(queriesForConnection([q("a", "c1", "one", 1)], null)).toEqual([]);
  });
});

describe("savedQueryById", () => {
  it("returns null rather than undefined for a miss", () => {
    expect(savedQueryById([q("a", "c1", "one", 1)], "nope")).toBeNull();
    expect(savedQueryById([q("a", "c1", "one", 1)], null)).toBeNull();
  });
});
