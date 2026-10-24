import { useEffect, useState } from "react";
import { invokeListSavedRequests, type SavedRequest } from "../../lib/tauri";

export type SavedRequestChange = { kind: "upsert"; request: SavedRequest } | { kind: "delete"; id: string };
const listeners = new Set<(change: SavedRequestChange) => void>();
export function publishSavedRequestChange(change: SavedRequestChange) {
  for (const listener of listeners) listener(change);
}

function applyChange(items: SavedRequest[], change: SavedRequestChange, sessionId: string | null): SavedRequest[] {
  const id = change.kind === "delete" ? change.id : change.request.id;
  const next = items.filter((item) => item.id !== id);
  if (change.kind === "upsert" && (sessionId === null || change.request.session_id === sessionId)) next.push(change.request);
  return next.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}
interface SavedList {
  sessionId: string | null;
  items: SavedRequest[];
  loading: boolean;
  error: string | null;
}

export function useSavedRequests(sessionId: string | null) {
  const [list, setList] = useState<SavedList>({ sessionId, items: [], loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const duringRead: SavedRequestChange[] = [];
    setList({ sessionId, items: [], loading: true, error: null });
    const changed = (change: SavedRequestChange) => {
      if (!settled) duringRead.push(change);
      setList((current) => current.sessionId === sessionId
        ? { ...current, items: applyChange(current.items, change, sessionId) } : current);
    };
    listeners.add(changed);
    invokeListSavedRequests(sessionId).then((items) => {
      if (cancelled) return;
      settled = true;
      // A mutation can finish after this read began; it is newer evidence.
      const merged = duringRead.reduce((current, change) => applyChange(current, change, sessionId), items);
      setList({ sessionId, items: merged, loading: false, error: null });
    }).catch((error: unknown) => {
      if (cancelled) return;
      settled = true;
      setList((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
    });
    return () => { cancelled = true; listeners.delete(changed); };
  }, [sessionId]);
  return list.sessionId === sessionId ? list : { sessionId, items: [], loading: true, error: null };
}
