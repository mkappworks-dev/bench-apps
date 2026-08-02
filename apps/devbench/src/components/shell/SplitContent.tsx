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

  // DB is the one tool that manages its own edge-to-edge layout and internal
  // scrolling (the schema divider and query console both need to reach the
  // pane's true bottom, and the grid needs to run flush to whatever's next
  // door) — so the pane hosting an active DB tab drops the shared p-6/scroll
  // that every other tool still depends on, rather than fighting it with
  // negative margins.
  function paneOwnsDbLayout(pane: Pane): boolean {
    return tabs.find((t) => t.pane === pane && t.id === activeTabId[pane])?.kind === "db";
  }

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
    // min-w-0: this row is itself App.tsx's three-column shell's main-axis
    // flex child, so it inherits the same shrink-refusal a DB tab's wide
    // table hits lower down — a definite width on `main` below doesn't help
    // if this ancestor still won't shrink below its content's preferred size.
    <div className="flex min-h-0 min-w-0 flex-1">
      <main
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${
          paneOwnsDbLayout("left") ? "overflow-hidden" : "overflow-y-auto p-6"
        }`}
      >
        {renderPane("left")}
      </main>
      {splitOpen ? (
        <main
          className={`flex min-h-0 min-w-0 flex-1 flex-col border-l border-border ${
            paneOwnsDbLayout("right") ? "overflow-hidden" : "overflow-y-auto p-6"
          }`}
        >
          {renderPane("right")}
        </main>
      ) : null}
    </div>
  );
}
