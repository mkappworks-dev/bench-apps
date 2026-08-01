export type AuthType = "none" | "bearer" | "basic" | "apikey";
export type AuthKeyIn = "header" | "query";

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
  type: "none",
  token: "",
  username: "",
  password: "",
  keyName: "X-Api-Key",
  keyValue: "",
  keyIn: "header",
};

function maskSecret(value: string): string {
  if (!value) return "(empty)";
  return value.length <= 6 ? value : `${value.slice(0, 3)}••••${value.slice(-2)}`;
}

export function authPreview(auth: AuthState): string {
  switch (auth.type) {
    case "none":
      return "No Authorization added — request goes out with only the headers above.";
    case "bearer":
      return `Adds header  Authorization: Bearer ${maskSecret(auth.token)}`;
    case "basic":
      return `Adds header  Authorization: Basic ${btoa(unescape(encodeURIComponent(`${auth.username}:${auth.password}`))).slice(0, 16)}…`;
    case "apikey":
      return `Adds ${auth.keyIn === "query" ? "query param" : "header"}  ${auth.keyName || "X-Api-Key"}: ${maskSecret(auth.keyValue)}`;
  }
}

export function resolveAuthHeader(auth: AuthState): { key: string; value: string } | null {
  switch (auth.type) {
    case "none":
      return null;
    case "bearer":
      return auth.token ? { key: "Authorization", value: `Bearer ${auth.token}` } : null;
    case "basic":
      return { key: "Authorization", value: `Basic ${btoa(unescape(encodeURIComponent(`${auth.username}:${auth.password}`)))}` };
    case "apikey":
      return auth.keyIn === "header" && auth.keyValue ? { key: auth.keyName || "X-Api-Key", value: auth.keyValue } : null;
  }
}

export function resolveAuthQueryParam(auth: AuthState): { key: string; value: string } | null {
  if (auth.type === "apikey" && auth.keyIn === "query" && auth.keyValue) {
    return { key: auth.keyName || "X-Api-Key", value: auth.keyValue };
  }
  return null;
}

export function AuthEditor({ auth, onChange }: { auth: AuthState; onChange: (auth: AuthState) => void }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="w-23 text-sm text-text-faint">Type</span>
        <select
          value={auth.type}
          onChange={(e) => onChange({ ...auth, type: e.target.value as AuthType })}
          aria-label="Auth type"
          className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-bold text-text"
        >
          <option value="none">No Auth</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
          <option value="apikey">API Key</option>
        </select>
      </div>
      {auth.type === "bearer" ? (
        <div className="mb-3 flex items-center gap-2">
          <span className="w-23 text-sm text-text-faint">Token</span>
          <input
            className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
            value={auth.token}
            onChange={(e) => onChange({ ...auth, token: e.target.value })}
            placeholder="Bearer token"
          />
        </div>
      ) : null}
      {auth.type === "basic" ? (
        <>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Username</span>
            <input
              className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
              value={auth.username}
              onChange={(e) => onChange({ ...auth, username: e.target.value })}
            />
          </div>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Password</span>
            <input
              type="password"
              className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
              value={auth.password}
              onChange={(e) => onChange({ ...auth, password: e.target.value })}
            />
          </div>
        </>
      ) : null}
      {auth.type === "apikey" ? (
        <>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Key name</span>
            <input
              className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
              value={auth.keyName}
              onChange={(e) => onChange({ ...auth, keyName: e.target.value })}
            />
          </div>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Key value</span>
            <input
              className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
              value={auth.keyValue}
              onChange={(e) => onChange({ ...auth, keyValue: e.target.value })}
            />
          </div>
          <div className="mb-3 flex items-center gap-2">
            <span className="w-23 text-sm text-text-faint">Add to</span>
            <select
              value={auth.keyIn}
              onChange={(e) => onChange({ ...auth, keyIn: e.target.value as AuthKeyIn })}
              aria-label="Add to"
              className="rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-bold text-text"
            >
              <option value="header">Header</option>
              <option value="query">Query param</option>
            </select>
          </div>
        </>
      ) : null}
      <div className="rounded-md border border-dashed border-border bg-surface p-2.5 font-mono text-xs text-text-faint">
        {authPreview(auth)}
      </div>
    </div>
  );
}
