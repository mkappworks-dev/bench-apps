import { ConnectionRail } from "./ConnectionRail";
import { useAppStore, type Tab } from "../../store/useAppStore";
import { savedQueryById } from "../../lib/savedQueries";
import type { QualifiedTable } from "../../lib/tauri";

export function QueryTab({
  tab,
  onOpenQuery,
  watchedTables,
  onToggleWatch,
}: {
  tab: Tab;
  onOpenQuery: (queryId: string) => void;
  watchedTables: Set<string>;
  onToggleWatch: (table: QualifiedTable) => void;
}) {
  const queryId = typeof tab.state.queryId === "string" ? tab.state.queryId : null;
  // Pinned at open (§3b), read from tab state rather than from the store's
  // active connection: moving the rail's picker must not retarget this tab.
  const connectionId = typeof tab.state.connectionId === "string" ? tab.state.connectionId : null;
  const savedQueries = useAppStore((s) => s.savedQueries);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const query = savedQueryById(savedQueries, queryId);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0">
      <ConnectionRail
        connectionId={connectionId}
        selected={null}
        watchedTables={watchedTables}
        onToggleWatch={onToggleWatch}
        onSelectTable={() => {}}
        onConnectionChange={setActiveConnectionId}
        initialSegment="queries"
        activeQueryId={queryId}
        onOpenQuery={onOpenQuery}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-query-tint">
        <div className="flex h-11 items-center border-b border-border px-3">
          <span className="font-mono text-xs text-text-muted">{query?.name ?? "untitled query"}</span>
        </div>
      </div>
    </div>
  );
}
