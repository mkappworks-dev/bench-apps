import { beforeEach, describe, expect, it } from "vitest";
import { readQueryRollbackFailures, writeQueryRollbackFailures } from "./queryRollbackFailures";

describe("query rollback failure persistence", () => {
  beforeEach(() => localStorage.clear());

  it("restores unresolved outcomes after app-state reconstruction", () => {
    const failures = { '["c1","q1"]': { queryId: "q1", connectionId: "c1", message: "connection lost" } };
    writeQueryRollbackFailures(failures);
    expect(readQueryRollbackFailures()).toEqual(failures);
    writeQueryRollbackFailures({});
    expect(readQueryRollbackFailures()).toEqual({});
  });

  it("recovers from corrupt storage without losing app startup", () => {
    localStorage.setItem("devbench:query-rollback-failures", "broken json");
    expect(readQueryRollbackFailures()).toEqual({});
  });
});
