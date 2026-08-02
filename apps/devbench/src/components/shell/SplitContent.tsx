import { ToolPane } from "./ToolPane";
import { EmptyPane } from "./EmptyPane";
import { useAppStore, type Pane, type ToolKind } from "../../store/useAppStore";

/**
 * Panes only, no chrome — the tab bars and Split control live in AppStrip.
 * Every tab in the active pane stays mounted (class-swap, not unmount) so
 * fetched rows, buffered log lines, and in-flight requests survive a tab
 * switch untouched.
 */
export function SplitContent({
  onAddTab,
  onPatchState,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
  emailFocusRequest,
  onOpenHistory,
  historyFocusRequest,
}: {
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onPatchState: (id: string, patch: Record<string, unknown>) => void;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
  emailFocusRequest: { tabId: string; emailId: number | null } | null;
  onOpenHistory: (requestId: string) => void;
  historyFocusRequest: { tabId: string; requestId: string } | null;
}) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const splitOpen = tabs.some((t) => t.pane === "right");

  function renderPane(pane: Pane) {
    const paneTabs = tabs.filter((t) => t.pane === pane).sort((a, b) => a.ordinal - b.ordinal);
    if (paneTabs.length === 0) {
      return <EmptyPane onAddTab={(kind) => onAddTab(pane, kind)} />;
    }
    return paneTabs.map((tab) => (
      // Note the class swap, not the `hidden` attribute — a sibling display
      // utility would silently beat `[hidden]`'s specificity. `key={tab.id}`
      // is what gives two DB tabs separate React instances, and therefore
      // separate useState, per tab.
      <div key={tab.id} className={tab.id === activeTabId[pane] ? "flex min-h-0 flex-1" : "hidden"}>
        <ToolPane
          tab={tab}
          onPatchState={(patch) => onPatchState(tab.id, patch)}
          onOpenDb={onOpenDb}
          onOpenLog={onOpenLog}
          onOpenEmail={onOpenEmail}
          emailFocusId={emailFocusRequest?.tabId === tab.id ? emailFocusRequest.emailId : null}
          onOpenHistory={onOpenHistory}
          historyFocusId={historyFocusRequest?.tabId === tab.id ? historyFocusRequest.requestId : null}
        />
      </div>
    ));
  }

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6">{renderPane("left")}</main>
      {splitOpen ? (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-l border-border p-6">
          {renderPane("right")}
        </main>
      ) : null}
    </div>
  );
}
