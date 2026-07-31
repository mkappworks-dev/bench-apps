import { ToolTabs } from "./ToolTabs";
import { ToolPane } from "./ToolPane";
import { useAppStore } from "../../store/useAppStore";

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
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const secondaryTab = useAppStore((s) => s.secondaryTab);
  const setSecondaryTab = useAppStore((s) => s.setSecondaryTab);
  const splitOpen = useAppStore((s) => s.splitOpen);
  const setSplitOpen = useAppStore((s) => s.setSplitOpen);

  const paneProps = { dbFocusTable, emailFocusId, onOpenTableInDb, onOpenEmail };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The primary pane's tab bar owns `activeTab`, so every existing
            deep-link (`setActiveTab("db")` from the rollup) lands here
            unchanged whether or not the split is open. */}
        <ToolTabs value={activeTab} onValueChange={setActiveTab}>
          <button
            onClick={() => setSplitOpen(!splitOpen)}
            className="ml-auto rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
          >
            Split
          </button>
        </ToolTabs>
        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <ToolPane tab={activeTab} {...paneProps} />
        </main>
      </div>

      {splitOpen ? (
        <div className="flex min-w-0 flex-1 flex-col border-l border-border">
          <ToolTabs value={secondaryTab} onValueChange={setSecondaryTab}>
            <button
              aria-label="Close split"
              onClick={() => setSplitOpen(false)}
              className="ml-auto rounded-sm px-2.5 py-1.5 text-xs text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
            >
              ✕
            </button>
          </ToolTabs>
          <main className="min-h-0 flex-1 overflow-y-auto p-6">
            <ToolPane tab={secondaryTab} {...paneProps} />
          </main>
        </div>
      ) : null}
    </div>
  );
}
