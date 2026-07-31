import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeListHistory, invokeRunCorrelatedRequest } from "./tauri";

/**
 * Why this file asserts raw `invoke` payloads instead of spying on the wrappers.
 *
 * `lib/tauri.ts` is the only place the TS→Rust argument boundary is spelled out,
 * and that boundary is name-sensitive in a way nothing else in the toolchain
 * checks. Tauri v2 maps a camelCase JS key onto the snake_case Rust parameter
 * of the same name: `{ sessionId }` binds `session_id: Option<String>`. Write
 * `{ session_id }` here instead and Tauri finds no matching argument, passes
 * `None`, and the command still succeeds — every fired request would be saved
 * unattributed and every read would come back unscoped. Session scoping would
 * become a silent no-op.
 *
 * Nothing else catches that. `tsc` sees a valid object literal, `cargo test`
 * exercises the Rust side directly and never crosses the bridge, and every other
 * frontend test mocks these wrapper functions — so the payload they build is the
 * one thing never observed. Hence: assert the key NAMES, exactly, against the
 * mocked `invoke` (set up globally in `src/test-setup.ts`).
 *
 * The `null` cases are equally load-bearing. `undefined` is dropped during
 * serialisation, so an omitted `sessionId` must reach the bridge as an explicit
 * `null` — which is what `?? null` in the wrappers is for.
 */

const invoked = vi.mocked(invoke);

/** The `[command, payload]` pair of the most recent `invoke` call. */
function lastInvoke(): [string, Record<string, unknown>] {
  const call = invoked.mock.calls.at(-1);
  if (!call) throw new Error("invoke was never called");
  return [call[0] as string, call[1] as Record<string, unknown>];
}

const connection = { host: "localhost", port: 5432, database: "d", username: "u", password: "p" };

describe("invokeListHistory", () => {
  beforeEach(() => {
    invoked.mockClear();
  });

  it("sends the session id under the camelCase key Tauri maps to `session_id`", async () => {
    await invokeListHistory("sess-1");

    expect(invoked).toHaveBeenCalledWith("list_history", { sessionId: "sess-1" });
    const [command, payload] = lastInvoke();
    expect(command).toBe("list_history");
    expect(Object.keys(payload)).toEqual(["sessionId"]);
    expect(payload).not.toHaveProperty("session_id");
  });

  it("sends an explicit null — not undefined — when no session is given", async () => {
    await invokeListHistory();

    const [command, payload] = lastInvoke();
    expect(command).toBe("list_history");
    expect(payload).toStrictEqual({ sessionId: null });
    expect(payload.sessionId).toBeNull();
    // An `undefined` value would vanish from the serialised payload entirely,
    // which is indistinguishable to Rust from never sending the key.
    expect(JSON.stringify(payload)).toBe('{"sessionId":null}');
  });

  it("sends an explicit null when the session is null", async () => {
    await invokeListHistory(null);

    const [, payload] = lastInvoke();
    expect(payload).toStrictEqual({ sessionId: null });
    expect(JSON.stringify(payload)).toBe('{"sessionId":null}');
  });
});

describe("invokeRunCorrelatedRequest", () => {
  beforeEach(() => {
    invoked.mockClear();
  });

  it("sends the session id alongside the request, connection, and watched tables", async () => {
    await invokeRunCorrelatedRequest({
      request: { method: "GET", url: "/api/orders" },
      connection,
      watchedTables: ["orders"],
      sessionId: "sess-1",
    });

    const [command, payload] = lastInvoke();
    expect(command).toBe("run_correlated_request");
    expect(payload).toStrictEqual({
      request: { method: "GET", url: "/api/orders" },
      connection,
      watchedTables: ["orders"],
      sessionId: "sess-1",
    });
    // Ordering is irrelevant to Tauri, but an unexpected or renamed key is not.
    expect(Object.keys(payload).sort()).toEqual([
      "connection",
      "request",
      "sessionId",
      "watchedTables",
    ]);
  });

  it("sends an explicit null session id when the send is unattributed", async () => {
    await invokeRunCorrelatedRequest({
      request: { method: "GET", url: "/api/orders" },
      connection,
      watchedTables: [],
    });

    const [, payload] = lastInvoke();
    expect(payload).toStrictEqual({
      request: { method: "GET", url: "/api/orders" },
      connection,
      watchedTables: [],
      sessionId: null,
    });
    expect(payload.sessionId).toBeNull();
    expect(JSON.stringify(payload)).toContain('"sessionId":null');
  });
});
