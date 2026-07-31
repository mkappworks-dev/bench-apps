import type { Tab } from "../../store/useAppStore";
import { ApiTab } from "../api/ApiTab";
import { DbTab } from "../db/DbTab";
import { LogTab } from "../log/LogTab";
import { EmailTab } from "../email/EmailTab";
import { useAppStore } from "../../store/useAppStore";

/**
 * Renders one tab instance. Every pane's every tab goes through this, which
 * is what keeps "any tool, any number of times, in either pane" true by
 * construction. `onOpenDb`/`onOpenLog`/`onOpenEmail` are the Rollup deep
 * links; only the "api" case uses them. `emailFocusId` only matters to the
 * "email" case, and only when this specific tab is the deep link's target
 * (App.tsx resolves that before this component ever sees it).
 */
export function ToolPane({
  tab,
  onPatchState,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
  emailFocusId,
}: {
  tab: Tab;
  onPatchState: (patch: Record<string, unknown>) => void;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
  emailFocusId: number | null;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);

  switch (tab.kind) {
    case "api":
      // ApiTab still takes its Task-1-era prop names here; Task 6 renames
      // them on ApiTab itself and this bridge goes away.
      return <ApiTab onOpenTableInDb={onOpenDb} onOpenEmail={onOpenEmail} />;
    case "db":
      return (
        <DbTab
          watchedTables={watchedTables}
          onToggleWatch={toggleWatchedTable}
          table={typeof tab.state.table === "string" ? tab.state.table : null}
          onPatchState={onPatchState}
        />
      );
    case "log":
      return (
        <LogTab sourceId={typeof tab.state.sourceId === "string" ? tab.state.sourceId : null} onPatchState={onPatchState} />
      );
    case "email":
      return <EmailTab focusEmailId={emailFocusId} />;
  }
}
