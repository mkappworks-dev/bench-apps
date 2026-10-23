import { describe, expect, it } from "vitest";
import { normalizeTable, tableKey } from "./tableIdentity";

describe("normalizeTable", () => {
  it("resolves a bare string to the public schema", () => {
    expect(normalizeTable("orders")).toEqual({ schema: "public", name: "orders" });
  });

  it("passes a qualified object through unchanged", () => {
    const table = { schema: "alt", name: "orders" };
    expect(normalizeTable(table)).toEqual(table);
  });

  it("resolves null to null", () => {
    expect(normalizeTable(null)).toBeNull();
  });

  it("resolves undefined to null — a tab that has never had a table selected", () => {
    expect(normalizeTable(undefined)).toBeNull();
  });

  // The whole reason this takes `unknown`: tab state is a caller-populated
  // `Record<string, unknown>` bag, not something the type system validated on
  // the way in. Anything that isn't actually a table identity must resolve to
  // null rather than being cast through and trusted.
  it("resolves anything that isn't a string or a {schema, name} object to null", () => {
    expect(normalizeTable(42)).toBeNull();
    expect(normalizeTable(true)).toBeNull();
    expect(normalizeTable(["public", "orders"])).toBeNull();
    expect(normalizeTable({})).toBeNull();
    expect(normalizeTable({ schema: "public" })).toBeNull();
    expect(normalizeTable({ name: "orders" })).toBeNull();
    expect(normalizeTable({ schema: "public", name: 42 })).toBeNull();
    expect(normalizeTable({ schema: null, name: "orders" })).toBeNull();
  });
});

describe("tableKey", () => {
  // This exact format is persisted in localStorage grid-layout keys — do not
  // "improve" the separator without a migration.
  it("joins schema and name with a dot", () => {
    expect(tableKey({ schema: "public", name: "orders" })).toBe("public.orders");
    expect(tableKey({ schema: "alt", name: "dup" })).toBe("alt.dup");
  });
});
