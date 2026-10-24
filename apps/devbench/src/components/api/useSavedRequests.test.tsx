import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useSavedRequests, publishSavedRequestChange } from "./useSavedRequests";
import * as ipc from "../../lib/tauri";
import { readComposerDraft, toSavedRequestInput, type SavedRequest } from "../../lib/apiComposer";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const item = (id: string, session_id: string | null, updated_at: string): SavedRequest => ({ ...toSavedRequestInput(readComposerDraft({}), id, session_id), id, created_at: "2000", updated_at });
beforeEach(() => vi.restoreAllMocks());

it("does not restore deleted rows from an earlier read in any mounted list", async () => {
  const pending = deferred<SavedRequest[]>();
  vi.spyOn(ipc, "invokeListSavedRequests").mockReturnValue(pending.promise);
  const all = renderHook(() => useSavedRequests(null));
  const scoped = renderHook(() => useSavedRequests("a"));
  const request = item("one", "a", "2001");
  act(() => publishSavedRequestChange({ kind: "upsert", request: { ...request, name: "Renamed" } }));
  act(() => publishSavedRequestChange({ kind: "delete", id: request.id }));
  await act(async () => pending.resolve([request]));
  await waitFor(() => expect(all.result.current.loading).toBe(false));
  expect(all.result.current.items).toEqual([]);
  expect(scoped.result.current.items).toEqual([]);
});

it("updates all mounted lists with successful creates/renames while preserving scope and sort", async () => {
  vi.spyOn(ipc, "invokeListSavedRequests").mockResolvedValue([]);
  const all = renderHook(() => useSavedRequests(null));
  const scoped = renderHook(() => useSavedRequests("a"));
  await waitFor(() => expect(all.result.current.loading).toBe(false));
  const a = item("a", "a", "2000"); const b = item("b", "b", "2001");
  act(() => { publishSavedRequestChange({ kind: "upsert", request: a }); publishSavedRequestChange({ kind: "upsert", request: b }); });
  expect(all.result.current.items.map((r) => r.id)).toEqual(["b", "a"]);
  expect(scoped.result.current.items.map((r) => r.id)).toEqual(["a"]);
  act(() => publishSavedRequestChange({ kind: "upsert", request: { ...a, name: "Renamed", updated_at: "2002" } }));
  expect(all.result.current.items[0].name).toBe("Renamed");
  expect(scoped.result.current.items[0].name).toBe("Renamed");
});

it("clears foreign-session rows immediately and ignores an out-of-order read", async () => {
  const a = deferred<SavedRequest[]>(); const b = deferred<SavedRequest[]>();
  vi.spyOn(ipc, "invokeListSavedRequests").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const view = renderHook(({ session }) => useSavedRequests(session), { initialProps: { session: "a" } });
  view.rerender({ session: "b" });
  expect(view.result.current.items).toEqual([]);
  expect(view.result.current.loading).toBe(true);
  await act(async () => b.resolve([item("b", "b", "2001")]));
  await act(async () => a.resolve([item("a", "a", "2000")]));
  expect(view.result.current.items.map((r) => r.id)).toEqual(["b"]);
});

it("reports a failed read rather than claiming the list is empty", async () => {
  vi.spyOn(ipc, "invokeListSavedRequests").mockRejectedValue(new Error("read failed"));
  const view = renderHook(() => useSavedRequests(null));
  await waitFor(() => expect(view.result.current.error).toBe("read failed"));
  expect(view.result.current.loading).toBe(false);
});
