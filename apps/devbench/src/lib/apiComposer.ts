export type AuthType = "none" | "bearer" | "basic" | "apikey";
export type AuthKeyIn = "header" | "query";
export type BodyType = "none" | "json" | "text";
export type ReqTab = "params" | "headers" | "body" | "auth";
export interface AuthState {
  type: AuthType;
  token: string;
  username: string;
  password: string;
  keyName: string;
  keyValue: string;
  keyIn: AuthKeyIn;
}
export const DEFAULT_AUTH: AuthState = {
  type: "none", token: "", username: "", password: "", keyName: "X-Api-Key", keyValue: "", keyIn: "header",
};
export interface SavedHeaderRow { key: string; value: string; enabled: boolean }
export interface SavedRequestInput {
  name: string;
  session_id: string | null;
  method: string;
  url: string;
  headers: SavedHeaderRow[];
  body: string | null;
  body_type: BodyType;
  auth: AuthState;
}
export interface SavedRequest extends SavedRequestInput { id: string; created_at: string; updated_at: string }
export interface ComposerDraft {
  method: string;
  url: string;
  headers: SavedHeaderRow[];
  body: string;
  bodyType: BodyType;
  auth: AuthState;
  activeReqTab: ReqTab;
  loadedSavedId: string | null;
  loadedSavedName: string | null;
  loadedSavedSessionId: string | null;
  dirty: boolean;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const nullableString = (value: unknown) => typeof value === "string" ? value : null;
export function readComposerDraft(state: Record<string, unknown>): ComposerDraft {
  const rawAuth = object(state.auth);
  const auth = { ...DEFAULT_AUTH };
  for (const key of ["token", "username", "password", "keyName", "keyValue"] as const) auth[key] = string(rawAuth[key], auth[key]);
  if (["none", "bearer", "basic", "apikey"].includes(string(rawAuth.type))) auth.type = rawAuth.type as AuthType;
  auth.keyIn = rawAuth.keyIn === "query" ? "query" : "header";
  return {
    method: string(state.method, "GET"), url: string(state.url),
    headers: (Array.isArray(state.headers) ? state.headers : []).filter((row): row is Record<string, unknown> => {
      const r = object(row); return typeof r.key === "string" && typeof r.value === "string";
    }).map((row) => ({ key: row.key as string, value: row.value as string, enabled: row.enabled !== false })),
    body: string(state.body), bodyType: state.bodyType === "json" || state.bodyType === "text" ? state.bodyType : "none", auth,
    activeReqTab: ["params", "headers", "body", "auth"].includes(string(state.activeReqTab)) ? state.activeReqTab as ReqTab : "headers",
    loadedSavedId: nullableString(state.loadedSavedId), loadedSavedName: nullableString(state.loadedSavedName),
    loadedSavedSessionId: nullableString(state.loadedSavedSessionId), dirty: state.dirty === true,
  };
}

export function toSavedRequestInput(draft: ComposerDraft, name: string, sessionId: string | null): SavedRequestInput {
  return { name, session_id: sessionId, method: draft.method, url: draft.url, headers: draft.headers,
    body: draft.body, body_type: draft.bodyType, auth: draft.auth };
}
export function fromSavedRequest(request: SavedRequest, activeReqTab: ReqTab = "headers"): ComposerDraft {
  return readComposerDraft({ ...request, bodyType: request.body_type, activeReqTab,
    loadedSavedId: request.id, loadedSavedName: request.name, loadedSavedSessionId: request.session_id, dirty: false });
}
export function composerContents(draft: ComposerDraft): string {
  return JSON.stringify({ method: draft.method, url: draft.url, headers: draft.headers, body: draft.body, bodyType: draft.bodyType, auth: draft.auth });
}
