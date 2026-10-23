import { useEffect, useState } from "react";
import { useAppStore, type Pane, type ThemePref, type ToolKind } from "./store/useAppStore";
import { AppStrip } from "./components/shell/AppStrip";
import { BrandLockup } from "./components/shell/Logo";
import { TABS } from "./components/shell/tools";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { ChatDock } from "./components/shell/ChatDock";
import { InsertPanel } from "./components/db/InsertPanel";
import { PendingPanel } from "./components/db/PendingPanel";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { SplitContent } from "./components/shell/SplitContent";
import { StartupErrorScreen } from "./components/shell/StartupErrorScreen";
import {
  invokeGetSettings,
  invokeGetStartupStatus,
  invokeListConnections,
  invokeListWatchedTables,
  type DbInitError,
} from "./lib/tauri";
import { useTabController } from "./store/useTabController";

export { TABS };

export default function App() {
  const chatOpen = useAppStore((s) => s.chatOpen);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const dockPanel = useAppStore((s) => s.dockPanel);
  const setDockPanel = useAppStore((s) => s.setDockPanel);
  const insertTarget = useAppStore((s) => s.insertTarget);
  const applyInFlight = useAppStore((s) => s.applyInFlight);
  const route = useAppStore((s) => s.route);
  const setRoute = useAppStore((s) => s.setRoute);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const queryRollbackFailures = useAppStore((s) => s.queryRollbackFailures);
  const savedQueries = useAppStore((s) => s.savedQueries);
  const hiddenQueryFailures = Object.values(queryRollbackFailures).filter((failure) => route === "settings" || !tabs.some((tab) =>
    tab.kind === "query" && (tab.id === activeTabId.left || tab.id === activeTabId.right) &&
    tab.state.queryId === failure.queryId && tab.state.connectionId === failure.connectionId));
  const rollbackWarnings = hiddenQueryFailures.map((failure) => (
    <div key={JSON.stringify([failure.connectionId, failure.queryId])} role="alert" className="shrink-0 border-b border-border bg-danger-bg px-3 py-2 text-xs text-danger">
      Query “{savedQueries.find((query) => query.id === failure.queryId)?.name ?? "Saved query"}” could not be rolled back.
      Check its database before continuing. ({failure.message})
    </div>
  ));
  const tabController = useTabController();
  // Ephemeral: never persisted to tab.state. Only the email deep link sets
  // it, and it targets one specific tab instance — see SplitContent.
  const [emailFocusRequest, setEmailFocusRequest] = useState<{ tabId: string; emailId: number | null } | null>(null);
  // History's mirror of emailFocusRequest above, for the reverse direction.
  const [historyFocusRequest, setHistoryFocusRequest] = useState<{ tabId: string; requestId: string } | null>(null);

  const setWatchedTables = useAppStore((s) => s.setWatchedTables);
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);

  const [dbError, setDbError] = useState<DbInitError | null>(null);

  function onAddTab(pane: Pane, kind: ToolKind) {
    tabController.addTab(kind, pane);
  }
  function onToggleSplit(): boolean {
    return tabController.splitActiveTab();
  }
  function onOpenQuery(queryId: string) {
    const connectionId = useAppStore.getState().activeConnectionId;
    if (!connectionId) return;
    // Matched on queryId: one saved query is one document, so selecting the
    // same query again focuses its tab instead of stacking a duplicate (§3b).
    // The connection is captured here and never patched afterwards — moving
    // the rail's picker must not silently repoint an open query at another
    // database.
    tabController.focusOrCreateTab("query", { queryId, connectionId }, (t) => t.state.queryId === queryId);
  }

  // Deleting a saved query has to take its document with it: the record is
  // gone, so the tab's name field and editor fall back to "" and can no
  // longer accept a keystroke — and the tab row would otherwise survive in
  // SQLite and come back after a restart.
  function onCloseQueryTabs(queryId: string) {
    useAppStore
      .getState()
      .tabs.filter((t) => t.kind === "query" && t.state.queryId === queryId)
      .forEach((t) => tabController.closeTab(t.id));
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

  // Picks the connection this session works against. The natural
  // single-connection case (today, just the seeded 'default' row) resolves
  // to whichever connection list_connections returns first.
  useEffect(() => {
    invokeListConnections()
      .then((connections) => {
        if (connections.length > 0) setActiveConnectionId(connections[0].id);
      })
      .catch(() => {});
  }, [setActiveConnectionId]);

  // Watch state lives in SQLite, keyed by connection. DbTab.tsx hydrates this
  // too, but only once it mounts — and it only mounts once the user visits
  // the DB tab. Since the default tab is "api", a request fired from there
  // before ever visiting DB would correlate against an empty watch set even
  // though real watched tables are persisted, falsely reporting "no tables
  // are being watched". Hydrating here as well closes that gap. Re-running
  // whenever activeConnectionId changes also keeps it in sync with switches
  // made later from the DB tab's picker.
  useEffect(() => {
    if (!activeConnectionId) return;
    invokeListWatchedTables(activeConnectionId)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [activeConnectionId, setWatchedTables]);

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
        {rollbackWarnings}
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
        // The store refuses the close anyway (see setChatOpen); this is what
        // stops the button from looking broken while it does.
        chatToggleDisabled={applyInFlight && chatOpen}
      />
      {rollbackWarnings}
      {/* Three columns. The chat dock RESIZES this row rather than overlaying
          it — it is a grid track, not a fixed-position panel (DESIGN.md). */}
      <div className="flex min-h-0 flex-1">
        <SessionsSidebar onOpenSettings={() => setRoute("settings")} />
        <SplitContent
          onAddTab={onAddTab}
          onPatchState={tabController.patchTabState}
          onOpenDb={(table) => tabController.focusOrCreateTab("db", { table })}
          onOpenQuery={onOpenQuery}
          onCloseQueryTabs={onCloseQueryTabs}
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
        {/* One slot, three occupants (spec §1). Closing a panel returns to
            chat; only closing chat itself closes the dock. An insert panel
            with no target can't render a form, so it falls back rather than
            showing an empty one. */}
        {chatOpen ? (
          dockPanel === "insert" && insertTarget ? (
            <InsertPanel target={insertTarget} onClose={() => setDockPanel("chat")} />
          ) : dockPanel === "pending" ? (
            <PendingPanel
              connectionId={activeConnectionId}
              onClose={() => setDockPanel("chat")}
            />
          ) : (
            <ChatDock onClose={() => setChatOpen(false)} />
          )
        ) : null}
      </div>
    </div>
  );
}
