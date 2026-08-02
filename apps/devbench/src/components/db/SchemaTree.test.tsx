import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SchemaTree } from "./SchemaTree";
import * as tauriLib from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

describe("SchemaTree", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ route: "workspace", settingsPane: "general" });
  });

  it("lists tables for the given connection", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);

    render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
  });

  it("toggles watch state from the tree", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    const onToggleWatch = vi.fn();

    render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={onToggleWatch}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /watch orders/i }));
    expect(onToggleWatch).toHaveBeenCalledWith("orders");
  });

  // Base UI's Menu is the styled picker used everywhere else (Method,
  // Theme, …) — the raw <select> this used to be is gone project-wide.
  it("shows saved connections in the picker and reports a change, via the styled Menu (not a native select)", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([
      { id: "c1", name: "Local Dev", engine: "postgres", host: "localhost", port: 5432, database: "devbench_test", username: "postgres", sslmode: "disable", has_password: true },
      { id: "c2", name: "Staging", engine: "postgres", host: "staging-db.internal", port: 5432, database: "app", username: "app_ro", sslmode: "require", has_password: true },
    ]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    const onConnectionChange = vi.fn();

    const { container } = render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={onConnectionChange}
      />,
    );

    const picker = await screen.findByRole("button", { name: /connection/i });
    expect(container.querySelector("select")).toBeNull();
    expect(picker).toHaveTextContent("Local Dev");

    fireEvent.click(picker);
    // The host line is part of each option's accessible name on purpose —
    // "Staging" alone doesn't say which server you're about to browse.
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Staging.*staging-db\.internal:5432\/app/ }));

    expect(onConnectionChange).toHaveBeenCalledWith("c2");
  });

  // Landing on Settings > General would make the user hunt for the pane they
  // just asked for by name, so the pane is part of what this action navigates to.
  it("'Manage connections…' opens Settings on the Connections pane, not just Settings", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([
      { id: "c1", name: "Local Dev", engine: "postgres", host: "localhost", port: 5432, database: "devbench_test", username: "postgres", sslmode: "disable", has_password: true },
    ]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);

    render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /connection/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Manage connections/ }));

    await waitFor(() => expect(useAppStore.getState().route).toBe("settings"));
    expect(useAppStore.getState().settingsPane).toBe("connections");
  });

  it("shows a distinct empty state when no connection is selected yet, not blank space", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([
      { id: "c1", name: "Local Dev", engine: "postgres", host: "localhost", port: 5432, database: "devbench_test", username: "postgres", sslmode: "disable", has_password: true },
    ]);
    const listTables = vi.spyOn(tauriLib, "invokeDbConnectAndListTables");

    render(
      <SchemaTree
        connectionId={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );

    expect(await screen.findByText(/select a connection/i)).toBeInTheDocument();
    expect(listTables).not.toHaveBeenCalled();
  });

  it("shows a distinct error when the selected connection fails to load, not the no-connection copy", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockRejectedValue(new Error("connection refused"));

    render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );

    expect(await screen.findByText(/connection refused/)).toBeInTheDocument();
    expect(screen.queryByText(/select a connection/i)).not.toBeInTheDocument();
  });

  // The bug this guards: folding a failed connections fetch into the
  // zero-connections branch tells a user with connections configured to go
  // add one, when the real problem is a transient load failure.
  it("shows a distinct error when the connections list itself fails to load, not the zero-connections copy", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockRejectedValue(new Error("keychain locked"));
    const listTables = vi.spyOn(tauriLib, "invokeDbConnectAndListTables");

    render(
      <SchemaTree
        connectionId={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );

    expect(await screen.findByText(/keychain locked/)).toBeInTheDocument();
    expect(screen.queryByText("Add a connection in Settings to browse a database.")).not.toBeInTheDocument();
    expect(listTables).not.toHaveBeenCalled();
  });

  it("shows the zero-connections empty state once the list has actually loaded and is empty", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);

    render(
      <SchemaTree
        connectionId={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );

    expect(await screen.findByText("Add a connection in Settings to browse a database.")).toBeInTheDocument();
    expect(screen.getByText("No connections")).toBeInTheDocument();
  });

  it("exposes each table as a keyboard-reachable button, not a clickable div", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    const onSelectTable = vi.fn();

    render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={onSelectTable}
        onConnectionChange={() => {}}
      />,
    );

    await waitFor(() => screen.getByText("orders"));
    const select = screen.getByRole("button", { name: "Browse orders" });
    select.focus();
    expect(select).toHaveFocus();
    fireEvent.click(select);
    expect(onSelectTable).toHaveBeenCalledWith("orders");
  });

  // Nesting a <button> inside a <button> is invalid HTML and breaks focus.
  it("keeps the watch toggle a sibling of the select button, never nested", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    render(
      <SchemaTree
        connectionId="c1"
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
      />,
    );
    await waitFor(() => screen.getByText("orders"));
    const watch = screen.getByRole("button", { name: "watch orders" });
    expect(watch.querySelector("button")).toBeNull();
    expect(watch.closest("button")).toBe(watch);
  });
});
