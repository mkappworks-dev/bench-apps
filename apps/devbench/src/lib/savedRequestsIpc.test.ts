import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { invokeListSavedRequests, invokeCreateSavedRequest, invokeUpdateSavedRequest, invokeRenameSavedRequest, invokeDeleteSavedRequest } from "./tauri";
import { readComposerDraft, toSavedRequestInput } from "./apiComposer";

beforeEach(() => vi.mocked(invoke).mockClear());
it("sends saved-request scope and mutation arguments with the exact bridge shape", async () => {
  const input = toSavedRequestInput(readComposerDraft({ url: "/orders" }), "Orders", "session-a");
  await invokeListSavedRequests();
  expect(invoke).toHaveBeenLastCalledWith("list_saved_requests", { sessionId: null });
  await invokeListSavedRequests("session-a");
  expect(invoke).toHaveBeenLastCalledWith("list_saved_requests", { sessionId: "session-a" });
  await invokeCreateSavedRequest(input);
  expect(invoke).toHaveBeenLastCalledWith("create_saved_request", { input });
  await invokeUpdateSavedRequest("saved-1", input);
  expect(invoke).toHaveBeenLastCalledWith("update_saved_request", { id: "saved-1", input });
  await invokeRenameSavedRequest("saved-1", "Checkout");
  expect(invoke).toHaveBeenLastCalledWith("rename_saved_request", { id: "saved-1", name: "Checkout" });
  await invokeDeleteSavedRequest("saved-1");
  expect(invoke).toHaveBeenLastCalledWith("delete_saved_request", { id: "saved-1" });
  expect(input).toHaveProperty("body_type", "none");
  expect(input).toHaveProperty("session_id", "session-a");
  expect(input).not.toHaveProperty("params");
});
