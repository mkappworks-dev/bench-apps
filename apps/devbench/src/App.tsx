import { useEffect, useState } from "react";
import { useAppStore, type Pane, type ThemePref, type ToolKind } from "./store/useAppStore";
import { AppStrip } from "./components/shell/AppStrip";
import { BrandLockup } from "./components/shell/Logo";
import { TABS } from "./components/shell/tools";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { ChatDock } from "./components/shell/ChatDock";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { SplitContent } from "./components/shell/SplitContent";
import { StartupErrorScreen } from "./components/shell/StartupErrorScreen";
import {
  invokeGetSettings,
  invokeGetStartupStatus,
  invokeListWatchedTables,
  type DbConnectInput,
  type DbInitError,
} from "./lib/tauri";
import { useTabController } from "./store/useTabController";

export { TABS };

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
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabController = useTabController();
  // Ephemeral: never persisted to tab.state. Only the email deep link sets
  // it, and it targets one specific tab instance — see SplitContent.
  const [emailFocusRequest, setEmailFocusRequest] = useState<{ tabId: string; emailId: number | null } | null>(null);
  // History's mirror of emailFocusRequest above, for the reverse direction.
  const [historyFocusRequest, setHistoryFocusRequest] = useState<{ tabId: string; requestId: string } | null>(null);

  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  const [dbError, setDbError] = useState<DbInitError | null>(null);

  function onAddTab(pane: Pane, kind: ToolKind) {
    tabController.addTab(kind, pane);
  }
  function onToggleSplit(): boolean {
    return tabController.splitActiveTab();
  }

  // Fire-and-forget, checked once on mount: the normal (no `db_error`) case
  // never touches this state after the initial render, so a healthy startup
  // renders the workspace immediately with no wait and no flash.
  useEffect(() => {
    invokeGetStartupStatus()
      .then((status) => setDbError(status.db_error))
      .catch(() => {});
  }, []);

  // Restore the persisted theme at launch — otherwise it stays invisible
  // until the user happens to open Settings > Appearance. A failed read
  // just leaves the "dark" default in place.
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

  if (dbError) {
    return <StartupErrorScreen error={dbError} />;
  }

  if (route === "settings") {
    return (
      <div className="flex h-screen flex-col">
        <div data-tauri-drag-region className="flex h-11 shrink-0 items-center border-b border-border">
          <BrandLockup />
        </div>
        <SettingsScreen onBack={() => setRoute("workspace")} />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <AppStrip
        tabs={tabs}
        activeTabId={activeTabId}
        chatOpen={chatOpen}
        onSetActiveTab={tabController.setActiveTabId}
        onAddTab={onAddTab}
        onCloseTab={tabController.closeTab}
        onToggleSplit={onToggleSplit}
        onCloseSplitPane={tabController.closeSplit}
        onToggleChat={() => setChatOpen(!chatOpen)}
      />
      {/* Three columns. The chat dock RESIZES this row rather than overlaying
          it — it is a grid track, not a fixed-position panel (DESIGN.md). */}
      <div className="flex min-h-0 flex-1">
        <SessionsSidebar onOpenSettings={() => setRoute("settings")} />
        <SplitContent
          onAddTab={onAddTab}
          onPatchState={tabController.patchTabState}
          onOpenDb={(table) => tabController.focusOrCreateTab("db", { table })}
          onOpenLog={() => tabController.focusOrCreateTab("log")}
          onOpenEmail={(emailId) => {
            const targetId = tabController.focusOrCreateTab("email");
            setEmailFocusRequest({ tabId: targetId, emailId });
          }}
          emailFocusRequest={emailFocusRequest}
          onOpenHistory={(requestId) => {
            const targetId = tabController.focusOrCreateTab("api");
            setHistoryFocusRequest({ tabId: targetId, requestId });
          }}
          historyFocusRequest={historyFocusRequest}
        />
        {chatOpen ? <ChatDock onClose={() => setChatOpen(false)} /> : null}
      </div>
    </div>
  );
}
