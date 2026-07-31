import { useEffect, useState } from "react";
import { useAppStore, type ThemePref } from "./store/useAppStore";
import { TopBar } from "./components/shell/TopBar";
import { ToolTabs, TABS } from "./components/shell/ToolTabs";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { ChatDock } from "./components/shell/ChatDock";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { ApiTab } from "./components/api/ApiTab";
import { DbTab } from "./components/db/DbTab";
import { LogTab } from "./components/log/LogTab";
import { EmailTab } from "./components/email/EmailTab";

export { TABS };

const THEME_CYCLE: ThemePref[] = ["system", "dark", "light"];

export default function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);
  const chatOpen = useAppStore((s) => s.chatOpen);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const route = useAppStore((s) => s.route);
  const setRoute = useAppStore((s) => s.setRoute);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const [dbFocusTable, setDbFocusTable] = useState<string | null>(null);
  const [emailFocusId, setEmailFocusId] = useState<number | null>(null);

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
        <div className="flex min-w-0 flex-1 flex-col">
          <ToolTabs value={activeTab} onValueChange={setActiveTab} />
          <main className="min-h-0 flex-1 overflow-y-auto p-6">
            {activeTab === "api" ? (
              <ApiTab onOpenTableInDb={setDbFocusTable} onOpenEmail={setEmailFocusId} />
            ) : null}
            {activeTab === "db" ? (
              <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
            ) : null}
            {activeTab === "log" ? <LogTab /> : null}
            {activeTab === "email" ? <EmailTab focusEmailId={emailFocusId} /> : null}
          </main>
        </div>
        {chatOpen ? <ChatDock onClose={() => setChatOpen(false)} /> : null}
      </div>
    </div>
  );
}
