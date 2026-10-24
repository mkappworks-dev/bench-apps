import type { Tab } from "../../store/useAppStore";
import type { QualifiedTable } from "../../lib/tauri";
import { normalizeTable } from "../../lib/tableIdentity";
import { ApiTab } from "../api/ApiTab";
import { DbTab } from "../db/DbTab";
import { QueryTab } from "../db/QueryTab";
import { LogTab } from "../log/LogTab";
import { EmailTab } from "../email/EmailTab";
import { useAppStore } from "../../store/useAppStore";

/**
 * Renders one tab instance — every pane's every tab goes through this, which is
 * what keeps "any tool, any number of times, in either pane" true by construction.
 */
export function ToolPane({
  tab,
  onPatchState,
  onOpenDb,
  onOpenQuery,
  onCloseQueryTabs,
  onOpenLog,
  onOpenEmail,
  emailFocusId,
  onOpenHistory,
  historyFocusId,
}: {
  tab: Tab;
  onPatchState: (patch: Record<string, unknown>) => void;
  onOpenDb: (table: QualifiedTable) => void;
  onOpenQuery: (queryId: string) => void;
  onCloseQueryTabs: (queryId: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
  emailFocusId: number | null;
  onOpenHistory: (requestId: string) => void;
  historyFocusId: string | null;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);

  switch (tab.kind) {
    case "api":
      return (
        <ApiTab
          tab={tab}
          onPatchState={onPatchState}
          onOpenDb={onOpenDb}
          onOpenLog={onOpenLog}
          onOpenEmail={onOpenEmail}
          focusHistoryId={historyFocusId}
        />
      );
    case "db":
      return (
        <DbTab
          watchedTables={watchedTables}
          onToggleWatch={toggleWatchedTable}
          table={normalizeTable(tab.state.table)}
          onPatchState={onPatchState}
          onOpenQuery={onOpenQuery}
          onCloseQueryTabs={onCloseQueryTabs}
        />
      );
    case "log":
      return (
        <LogTab
          sourceId={typeof tab.state.sourceId === "string" ? tab.state.sourceId : null}
          mode={tab.state.mode === "search" ? "search" : "live"}
          onPatchState={onPatchState}
        />
      );
    case "email":
      return <EmailTab focusEmailId={emailFocusId} onOpenHistory={onOpenHistory} />;
    case "query":
      return (
        <QueryTab
          tab={tab}
          onOpenQuery={onOpenQuery}
          onCloseQueryTabs={onCloseQueryTabs}
          watchedTables={watchedTables}
          onToggleWatch={toggleWatchedTable}
        />
      );
  }
}
