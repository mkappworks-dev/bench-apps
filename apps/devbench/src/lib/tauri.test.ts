import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeClearEmails,
  invokeCollectCorrelationWindow,
  invokeListEmails,
  invokeListHistory,
  invokeRunCorrelatedRequest,
} from "./tauri";

/**
 * Asserts raw `invoke` payloads rather than spying on the wrappers, because
 * `lib/tauri.ts` is the only place the TS→Rust argument boundary is spelled
 * out. Tauri v2 maps a camelCase JS key to the same-named snake_case Rust
 * param; write `session_id` here and Tauri finds no match, passes `None`,
 * and the command still succeeds — session scoping becomes a silent no-op.
 * Nothing else catches that (`tsc` sees a valid object, `cargo test` never
 * crosses the bridge, every other test mocks these wrappers), so this file
 * checks the key NAMES against the mocked `invoke` (`src/test-setup.ts`).
 *
 * `null` vs `undefined` matters too: `undefined` is dropped during
 * serialisation, so an omitted `sessionId` must reach the bridge as `null`.
 */

const invoked = vi.mocked(invoke);

/** The `[command, payload]` pair of the most recent `invoke` call. */
function lastInvoke(): [string, Record<string, unknown>] {
  const call = invoked.mock.calls.at(-1);
  if (!call) throw new Error("invoke was never called");
  return [call[0] as string, call[1] as Record<string, unknown>];
}

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

  it("sends the session id alongside the request, connection id, and watched tables", async () => {
    await invokeRunCorrelatedRequest({
      request: { method: "GET", url: "/api/orders" },
      connectionId: "c1",
      watchedTables: ["orders"],
      sessionId: "sess-1",
    });

    const [command, payload] = lastInvoke();
    expect(command).toBe("run_correlated_request");
    expect(payload).toStrictEqual({
      request: { method: "GET", url: "/api/orders" },
      connectionId: "c1",
      watchedTables: ["orders"],
      sessionId: "sess-1",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "connectionId",
      "request",
      "sessionId",
      "watchedTables",
    ]);
  });

  it("sends an explicit null session id when the send is unattributed", async () => {
    await invokeRunCorrelatedRequest({
      request: { method: "GET", url: "/api/orders" },
      connectionId: "c1",
      watchedTables: [],
    });

    const [, payload] = lastInvoke();
    expect(payload).toStrictEqual({
      request: { method: "GET", url: "/api/orders" },
      connectionId: "c1",
      watchedTables: [],
      sessionId: null,
    });
    expect(payload.sessionId).toBeNull();
    expect(JSON.stringify(payload)).toContain('"sessionId":null');
  });
});

describe("invokeListEmails", () => {
  beforeEach(() => {
    invoked.mockClear();
  });

  it("sends the session id under the camelCase key Tauri maps to `session_id`", async () => {
    await invokeListEmails("sess-1", 5_000);

    expect(invoked).toHaveBeenCalledWith("list_emails", { sessionId: "sess-1", limit: 5_000 });
    const [command, payload] = lastInvoke();
    expect(command).toBe("list_emails");
    expect(Object.keys(payload).sort()).toEqual(["limit", "sessionId"]);
    expect(payload).not.toHaveProperty("session_id");
  });

  it("sends an explicit null when the session is null", async () => {
    await invokeListEmails(null, 5_000);

    const [command, payload] = lastInvoke();
    expect(command).toBe("list_emails");
    expect(payload).toStrictEqual({ sessionId: null, limit: 5_000 });
    expect(payload.sessionId).toBeNull();
    expect(JSON.stringify(payload)).toContain('"sessionId":null');
  });
});

describe("invokeCollectCorrelationWindow", () => {
  beforeEach(() => {
    invoked.mockClear();
  });

  it("sends the history id under the camelCase key Tauri maps to `history_id`", async () => {
    await invokeCollectCorrelationWindow("corr-1", "hist-1");

    expect(invoked).toHaveBeenCalledWith("collect_correlation_window", {
      correlationId: "corr-1",
      historyId: "hist-1",
    });
    const [command, payload] = lastInvoke();
    expect(command).toBe("collect_correlation_window");
    expect(Object.keys(payload).sort()).toEqual(["correlationId", "historyId"]);
    expect(payload).not.toHaveProperty("history_id");
  });

  it("sends an explicit null when no history row was saved", async () => {
    await invokeCollectCorrelationWindow("corr-1", null);

    const [, payload] = lastInvoke();
    expect(payload).toStrictEqual({ correlationId: "corr-1", historyId: null });
    expect(payload.historyId).toBeNull();
    expect(JSON.stringify(payload)).toBe('{"correlationId":"corr-1","historyId":null}');
  });
});

describe("invokeClearEmails", () => {
  beforeEach(() => {
    invoked.mockClear();
  });

  it("sends the session id under the camelCase key Tauri maps to `session_id`", async () => {
    await invokeClearEmails("sess-1");

    expect(invoked).toHaveBeenCalledWith("clear_emails", { sessionId: "sess-1" });
    const [command, payload] = lastInvoke();
    expect(command).toBe("clear_emails");
    expect(Object.keys(payload)).toEqual(["sessionId"]);
    expect(payload).not.toHaveProperty("session_id");
  });

  it("sends an explicit null when the session is null", async () => {
    await invokeClearEmails(null);

    const [command, payload] = lastInvoke();
    expect(command).toBe("clear_emails");
    expect(payload).toStrictEqual({ sessionId: null });
    expect(payload.sessionId).toBeNull();
    expect(JSON.stringify(payload)).toBe('{"sessionId":null}');
  });
});
