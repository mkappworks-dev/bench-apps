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

  it("deletes a connection", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([connection()]);
    const del = vi.spyOn(tauriLib, "invokeDeleteConnection").mockResolvedValue(undefined);
    render(<ConnectionsPane />);
    await waitFor(() => screen.getByText("Local Dev"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Local Dev" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("c1"));
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
