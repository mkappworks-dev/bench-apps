import { ToolPane } from "./ToolPane";
import { EmptyPane } from "./EmptyPane";
import { useAppStore, type Pane, type ToolKind } from "../../store/useAppStore";
import type { QualifiedTable } from "../../lib/tauri";

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
  onOpenQuery,
  onCloseQueryTabs,
  onOpenLog,
  onOpenEmail,
  emailFocusRequest,
  onOpenHistory,
  historyFocusRequest,
}: {
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onPatchState: (id: string, patch: Record<string, unknown>) => void;
  onOpenDb: (table: QualifiedTable) => void;
  onOpenQuery: (queryId: string) => void;
  onCloseQueryTabs: (queryId: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
  emailFocusRequest: { tabId: string; emailId: number | null } | null;
  onOpenHistory: (requestId: string) => void;
  historyFocusRequest: { tabId: string; requestId: string } | null;
}) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const splitOpen = tabs.some((t) => t.pane === "right");

  function paneOwnsItsLayout(pane: Pane): boolean {
    const kind = tabs.find((t) => t.pane === pane && t.id === activeTabId[pane])?.kind;
    return kind === "db" || kind === "query" || kind === "api";
  }

  function renderPane(pane: Pane) {
    const paneTabs = tabs.filter((t) => t.pane === pane).sort((a, b) => a.ordinal - b.ordinal);
    if (paneTabs.length === 0) {
      return <EmptyPane onAddTab={(kind) => onAddTab(pane, kind)} />;
    }
    return paneTabs.map((tab) => (
      // Class swap, not the `hidden` attribute: a sibling display utility silently beats
      // `[hidden]`'s specificity. `key={tab.id}` gives two DB tabs separate instances.
      <div key={tab.id} className={tab.id === activeTabId[pane] ? "flex min-h-0 flex-1" : "hidden"}>
        <ToolPane
          tab={tab}
          onPatchState={(patch) => onPatchState(tab.id, patch)}
          onOpenDb={onOpenDb}
          onOpenQuery={onOpenQuery}
          onCloseQueryTabs={onCloseQueryTabs}
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
    // min-w-0: this row is a flex child of App.tsx's shell, so it inherits the same
    // shrink-refusal a wide table hits lower down.
    <div className="flex min-h-0 min-w-0 flex-1">
      <main
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${
          paneOwnsItsLayout("left") ? "overflow-hidden" : "overflow-y-auto p-6"
        }`}
      >
        {renderPane("left")}
      </main>
      {splitOpen ? (
        <main
          className={`flex min-h-0 min-w-0 flex-1 flex-col border-l border-border ${
            paneOwnsItsLayout("right") ? "overflow-hidden" : "overflow-y-auto p-6"
          }`}
        >
          {renderPane("right")}
        </main>
      ) : null}
    </div>
  );
}
