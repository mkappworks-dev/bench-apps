import { Menu, ChevronIcon } from "../../ui/Menu";

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
  // Short secrets get no revealed prefix/suffix at all — 3-of-5 characters is
  // enough to shoulder-surf a real key back.
  return value.length <= 6 ? "••••" : `${value.slice(0, 3)}••••${value.slice(-2)}`;
}

export function authPreview(auth: AuthState): string {
  switch (auth.type) {
    case "none":
      return "No Authorization added — request goes out with only the headers above.";
    case "bearer":
      return `Adds header  Authorization: Bearer ${maskSecret(auth.token)}`;
    case "basic":
      return `Adds header  Authorization: Basic ••••`;
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

const AUTH_OPTIONS = [
  { value: "none", label: "No Auth" }, { value: "bearer", label: "Bearer Token" },
  { value: "basic", label: "Basic Auth" }, { value: "apikey", label: "API Key" },
];
const PICKER_CLASS = "api-picker flex h-8.5 w-40 max-w-full items-center justify-between gap-2 rounded-sm border border-border bg-surface px-2.5 text-sm font-semibold text-text hover:border-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

type AuthField = { key: "token" | "username" | "password" | "keyName" | "keyValue"; label: string; placeholder?: string; type?: string };

export function AuthEditor({ auth, onChange }: { auth: AuthState; onChange: (auth: AuthState) => void }) {
  const fields: AuthField[] = auth.type === "bearer" ? [{ key: "token", label: "Token", placeholder: "Bearer token" }]
    : auth.type === "basic" ? [{ key: "username", label: "Username" }, { key: "password", label: "Password", type: "password" }]
    : auth.type === "apikey" ? [{ key: "keyName", label: "Key name" }, { key: "keyValue", label: "Key value" }] : [];
  return (
    <div className="min-w-0">
      <div className="api-auth-row mb-3 flex items-center gap-2">
        <span className="w-23 shrink-0 text-sm text-text-muted">Type</span>
        <Menu closeOnSelect label="Auth type" options={AUTH_OPTIONS} value={auth.type}
          onSelect={(value) => onChange({ ...auth, type: value as AuthType })}
          trigger={<>{AUTH_OPTIONS.find((option) => option.value === auth.type)?.label}<ChevronIcon /></>}
          triggerClassName={PICKER_CLASS} />
      </div>
      {fields.map((field) => (
        <label key={field.key} className="api-auth-row mb-3 flex min-w-0 items-center gap-2">
          <span className="w-23 shrink-0 text-sm text-text-muted">{field.label}</span>
          <input className="h-8.5 min-w-0 flex-1 rounded-sm border border-border bg-surface px-2.5 font-mono text-sm text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            type={field.type ?? "text"} autoComplete="off" value={auth[field.key]} placeholder={field.placeholder}
            onChange={(event) => onChange({ ...auth, [field.key]: event.target.value })} />
        </label>
      ))}
      {auth.type === "apikey" ? (
        <div className="api-auth-row mb-3 flex items-center gap-2">
          <span className="w-23 shrink-0 text-sm text-text-muted">Add to</span>
          <Menu closeOnSelect label="Add to" options={[{ value: "header", label: "Header" }, { value: "query", label: "Query param" }]}
            value={auth.keyIn} onSelect={(value) => onChange({ ...auth, keyIn: value as AuthKeyIn })}
            trigger={<>{auth.keyIn === "header" ? "Header" : "Query param"}<ChevronIcon /></>}
            triggerClassName={PICKER_CLASS} />
        </div>
      ) : null}
      <div className="api-auth-preview rounded-sm border border-dashed border-border bg-surface p-2.5 font-mono text-xs text-text-muted [overflow-wrap:anywhere]">
        {authPreview(auth)}
      </div>
    </div>
  );
}
