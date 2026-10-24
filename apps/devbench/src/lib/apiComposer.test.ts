import { describe, expect, it } from "vitest";
import { readComposerDraft, fromSavedRequest, toSavedRequestInput, composerContents, type SavedRequest } from "./apiComposer";

const saved: SavedRequest = {
  id: "saved-1", name: "Orders", session_id: "session-a", method: "POST", url: "/orders?a=1&a=2",
  headers: [{ key: "X-Debug", value: "yes", enabled: false }], body: '{"a":1}', body_type: "json",
  auth: { type: "bearer", token: "test-token", username: "", password: "", keyName: "X-Api-Key", keyValue: "", keyIn: "header" },
  created_at: "2026-01-01", updated_at: "2026-01-02",
};

describe("composer snapshots", () => {
  it("default-fills old tab state and malformed optional fields", () => {
    const draft = readComposerDraft({ method: "PATCH", url: "/orders?x=1", headers: [null, { key: "A", value: "1" }], auth: { type: "unknown" }, bodyType: "binary" });
    expect(draft).toMatchObject({ method: "PATCH", url: "/orders?x=1", body: "", bodyType: "none", activeReqTab: "headers", loadedSavedId: null, dirty: false });
    expect(draft.headers).toEqual([{ key: "A", value: "1", enabled: true }]);
    expect(draft.auth).toMatchObject({ type: "none", token: "", keyIn: "header" });
    expect(draft).not.toHaveProperty("params");
  });
  it("loads and saves a full definition without compiling disabled headers or auth", () => {
    const draft = fromSavedRequest(saved, "auth");
    expect(draft).toMatchObject({ loadedSavedId: "saved-1", loadedSavedName: "Orders", loadedSavedSessionId: "session-a", dirty: false, activeReqTab: "auth" });
    expect(toSavedRequestInput(draft, "Orders", saved.session_id)).toEqual({
      name: "Orders", session_id: "session-a", method: "POST", url: "/orders?a=1&a=2",
      headers: saved.headers, body: saved.body, body_type: "json", auth: saved.auth,
    });
  });
  it("rehydrates dirty drafts and compares semantic request content independently of UI metadata", () => {
    const draft = { ...fromSavedRequest(saved), dirty: true, bodyType: "none" as const };
    const restored = readComposerDraft(JSON.parse(JSON.stringify(draft)));
    expect(restored).toEqual(draft);
    expect(restored.body).toBe('{"a":1}');
    expect(composerContents({ ...draft, activeReqTab: "auth", dirty: false })).toEqual(composerContents(draft));
    expect(composerContents({ ...draft, url: "/changed" })).not.toEqual(composerContents(draft));
  });
});
