import { useCallback, useEffect, useState } from "react";
import {
  invokeClearProviderApiKey,
  invokeGetProviderStatus,
  invokeSetProviderApiKey,
  invokeSetSetting,
  type ProviderStatus,
} from "../../lib/tauri";
import { Menu, ChevronIcon } from "../ui/Menu";

const MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5 — most capable" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest" },
];

export function ProviderPane() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invokeGetProviderStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveKey() {
    setError(null);
    try {
      await invokeSetProviderApiKey(draftKey);
      // Drop the plaintext from React state the moment it is stored.
      setDraftKey("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeKey() {
    setError(null);
    try {
      await invokeClearProviderApiKey();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveModel(model: string) {
    setStatus((prev) => (prev ? { ...prev, model } : prev));
    await invokeSetSetting("model", model).catch(() => {});
  }

  return (
    <div className="max-w-160">
      <h2 className="text-lg font-bold text-text">Provider</h2>
      <p className="mt-1 text-sm text-text-muted">
        Bring your own key — DevBench calls your provider directly, never through a DevBench server.
      </p>

      <section className="mt-6 rounded-lg border border-border p-4">
        <label htmlFor="api-key" className="text-sm font-semibold text-text">
          API key
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder={status?.has_key ? "•••••••••••• (stored)" : "sk-ant-…"}
            className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-sm text-text"
          />
          <button
            onClick={() => void saveKey()}
            className="rounded-sm bg-accent px-3 py-2 text-sm font-bold text-accent-on"
          >
            Save key
          </button>
          {status?.has_key ? (
            <button
              onClick={() => void removeKey()}
              className="rounded-sm px-3 py-2 text-sm text-text-muted hover:bg-surface-2"
            >
              Remove key
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 text-[11px] text-text-faint">
          {status?.has_key
            ? "Key stored in your OS keychain. DevBench reads it only when you send a chat message."
            : "No key stored. The chat dock stays disabled until you add one."}
        </div>
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <div className="text-sm font-semibold text-text">Model</div>
        <Menu
          label="Model"
          options={MODELS.map((m) => ({ value: m.id, label: m.label }))}
          value={status?.model ?? "claude-opus-5"}
          onSelect={(next) => void saveModel(next)}
          trigger={
            <>
              {MODELS.find((m) => m.id === (status?.model ?? "claude-opus-5"))?.label ?? "Select a model"}
              <ChevronIcon />
            </>
          }
          triggerClassName="mt-2 flex h-9 w-full max-w-80 items-center justify-between gap-2 rounded-sm border border-border bg-surface-2 px-2.5 text-sm text-text transition-colors duration-150 hover:border-text-faint"
        />
      </section>
    </div>
  );
}
