import { describe, expect, it } from "vitest";
import { createTableCountCache } from "./tableCountCache";

const TABLE = { schema: "public", name: "orders" };
const FILTER = [{ column: "status", op: "eq" as const, value: "paid", enabled: true }];

describe("tableCountCache", () => {
  it("shares an in-flight count and reuses its resolved value", async () => {
    const cache = createTableCountCache();
    let finish!: (count: number) => void;
    const pending = new Promise<number>((resolve) => { finish = resolve; });
    const first = cache.get(null, "c1", TABLE, [], () => pending);
    const second = cache.get(null, "c1", TABLE, [], () => Promise.resolve(99));
    expect(second).toBe(first);
    finish(12);
    expect(await second).toBe(12);
    expect(await cache.get(null, "c1", TABLE, [], () => Promise.resolve(99))).toBe(12);
  });

  it("separates sessions, connections, schemas, tables and filters", async () => {
    const cache = createTableCountCache();
    await cache.get(null, "c1", TABLE, [], () => Promise.resolve(1));
    expect(await cache.get("session", "c1", TABLE, [], () => Promise.resolve(2))).toBe(2);
    expect(await cache.get(null, "c2", TABLE, [], () => Promise.resolve(3))).toBe(3);
    expect(await cache.get(null, "c1", { ...TABLE, schema: "other" }, [], () => Promise.resolve(4))).toBe(4);
    expect(await cache.get(null, "c1", { ...TABLE, name: "users" }, [], () => Promise.resolve(5))).toBe(5);
    expect(await cache.get(null, "c1", TABLE, FILTER, () => Promise.resolve(6))).toBe(6);
  });

  it("retries a rejected count instead of caching a failure", async () => {
    const cache = createTableCountCache();
    await expect(cache.get(null, "c1", TABLE, [], () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(await cache.get(null, "c1", TABLE, [], () => Promise.resolve(7))).toBe(7);
  });

  it("invalidates every filter for a table without dropping another table", async () => {
    const cache = createTableCountCache();
    await cache.get(null, "c1", TABLE, [], () => Promise.resolve(1));
    await cache.get(null, "c1", TABLE, FILTER, () => Promise.resolve(2));
    const other = { ...TABLE, name: "users" };
    await cache.get(null, "c1", other, [], () => Promise.resolve(3));
    cache.invalidateTable("c1", TABLE);
    expect(await cache.get(null, "c1", TABLE, [], () => Promise.resolve(10))).toBe(10);
    expect(await cache.get(null, "c1", TABLE, FILTER, () => Promise.resolve(20))).toBe(20);
    expect(await cache.get(null, "c1", other, [], () => Promise.resolve(30))).toBe(3);
  });

  it.each(["resolve", "reject"] as const)("keeps invalidated counts out when an older request will %s", async (outcome) => {
    const cache = createTableCountCache();
    let reject!: (error: Error) => void;
    let finish!: (count: number) => void;
    const old = cache.get(null, "c1", TABLE, [], () => new Promise<number>((resolve, fail) => { finish = resolve; reject = fail; }));
    cache.invalidateConnection("c1");
    expect(await cache.get(null, "c1", TABLE, [], () => Promise.resolve(8))).toBe(8);
    if (outcome === "reject") {
      reject(new Error("old request failed"));
      await expect(old).rejects.toThrow("old request failed");
    } else {
      finish(3);
      expect(await old).toBe(3);
    }
    expect(await cache.get(null, "c1", TABLE, [], () => Promise.resolve(99))).toBe(8);
  });
});
