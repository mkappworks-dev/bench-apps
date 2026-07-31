import { ToolPane } from "./ToolPane";
import { useAppStore } from "../../store/useAppStore";

/**
 * Panes only. The tab bars and the Split control live in AppStrip, so that each
 * pane's tabs can sit directly above the pane in the same grid column.
 */
export function SplitContent({
  dbFocusTable,
  emailFocusId,
  onOpenTableInDb,
  onOpenEmail,
}: {
  dbFocusTable: string | null;
  emailFocusId: number | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
}) {
  const activeTab = useAppStore((s) => s.activeTab);
  const secondaryTab = useAppStore((s) => s.secondaryTab);
  const splitOpen = useAppStore((s) => s.splitOpen);

  const paneProps = { dbFocusTable, emailFocusId, onOpenTableInDb, onOpenEmail };

  return (
    <div className="flex min-h-0 flex-1">
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        <ToolPane tab={activeTab} {...paneProps} />
      </main>
      {splitOpen ? (
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto border-l border-border p-6">
          <ToolPane tab={secondaryTab} {...paneProps} />
        </main>
      ) : null}
    </div>
  );
}
