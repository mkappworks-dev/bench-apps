import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConnectionsPane } from "./ConnectionsPane";
import * as tauriLib from "../../lib/tauri";
import type { ConnectionSummary } from "../../lib/tauri";

function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: "c1",
    name: "Local Dev",
    engine: "postgres",
    host: "localhost",
    port: 5432,
    database: "devbench_test",
    username: "postgres",
    sslmode: "disable",
    has_password: true,
    ...overrides,
  };
}

describe("ConnectionsPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists saved connections", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    render(<ConnectionsPane />);
    await waitFor(() => expect(screen.getByText("Local Dev")).toBeInTheDocument());
    expect(screen.getByText(/localhost:5432\/devbench_test/)).toBeInTheDocument();
  });

  it("opens a blank modal when Add connection is clicked", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("+ Add connection"));
    fireEvent.click(screen.getByText("+ Add connection"));
    expect(await screen.findByText("Add a connection")).toBeInTheDocument();
  });

  it("opens an edit modal pre-filled with the connection's real values", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([
      connection({ name: "Staging", host: "staging-db.internal" }),
    ]);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Staging"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Staging" }));
    expect(await screen.findByText("Edit connection — Staging")).toBeInTheDocument();
    expect(screen.getByDisplayValue("staging-db.internal")).toBeInTheDocument();
  });

  it("never renders a stored password's value", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local Dev" }));
    const passwordInput = (await screen.findByPlaceholderText("•••••••• (stored)")) as HTMLInputElement;
    expect(passwordInput.value).toBe("");
  });

  it("clears a stored password directly, without touching Save", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    const clear = vi.spyOn(tauriLib, "invokeClearConnectionPassword").mockResolvedValue(undefined);
    const update = vi.spyOn(tauriLib, "invokeUpdateConnection");
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local Dev" }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear stored password" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("c1"));
    expect(update).not.toHaveBeenCalled();
  });

  it("offers no clear-password action for a connection with none stored", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection({ has_password: false })]);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local Dev" }));
    await screen.findByPlaceholderText("Enter a password");
    expect(screen.queryByRole("button", { name: "Clear stored password" })).not.toBeInTheDocument();
  });

  it("keeps pending field edits after clearing a stored password, instead of silently discarding them", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    vi.spyOn(tauriLib, "invokeClearConnectionPassword").mockResolvedValue(undefined);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local Dev" }));

    const hostInput = await screen.findByLabelText("Host");
    fireEvent.change(hostInput, { target: { value: "edited-before-clearing.internal" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear stored password" }));

    await waitFor(() => expect(tauriLib.invokeClearConnectionPassword).toHaveBeenCalledWith("c1"));
    // The modal must still be open with the unrelated edit intact.
    expect(screen.getByText("Edit connection — Local Dev")).toBeInTheDocument();
    expect(screen.getByDisplayValue("edited-before-clearing.internal")).toBeInTheDocument();
    // The Clear button is replaced by confirmation, and reflects the new state.
    expect(screen.queryByRole("button", { name: "Clear stored password" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter a password")).toBeInTheDocument();
  });

  it("lets Escape close the modal immediately on open, with no prior click inside it", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("+ Add connection"));
    fireEvent.click(screen.getByText("+ Add connection"));
    const nameInput = await screen.findByLabelText("Name");
    // Opening must claim focus itself (as NewSessionDialog does) — otherwise a
    // keydown fired with no prior click never reaches the dialog's handler,
    // since it bubbles from whatever element focus is actually sitting on.
    expect(document.activeElement).toBe(nameInput);
    fireEvent.keyDown(nameInput, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Add a connection")).not.toBeInTheDocument());
  });

  it("deletes a connection and reflects its removal from the list", async () => {
    const list = vi.spyOn(tauriLib, "invokeListConnections");
    list.mockResolvedValueOnce([connection()]).mockResolvedValueOnce([]);
    const del = vi.spyOn(tauriLib, "invokeDeleteConnection").mockResolvedValue(undefined);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Local Dev" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("Local Dev")).not.toBeInTheDocument());
  });

  it("surfaces a delete failure instead of swallowing it, and leaves the row in place", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    vi.spyOn(tauriLib, "invokeDeleteConnection").mockRejectedValue(new Error("connection is in use"));
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Local Dev" }));
    expect(await screen.findByText(/connection is in use/)).toBeInTheDocument();
    expect(screen.getByText("Local Dev")).toBeInTheDocument();
  });

  it("shows a distinct load-failure message rather than the empty-list copy", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockRejectedValue(new Error("database is locked"));
    render(<ConnectionsPane />);
    expect(await screen.findByText(/database is locked/)).toBeInTheDocument();
    expect(
      screen.queryByText("No connections configured. Add one to browse and query a database."),
    ).not.toBeInTheDocument();
  });

  it("tests a saved connection against its stored secret when the password field is untouched", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    const testSaved = vi.spyOn(tauriLib, "invokeTestSavedConnection").mockResolvedValue(undefined);
    const testFresh = vi.spyOn(tauriLib, "invokeTestConnection");
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local Dev" }));
    await screen.findByText("Edit connection — Local Dev");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(testSaved).toHaveBeenCalledWith("c1"));
    expect(testFresh).not.toHaveBeenCalled();
    expect(await screen.findByText("Connected successfully.")).toBeInTheDocument();
  });

  it("tests with the retyped password when editing and a new password was entered", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    const testFresh = vi.spyOn(tauriLib, "invokeTestConnection").mockResolvedValue(undefined);
    const testSaved = vi.spyOn(tauriLib, "invokeTestSavedConnection");
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local Dev" }));
    const passwordInput = await screen.findByPlaceholderText("•••••••• (stored)");
    fireEvent.change(passwordInput, { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(testFresh).toHaveBeenCalledWith(expect.objectContaining({ password: "new-secret" })),
    );
    expect(testSaved).not.toHaveBeenCalled();
  });

  it("tests a fresh, unsaved connection directly and reports a failure honestly", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    const testFresh = vi.spyOn(tauriLib, "invokeTestConnection").mockRejectedValue(new Error("refused"));
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("+ Add connection"));
    fireEvent.click(screen.getByText("+ Add connection"));
    await screen.findByText("Add a connection");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(testFresh).toHaveBeenCalled());
    expect(await screen.findByText("Could not connect.")).toBeInTheDocument();
  });

  it("creates a connection from the add modal without ever calling set_connection_password for a fresh create", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    const create = vi.spyOn(tauriLib, "invokeCreateConnection").mockResolvedValue(connection());
    const setPassword = vi.spyOn(tauriLib, "invokeSetConnectionPassword").mockResolvedValue(undefined);

    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("+ Add connection"));
    fireEvent.click(screen.getByText("+ Add connection"));

    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Staging" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "staging-db.internal" } });
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "app" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "app_ro" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Staging" })));
    expect(setPassword).not.toHaveBeenCalled();
  });
});
