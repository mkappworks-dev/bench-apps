import { useEffect, useState } from "react";
import { useAppStore, type ThemePref } from "./store/useAppStore";
import { TopBar } from "./components/shell/TopBar";
import { TABS } from "./components/shell/tools";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { ChatDock } from "./components/shell/ChatDock";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { SplitContent } from "./components/shell/SplitContent";
import { invokeGetSettings, invokeListWatchedTables, invokeSetSetting, type DbConnectInput } from "./lib/tauri";

export { TABS };

const THEME_CYCLE: ThemePref[] = ["system", "dark", "light"];

// Same hardcoded dev connection duplicated in ApiTab.tsx and DbTab.tsx — the
// app only ever talks to one Postgres instance today, so a shared config
// module is out of scope until multi-connection support exists.
const DEV_CONNECTION: DbConnectInput = {
  host: "localhost",
  port: 5432,
  database: "devbench_test",
  username: "postgres",
  password: "postgres",
};

export default function App() {
  const chatOpen = useAppStore((s) => s.chatOpen);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const route = useAppStore((s) => s.route);
  const setRoute = useAppStore((s) => s.setRoute);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const [dbFocusTable, setDbFocusTable] = useState<string | null>(null);
  const [emailFocusId, setEmailFocusId] = useState<number | null>(null);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  // Restore the persisted theme at launch. DbTab and GeneralPane both read
  // settings on their own mount, but neither is guaranteed to mount before
  // the user starts interacting with the app — so App itself must hydrate
  // this too, or a saved theme stays invisible until the user happens to
  // open Settings. A failed read just leaves the "dark" default in place.
  useEffect(() => {
    invokeGetSettings()
      .then((settings) => setTheme(settings.theme as ThemePref))
      .catch(() => {});
  }, [setTheme]);

  // Watch state lives in SQLite, keyed by connection. DbTab.tsx hydrates this
  // too, but only once it mounts — and it only mounts once the user visits
  // the DB tab. Since the default tab is "api", a request fired from there
  // before ever visiting DB would correlate against an empty watch set even
  // though real watched tables are persisted, falsely reporting "no tables
  // are being watched". Hydrating here as well closes that gap.
  useEffect(() => {
    invokeListWatchedTables(DEV_CONNECTION)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [setWatchedTables]);

  // DESIGN.md's token precedence: base `:root` is dark, a
  // `prefers-color-scheme: light` media query overrides it, and an explicit
  // `data-theme` wins over both. "system" therefore means REMOVING the
  // attribute so the media query is back in charge — not setting it to
  // "system", which matches no selector.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  function cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
    setTheme(next);
    void invokeSetSetting("theme", next).catch(() => {});
  }

  if (route === "settings") {
    return (
      <div className="flex h-screen flex-col">
        <TopBar chatOpen={chatOpen} theme={theme} onToggleChat={() => setChatOpen(!chatOpen)} onCycleTheme={cycleTheme} />
        <SettingsScreen onBack={() => setRoute("workspace")} />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar chatOpen={chatOpen} theme={theme} onToggleChat={() => setChatOpen(!chatOpen)} onCycleTheme={cycleTheme} />
      {/* Three columns. The chat dock RESIZES this row rather than overlaying
          it — it is a grid track, not a fixed-position panel (DESIGN.md). */}
      <div className="flex min-h-0 flex-1">
        <SessionsSidebar onOpenSettings={() => setRoute("settings")} />
        <SplitContent
          dbFocusTable={dbFocusTable}
          emailFocusId={emailFocusId}
          onOpenTableInDb={setDbFocusTable}
          onOpenEmail={setEmailFocusId}
        />
        {chatOpen ? <ChatDock onClose={() => setChatOpen(false)} /> : null}
      </div>
    </div>
  );
}
