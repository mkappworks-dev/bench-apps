import { useEffect, useState } from "react";
import { useAppStore, type ThemePref } from "./store/useAppStore";
import { TopBar } from "./components/shell/TopBar";
import { TABS } from "./components/shell/ToolTabs";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { ChatDock } from "./components/shell/ChatDock";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { SplitContent } from "./components/shell/SplitContent";

export { TABS };

const THEME_CYCLE: ThemePref[] = ["system", "dark", "light"];

export default function App() {
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
