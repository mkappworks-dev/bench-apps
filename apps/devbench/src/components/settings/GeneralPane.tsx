import { useEffect, useState } from "react";
import { useAppStore, type ThemePref } from "../../store/useAppStore";
import { invokeGetSettings, invokeSetSetting } from "../../lib/tauri";

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

const MIN_WINDOW_S = 1;
const MAX_WINDOW_S = 60;

export function GeneralPane() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const [windowSeconds, setWindowSeconds] = useState(5);
  const [smtpPort, setSmtpPort] = useState(1025);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);

  useEffect(() => {
    invokeGetSettings()
      .then((s) => {
        setWindowSeconds(Math.round(s.correlation_window_ms / 1000));
        setSmtpPort(s.smtp_port);
        setTheme(s.theme as ThemePref);
      })
      .catch(() => {
        /* defaults already in state */
      });
  }, [setTheme]);

  async function saveTheme(next: ThemePref) {
    setTheme(next);
    await invokeSetSetting("theme", next).catch(() => {});
  }

  async function saveWindow() {
    if (!Number.isFinite(windowSeconds) || windowSeconds < MIN_WINDOW_S || windowSeconds > MAX_WINDOW_S) {
      setWindowError(`Correlation window must be between ${MIN_WINDOW_S} and ${MAX_WINDOW_S} seconds.`);
      return;
    }
    setWindowError(null);
    await invokeSetSetting("correlation_window_ms", String(windowSeconds * 1000)).catch(() => {});
  }

  async function savePort() {
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      setPortError("SMTP port must be between 1 and 65535.");
      return;
    }
    setPortError(null);
    await invokeSetSetting("smtp_port", String(smtpPort)).catch(() => {});
  }

  return (
    <div className="max-w-160">
      <h2 className="text-lg font-bold text-text">General</h2>
      <p className="mt-1 text-sm text-text-muted">App-wide behavior.</p>

      <section className="mt-6 rounded-lg border border-border p-4">
        {/* A radiogroup: exactly one theme applies at a time. Base UI's
            ToggleGroup is a MULTI-select primitive and would be the wrong
            semantics here (see this plan's Decision 1). */}
        <div role="radiogroup" aria-label="Theme">
          <div className="text-sm font-semibold text-text">Theme</div>
          <div className="mt-2 inline-flex rounded-sm border border-border p-0.5">
            {THEMES.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={theme === t.id}
                onClick={() => void saveTheme(t.id)}
                className={`rounded-sm px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                  theme === t.id ? "bg-surface-2 text-text" : "text-text-muted hover:bg-surface-2"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <label htmlFor="corr-window" className="text-sm font-semibold text-text">
          Correlation window
        </label>
        <div className="mt-2 flex items-center gap-2">
          <input
            id="corr-window"
            type="number"
            min={MIN_WINDOW_S}
            max={MAX_WINDOW_S}
            value={windowSeconds}
            onChange={(e) => setWindowSeconds(Number(e.target.value))}
            onBlur={() => void saveWindow()}
            className="w-24 rounded-sm border border-border bg-bg px-2.5 py-2 text-sm tabular-nums text-text"
          />
          <span className="text-xs text-text-muted">seconds after the response</span>
        </div>
        <div className="mt-1 text-[11px] text-text-faint">
          How long DevBench keeps collecting log lines and emails for the “what happened” rollup after a
          request completes.
        </div>
        {windowError ? <div className="mt-1 text-xs text-danger">{windowError}</div> : null}
      </section>

      <section className="mt-4 rounded-lg border border-border p-4">
        <label htmlFor="smtp-port" className="text-sm font-semibold text-text">
          SMTP port
        </label>
        <div className="mt-2 flex items-center gap-2">
          <input
            id="smtp-port"
            type="number"
            min={1}
            max={65535}
            value={smtpPort}
            onChange={(e) => setSmtpPort(Number(e.target.value))}
            onBlur={() => void savePort()}
            className="w-24 rounded-sm border border-border bg-bg px-2.5 py-2 text-sm tabular-nums text-text"
          />
          <span className="text-xs text-text-muted">localhost only</span>
        </div>
        <div className="mt-1 text-[11px] text-text-faint">
          Point your backend’s SMTP config at this port to catch outgoing mail — the same setup as Mailhog
          or Mailpit. The catcher binds at launch, so a change here takes effect the next time DevBench
          starts.
        </div>
        {portError ? <div className="mt-1 text-xs text-danger">{portError}</div> : null}
      </section>
    </div>
  );
}
