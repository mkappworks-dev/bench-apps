import { useState } from "react";
import {
  invokeCreateConnection,
  invokeUpdateConnection,
  invokeSetConnectionPassword,
  invokeClearConnectionPassword,
  invokeTestConnection,
  type ConnectionInput,
  type ConnectionSummary,
} from "../../lib/tauri";
import { Menu, ChevronIcon } from "../ui/Menu";

const inputClass = "rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text";
const labelClass = "flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-text-faint";
const menuTriggerClass =
  "flex h-9 items-center justify-between gap-2 rounded-sm border border-border bg-bg px-2.5 text-sm normal-case tracking-normal text-text transition-colors duration-150 hover:border-text-faint";

const ENGINES = [{ value: "postgres", label: "postgres" }];
const SSL_MODES = [
  { value: "disable", label: "disable" },
  { value: "require", label: "require" },
  { value: "verify-full", label: "verify-full" },
];

export function ConnectionModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: ConnectionSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ConnectionInput>({
    name: existing?.name ?? "",
    engine: existing?.engine ?? "postgres",
    host: existing?.host ?? "",
    port: existing?.port ?? 5432,
    database: existing?.database ?? "",
    username: existing?.username ?? "",
    sslmode: existing?.sslmode ?? "disable",
    password: "",
  });
  const [testResult, setTestResult] = useState<"idle" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  function field<K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function test() {
    setTestResult("idle");
    try {
      await invokeTestConnection(form);
      setTestResult("ok");
    } catch {
      setTestResult("error");
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        await invokeUpdateConnection(existing.id, { ...form, password: undefined });
        // A blank password field on an edit means "leave it alone" — only a
        // password the user actually typed gets written.
        if (form.password) {
          await invokeSetConnectionPassword(existing.id, form.password);
        }
      } else {
        await invokeCreateConnection(form);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // A direct action, not routed through the Save flow — mirrors ProviderPane's
  // "Remove key": clearing a secret shouldn't wait on unrelated field edits.
  async function clearPassword() {
    if (!existing) return;
    setClearing(true);
    setError(null);
    try {
      await invokeClearConnectionPassword(existing.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={existing ? `Edit connection — ${existing.name}` : "Add a connection"}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Glass, per DESIGN.md: a transient overlay, matching NewSessionDialog's
          treatment (the other glass surface outside Menu's popup). */}
      <div
        className="w-140 max-w-[calc(100vw-40px)] max-h-[calc(100vh-80px)] overflow-y-auto rounded-lg border border-border shadow-2xl backdrop-blur-xl backdrop-saturate-150"
        style={{
          background: "color-mix(in srgb, var(--surface) 72%, transparent)",
          boxShadow: "inset 0 1px 0 0 rgb(255 255 255 / 0.06)",
        }}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-sm font-bold text-text">
            {existing ? `Edit connection — ${existing.name}` : "Add a connection"}
          </h3>
          <button onClick={onClose} aria-label="Close" className="text-text-faint hover:text-text">
            ✕
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 p-4">
          <label className={labelClass} htmlFor="conn-name">
            Name
            <input
              id="conn-name"
              value={form.name}
              onChange={(e) => field("name", e.target.value)}
              className={inputClass}
            />
          </label>
          <div className={labelClass}>
            Engine
            <Menu
              label="Engine"
              options={ENGINES}
              value={form.engine}
              onSelect={(next) => field("engine", next)}
              trigger={
                <>
                  {ENGINES.find((e) => e.value === form.engine)?.label ?? form.engine}
                  <ChevronIcon />
                </>
              }
              triggerClassName={menuTriggerClass}
            />
          </div>
          <label className={labelClass} htmlFor="conn-host">
            Host
            <input
              id="conn-host"
              value={form.host}
              onChange={(e) => field("host", e.target.value)}
              className={inputClass}
            />
          </label>
          <label className={labelClass} htmlFor="conn-port">
            Port
            <input
              id="conn-port"
              type="number"
              value={form.port}
              onChange={(e) => field("port", Number(e.target.value))}
              className={inputClass}
            />
          </label>
          <label className={labelClass} htmlFor="conn-database">
            Database
            <input
              id="conn-database"
              value={form.database}
              onChange={(e) => field("database", e.target.value)}
              className={inputClass}
            />
          </label>
          <label className={labelClass} htmlFor="conn-username">
            Username
            <input
              id="conn-username"
              value={form.username}
              onChange={(e) => field("username", e.target.value)}
              className={inputClass}
            />
          </label>
          <label className={labelClass} htmlFor="conn-password">
            Password
            <input
              id="conn-password"
              type="password"
              autoComplete="off"
              value={form.password ?? ""}
              onChange={(e) => field("password", e.target.value)}
              placeholder={existing?.has_password ? "•••••••• (stored)" : "Enter a password"}
              className={inputClass}
            />
            {existing?.has_password ? (
              <button
                type="button"
                onClick={() => void clearPassword()}
                disabled={clearing}
                className="self-start text-[11px] normal-case tracking-normal text-text-faint hover:text-danger disabled:opacity-50"
              >
                Clear stored password
              </button>
            ) : null}
          </label>
          <div className={labelClass}>
            SSL mode
            <Menu
              label="SSL mode"
              options={SSL_MODES}
              value={form.sslmode}
              onSelect={(next) => field("sslmode", next)}
              trigger={
                <>
                  {SSL_MODES.find((m) => m.value === form.sslmode)?.label ?? form.sslmode}
                  <ChevronIcon />
                </>
              }
              triggerClassName={menuTriggerClass}
            />
          </div>
        </div>
        <div className="px-4 text-xs text-text-faint">
          Password is written to your OS keychain only when Save succeeds; a failed test never touches storage.
        </div>
        {testResult !== "idle" ? (
          <div className={`mx-4 mt-2 text-xs ${testResult === "ok" ? "text-success" : "text-danger"}`}>
            {testResult === "ok" ? "Connected successfully." : "Could not connect."}
          </div>
        ) : null}
        {error ? <div className="mx-4 mt-2 text-xs text-danger">{error}</div> : null}
        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          <button onClick={() => void test()} className="rounded-sm border border-border px-3 py-2 text-sm text-text-muted">
            Test connection
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-sm px-3 py-2 text-sm text-text-muted hover:bg-surface-2">
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="rounded-sm bg-accent px-3 py-2 text-sm font-bold text-accent-on disabled:opacity-50"
            >
              Save connection
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
