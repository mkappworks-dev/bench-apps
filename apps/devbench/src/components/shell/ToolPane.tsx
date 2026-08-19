import type { Tab } from "../../store/useAppStore";
import type { QualifiedTable } from "../../lib/tauri";
import { normalizeTable } from "../../lib/tableIdentity";
import { ApiTab } from "../api/ApiTab";
import { DbTab } from "../db/DbTab";
import { LogTab } from "../log/LogTab";
import { EmailTab } from "../email/EmailTab";
import { useAppStore } from "../../store/useAppStore";

/**
 * Renders one tab instance. Every pane's every tab goes through this, which
 * is what keeps "any tool, any number of times, in either pane" true by
 * construction. `onOpenDb`/`onOpenLog`/`onOpenEmail` are the Rollup deep
 * links; only the "api" case uses them. `onOpenHistory` is the reverse deep
 * link (Email's "Sent by" chip); only the "email" case uses it. `emailFocusId`
 * and `historyFocusId` only matter to the "email"/"api" case respectively,
 * and only when this specific tab is the deep link's target (App.tsx resolves
 * that before this component ever sees it).
 */
export function ToolPane({
  tab,
  onPatchState,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
  emailFocusId,
  onOpenHistory,
  historyFocusId,
}: {
  tab: Tab;
  onPatchState: (patch: Record<string, unknown>) => void;
  onOpenDb: (table: QualifiedTable) => void;
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
          // `tab.state` is an untyped bag (Record<string, unknown>) — normalizeTable
          // guards the shape here rather than casting it, since a cast would let
          // anything else the bag might hold through unchecked. DbTab normalizes
          // again internally, so this is defense in depth, not redundant: it's
          // what keeps a malformed value from ever reaching DbTab as if it were
          // a validated QualifiedTable.
          table={normalizeTable(tab.state.table)}
          onPatchState={onPatchState}
        />
      );
    case "log":
      return (
        <LogTab sourceId={typeof tab.state.sourceId === "string" ? tab.state.sourceId : null} onPatchState={onPatchState} />
      );
    case "email":
      return <EmailTab focusEmailId={emailFocusId} onOpenHistory={onOpenHistory} />;
  }
}
