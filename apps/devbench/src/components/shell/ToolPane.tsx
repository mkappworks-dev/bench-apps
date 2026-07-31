import type { TabId } from "../../store/useAppStore";
import { ApiTab } from "../api/ApiTab";
import { DbTab } from "../db/DbTab";
import { LogTab } from "../log/LogTab";
import { EmailTab } from "../email/EmailTab";
import { useAppStore } from "../../store/useAppStore";

/**
 * Renders one tool. Both panes use this, which is what keeps "any of the four
 * tools in either pane" true by construction rather than by discipline.
 */
export function ToolPane({
  tab,
  dbFocusTable,
  emailFocusId,
  onOpenTableInDb,
  onOpenEmail,
}: {
  tab: TabId;
  dbFocusTable: string | null;
  emailFocusId: number | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
}) {
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);

  switch (tab) {
    case "api":
      return <ApiTab onOpenTableInDb={onOpenTableInDb} onOpenEmail={onOpenEmail} />;
    case "db":
      return (
        <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
      );
    case "log":
      return <LogTab />;
    case "email":
      return <EmailTab focusEmailId={emailFocusId} />;
  }
}
