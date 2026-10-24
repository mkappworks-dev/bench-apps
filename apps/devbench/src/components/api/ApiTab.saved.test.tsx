import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTab } from "./ApiTab";
import { useAppStore } from "../../store/useAppStore";
import * as ipc from "../../lib/tauri";
import { readComposerDraft, type SavedRequest } from "../../lib/apiComposer";

const definition = (patch: Partial<SavedRequest> = {}): SavedRequest => ({
  id: "saved-1", name: "Orders", session_id: "session-a", method: "POST", url: "/orders?status=pending",
  headers: [{ key: "X-Debug", value: "yes", enabled: false }], body: '{"sku":"WIDGET-1"}', body_type: "json",
  auth: { type: "bearer", token: "test-token", username: "", password: "", keyName: "X-Api-Key", keyValue: "", keyIn: "header" },
  created_at: "2026-01-01", updated_at: "2026-01-02", ...patch,
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
let persisted: Record<string, unknown>;
function Composer({ initialState = {} }: { initialState?: Record<string, unknown> }) {
  const [state, setState] = useState(initialState);
  persisted = state;
  return <ApiTab tab={{ id: "api-test", kind: "api", pane: "left", ordinal: 0, state }}
    onPatchState={(patch) => setState((old) => ({ ...old, ...patch }))}
    onOpenDb={() => {}} onOpenLog={() => {}} onOpenEmail={() => {}} />;
}

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ activeSessionId: null, activeConnectionId: "c1", watchedTables: new Set(), watchedTableList: [] });
  vi.spyOn(ipc, "invokeListHistory").mockResolvedValue([]);
  vi.spyOn(ipc, "invokeListSavedRequests").mockResolvedValue([definition()]);
  vi.spyOn(ipc, "invokeCreateSavedRequest").mockImplementation(async (input) => ({ ...input, id: "created", created_at: "2026-01-01", updated_at: "2026-01-02" }));
  vi.spyOn(ipc, "invokeUpdateSavedRequest").mockImplementation(async (id, input) => ({ ...input, id, created_at: "2026-01-01", updated_at: "2026-01-03" }));
  vi.spyOn(ipc, "invokeRenameSavedRequest").mockImplementation(async (id, name) => definition({ id, name }));
  vi.spyOn(ipc, "invokeDeleteSavedRequest").mockResolvedValue();
  vi.spyOn(ipc, "invokeRunCorrelatedRequest").mockResolvedValue({ correlation_id: "corr-1", history_id: "hist-1", response: { status_code: 201, headers: [], body: "{}", duration_ms: 1 }, table_diffs: [], db_error: null });
  vi.spyOn(ipc, "invokeCollectCorrelationWindow").mockReturnValue(new Promise(() => {}));
  vi.spyOn(window, "prompt").mockReturnValue("My request");
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("saved API requests", () => {
  it("loads a complete definition, marks edits dirty, and never saves when sending", async () => {
    render(<Composer />);
    fireEvent.click(await screen.findByRole("button", { name: "Load saved request Orders" }));
    expect(screen.getByText(/Editing saved request/)).toHaveTextContent("Orders");
    expect(screen.getByLabelText("Request URL")).toHaveValue("/orders?status=pending");
    expect(screen.getByLabelText("Header 1 key")).toHaveValue("X-Debug");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(persisted).toMatchObject({ loadedSavedId: "saved-1", bodyType: "json", body: '{"sku":"WIDGET-1"}', auth: { token: "test-token" }, dirty: false });
    fireEvent.change(screen.getByLabelText("Request URL"), { target: { value: "/orders/42" } });
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(ipc.invokeRunCorrelatedRequest).toHaveBeenCalled());
    expect(ipc.invokeRunCorrelatedRequest).toHaveBeenCalledWith(expect.objectContaining({ request: { method: "POST", url: "/orders/42", headers: [{ key: "Authorization", value: "Bearer test-token" }], body: '{"sku":"WIDGET-1"}' } }));
    expect(ipc.invokeCreateSavedRequest).not.toHaveBeenCalled();
    expect(ipc.invokeUpdateSavedRequest).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument();
  });

  it("creates on first Save, updates the same row later, and works without a DB connection", async () => {
    useAppStore.setState({ activeConnectionId: null, activeSessionId: "session-a" });
    render(<Composer initialState={{ url: "/new" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.invokeCreateSavedRequest).toHaveBeenCalledWith(expect.objectContaining({ name: "My request", session_id: "session-a", url: "/new" })));
    await waitFor(() => expect(screen.getByText(/Editing saved request/)).toHaveTextContent("My request"));
    fireEvent.change(screen.getByLabelText("Request URL"), { target: { value: "/edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.invokeUpdateSavedRequest).toHaveBeenCalledWith("created", expect.objectContaining({ url: "/edited", session_id: "session-a" })));
    await waitFor(() => expect(screen.queryByText(/unsaved changes/)).not.toBeInTheDocument());
    expect(ipc.invokeCreateSavedRequest).toHaveBeenCalledTimes(1);
    expect(window.prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("preserves the original session when updating a definition from the unscoped list", async () => {
    render(<Composer />);
    fireEvent.click(await screen.findByRole("button", { name: "Load saved request Orders" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ipc.invokeUpdateSavedRequest).toHaveBeenCalledWith("saved-1", expect.objectContaining({ session_id: "session-a" })));
  });

  it("keeps newer edits dirty when an older Save finishes", async () => {
    const pending = deferred<SavedRequest>();
    vi.mocked(ipc.invokeUpdateSavedRequest).mockReturnValue(pending.promise);
    render(<Composer />);
    fireEvent.click(await screen.findByRole("button", { name: "Load saved request Orders" }));
    fireEvent.change(screen.getByLabelText("Request URL"), { target: { value: "/at-save" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByLabelText("Request URL"), { target: { value: "/newer-edit" } });
    await act(async () => pending.resolve(definition({ url: "/at-save" })));
    expect(screen.getByLabelText("Request URL")).toHaveValue("/newer-edit");
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument();
  });

  it("does not replace a newly loaded definition with an older pending Save", async () => {
    const second = definition({ id: "saved-2", name: "Health", method: "GET", url: "/health" });
    vi.mocked(ipc.invokeListSavedRequests).mockResolvedValue([definition(), second]);
    const pending = deferred<SavedRequest>();
    vi.mocked(ipc.invokeUpdateSavedRequest).mockReturnValue(pending.promise);
    render(<Composer />);
    fireEvent.click(await screen.findByRole("button", { name: "Load saved request Orders" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Load saved request Health" }));
    await act(async () => pending.resolve(definition()));
    expect(screen.getByText(/Editing saved request/)).toHaveTextContent("Health");
    expect(screen.getByLabelText("Request URL")).toHaveValue("/health");
    expect(persisted.loadedSavedId).toBe("saved-2");
  });

  it("keeps dirty state on failed Save and ignores a cancelled first Save", async () => {
    vi.mocked(window.prompt).mockReturnValue(null);
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(ipc.invokeCreateSavedRequest).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Load saved request Orders" }));
    fireEvent.change(screen.getByLabelText("Request URL"), { target: { value: "/dirty" } });
    vi.mocked(ipc.invokeUpdateSavedRequest).mockRejectedValue(new Error("SQLite is busy"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SQLite is busy");
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument();
  });

  it("renames without changing the draft and deletes only after confirmation", async () => {
    render(<Composer />);
    fireEvent.click(await screen.findByRole("button", { name: "Load saved request Orders" }));
    vi.mocked(window.prompt).mockReturnValue("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Orders" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load saved request Checkout" })).toBeInTheDocument());
    expect(ipc.invokeRenameSavedRequest).toHaveBeenCalledWith("saved-1", "Checkout");
    expect(screen.getByLabelText("Request URL")).toHaveValue("/orders?status=pending");
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Checkout" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(ipc.invokeDeleteSavedRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Checkout" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load saved request Checkout" })).not.toBeInTheDocument());
    expect(ipc.invokeDeleteSavedRequest).toHaveBeenCalledWith("saved-1");
    expect(persisted.loadedSavedId).toBeNull();
    expect(screen.getByLabelText("Request URL")).toHaveValue("/orders?status=pending");
  });

  it("rehydrates all composer fields after remount and keeps History independent", async () => {
    vi.mocked(ipc.invokeListHistory).mockResolvedValue([{ id: "history", method: "GET", url: "/from-history", status_code: 200, response_body: "history body", duration_ms: 1, fired_at: "now", session_id: null, request_headers: [], request_body: null, response_headers: [] }]);
    const initial = { ...readComposerDraft({}), headers: definition().headers, body: "draft text", bodyType: "text", auth: definition().auth, activeReqTab: "auth", loadedSavedId: "saved-1", loadedSavedName: "Orders", loadedSavedSessionId: "session-a", dirty: true };
    const first = render(<Composer initialState={initial} />);
    expect(screen.getByLabelText("Token")).toHaveValue("test-token");
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "edited-token" } });
    const restored = persisted;
    first.unmount();
    render(<Composer initialState={restored} />);
    expect(screen.getByLabelText("Token")).toHaveValue("edited-token");
    expect(persisted).toMatchObject({ headers: definition().headers, body: "draft text", bodyType: "text", dirty: true });
    fireEvent.click(await screen.findByRole("button", { name: /from-history/ }));
    expect(await screen.findByText("history body")).toBeInTheDocument();
    expect(screen.getByLabelText("Token")).toHaveValue("edited-token");
    expect(persisted).toMatchObject({ loadedSavedId: "saved-1", dirty: true });
  });
  it("keeps edits made during first Save and prevents duplicate creates", async () => {
    const pending = deferred<SavedRequest>();
    vi.mocked(ipc.invokeCreateSavedRequest).mockReturnValue(pending.promise);
    render(<Composer initialState={{ url: "/before-save" }} />);
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(ipc.invokeCreateSavedRequest).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Request URL"), { target: { value: "/after-save" } });
    await act(async () => pending.resolve(definition({ id: "created", name: "My request", url: "/before-save", session_id: null })));
    expect(screen.getByLabelText("Request URL")).toHaveValue("/after-save");
    expect(persisted).toMatchObject({ loadedSavedId: "created", dirty: true });
  });

  it("does not attach an old Save to the next session's draft", async () => {
    const pending = deferred<SavedRequest>();
    vi.mocked(ipc.invokeCreateSavedRequest).mockReturnValue(pending.promise);
    vi.mocked(ipc.invokeListSavedRequests).mockResolvedValue([]);
    useAppStore.setState({ activeSessionId: "session-a" });
    render(<Composer initialState={{ url: "/draft" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    act(() => useAppStore.getState().setActiveSessionId("session-b"));
    await act(async () => pending.resolve(definition({ id: "created", name: "My request" })));
    expect(screen.queryByText(/Editing saved request/)).not.toBeInTheDocument();
    expect(persisted.loadedSavedId).not.toBe("created");
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("detaches a missing restored definition without losing its draft", async () => {
    vi.mocked(ipc.invokeListSavedRequests).mockResolvedValue([]);
    render(<Composer initialState={{ url: "/kept", body: "keep me", bodyType: "text", loadedSavedId: "deleted", loadedSavedName: "Old request" }} />);
    await waitFor(() => expect(persisted.loadedSavedId).toBeNull());
    expect(persisted).toMatchObject({ url: "/kept", body: "keep me", bodyType: "text" });
  });

  it("retains a definition when Delete fails", async () => {
    vi.mocked(ipc.invokeDeleteSavedRequest).mockRejectedValue(new Error("Delete failed"));
    render(<Composer />);
    await screen.findByRole("button", { name: "Load saved request Orders" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Orders" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Delete failed");
    expect(screen.getByRole("button", { name: "Load saved request Orders" })).toBeInTheDocument();
  });

  it("clears transient param rows even when loading the same URL", async () => {
    render(<Composer initialState={{ url: "/orders?status=pending" }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Params" }));
    fireEvent.click(screen.getByRole("button", { name: "Add param" }));
    expect(screen.getByLabelText("Param 2 key")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Load saved request Orders" }));
    expect(screen.queryByLabelText("Param 2 key")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Param 1 key")).toHaveValue("status");
    expect(persisted.dirty).toBe(false);
  });

  it("ignores a late send response after loading a different definition", async () => {
    const pending = deferred<ipc.CorrelationResult>();
    vi.mocked(ipc.invokeRunCorrelatedRequest).mockReturnValue(pending.promise);
    vi.mocked(ipc.invokeListSavedRequests).mockResolvedValue([definition(), definition({ id: "saved-2", name: "Health", url: "/health" })]);
    render(<Composer />);
    fireEvent.click(await screen.findByRole("button", { name: "Load saved request Orders" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Load saved request Health" }));
    await act(async () => pending.resolve({ correlation_id: "late", history_id: null, response: { status_code: 200, headers: [], body: "old response", duration_ms: 1 }, table_diffs: [], db_error: null }));
    expect(screen.queryByText("old response")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Request URL")).toHaveValue("/health");
  });

});
