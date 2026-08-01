import { useEffect, useRef, useState } from "react";
import { SchemaTree } from "./SchemaTree";
import { DataGrid } from "./DataGrid";
import { invokeListTableRows, invokeListWatchedTables, invokeSetWatchedTable, type TableRows } from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

const PAGE_SIZE = 100;

export function DbTab({
  watchedTables,
  onToggleWatch,
  table,
  onPatchState,
}: {
  watchedTables: Set<string>;
  onToggleWatch: (table: string) => void;
  table: string | null;
  onPatchState: (patch: { table: string }) => void;
}) {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnectionId = useAppStore((s) => s.setActiveConnectionId);
  const setWatchedTables = useAppStore((s) => s.setWatchedTables);

  const [tableRows, setTableRows] = useState<TableRows | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDescending, setSortDescending] = useState(false);
  const [page, setPage] = useState(0);

  // Bumped on every fetch so a slow, superseded response (e.g. a sort click
  // fired just before a faster one) can be told apart from the latest and
  // discarded instead of clobbering it when it eventually resolves.
  const requestIdRef = useRef(0);

  async function fetchRows(t: string, connId: string, orderByColumn: string | null, orderByDesc: boolean, pageNum: number) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      // The backend has no cheap COUNT(*); over-fetching by one row and
      // trimming it is what lets hasNextPage be an honest fact instead of a
      // guess from "this page happened to come back full."
      const result = await invokeListTableRows(connId, t, {
        orderByColumn,
        orderByDesc,
        limit: PAGE_SIZE + 1,
        offset: pageNum * PAGE_SIZE,
      });
      if (requestId !== requestIdRef.current) return;
      setTableRows({ ...result, rows: result.rows.slice(0, PAGE_SIZE) });
      setHasNextPage(result.rows.length > PAGE_SIZE);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setTableRows(null);
      setHasNextPage(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  // A new table may not even have the old one's sort column, and its rows
  // start over at offset 0 — same reasoning one level up for a connection
  // switch underneath an already-open table. Clearing `tableRows` here too
  // (not just resetting sort/page/hasNextPage) drops the *previous* table's
  // grid from the DOM for the duration of the switch — leaving it mounted
  // would keep its stale hasNextPage/sort-column controls clickable against
  // a table whose page 0 hasn't been fetched yet under the new selection.
  useEffect(() => {
    setSortColumn(null);
    setSortDescending(false);
    setPage(0);
    setHasNextPage(false);
    setTableRows(null);
    setError(null);
    if (table && activeConnectionId) {
      void fetchRows(table, activeConnectionId, null, false, 0);
    } else {
      requestIdRef.current++;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, activeConnectionId]);

  function handleSort(column: string) {
    if (!table || !activeConnectionId) return;
    const descending = sortColumn === column ? !sortDescending : false;
    setSortColumn(column);
    setSortDescending(descending);
    setPage(0);
    void fetchRows(table, activeConnectionId, column, descending, 0);
  }

  function handlePrevPage() {
    if (!table || !activeConnectionId) return;
    const nextPage = Math.max(0, page - 1);
    setPage(nextPage);
    void fetchRows(table, activeConnectionId, sortColumn, sortDescending, nextPage);
  }

  function handleNextPage() {
    if (!table || !activeConnectionId) return;
    const nextPage = page + 1;
    setPage(nextPage);
    void fetchRows(table, activeConnectionId, sortColumn, sortDescending, nextPage);
  }

  // Watch state is scoped per connection, not just per app. Re-hydrating
  // whenever activeConnectionId changes keeps it in sync with the picker.
  useEffect(() => {
    if (!activeConnectionId) return;
    invokeListWatchedTables(activeConnectionId)
      .then(setWatchedTables)
      .catch(() => setWatchedTables([]));
  }, [activeConnectionId, setWatchedTables]);

  async function handleToggleWatch(table: string) {
    if (!activeConnectionId) return;
    const nextWatched = !watchedTables.has(table);
    onToggleWatch(table);
    try {
      await invokeSetWatchedTable(activeConnectionId, table, nextWatched);
    } catch {
      // Roll the optimistic toggle back rather than leaving the UI claiming a
      // table is watched when the correlation engine will not see it.
      onToggleWatch(table);
    }
  }

  return (
    <div className="-m-6 flex h-full">
      <SchemaTree
        connectionId={activeConnectionId}
        watchedTables={watchedTables}
        onToggleWatch={handleToggleWatch}
        onSelectTable={(t) => onPatchState({ table: t })}
        onConnectionChange={setActiveConnectionId}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {!activeConnectionId ? (
          <div className="text-sm text-text-faint">Select a connection to browse its data.</div>
        ) : error ? (
          <div className="rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
        ) : tableRows ? (
          <div className={loading ? "opacity-60 transition-opacity duration-200" : undefined}>
            <DataGrid
              columns={tableRows.columns}
              rows={tableRows.rows}
              sortColumn={sortColumn}
              sortDescending={sortDescending}
              onSort={handleSort}
              hasPrevPage={page > 0}
              hasNextPage={hasNextPage}
              onPrevPage={handlePrevPage}
              onNextPage={handleNextPage}
            />
          </div>
        ) : loading ? (
          <div className="text-sm text-text-faint">Loading…</div>
        ) : null}
      </div>
    </div>
  );
}
