import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConnectionRail } from "./ConnectionRail";
import * as tauriLib from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

describe("ConnectionRail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ route: "workspace", settingsPane: "general", savedQueries: [] });
  });

  it("lists tables for the given connection", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);

    render(
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
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
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={onToggleWatch}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /watch public\.orders/i }));
    expect(onToggleWatch).toHaveBeenCalledWith({ schema: "public", name: "orders" });
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
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={onConnectionChange}
        onOpenQuery={() => {}}
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
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
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
      <ConnectionRail
        connectionId={null}
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
      />,
    );

    expect(await screen.findByText(/select a connection/i)).toBeInTheDocument();
    expect(listTables).not.toHaveBeenCalled();
  });

  it("shows a distinct error when the selected connection fails to load, not the no-connection copy", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockRejectedValue(new Error("connection refused"));

    render(
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
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
      <ConnectionRail
        connectionId={null}
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
      />,
    );

    expect(await screen.findByText(/keychain locked/)).toBeInTheDocument();
    expect(screen.queryByText("Add a connection in Settings to browse a database.")).not.toBeInTheDocument();
    expect(listTables).not.toHaveBeenCalled();
  });

  it("shows the zero-connections empty state once the list has actually loaded and is empty", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);

    render(
      <ConnectionRail
        connectionId={null}
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
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
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={onSelectTable}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
      />,
    );

    await waitFor(() => screen.getByText("orders"));
    const select = screen.getByRole("button", { name: "Browse public.orders" });
    select.focus();
    expect(select).toHaveFocus();
    fireEvent.click(select);
    expect(onSelectTable).toHaveBeenCalledWith({ schema: "public", name: "orders" });
  });

  // Regression: every other test in this file renders with `selected={null}`,
  // so nothing exercised the highlight/aria-current branch at all — including
  // whether it compares full identity rather than just `name`, which is the
  // entire reason `selected` carries a schema now.
  it("marks only the table matching the full selected identity as current", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
      { schema: "alt", name: "orders" },
    ]);

    render(
      <ConnectionRail
        connectionId="c1"
        selected={{ schema: "public", name: "orders" }}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
      />,
    );

    const current = await screen.findByRole("button", { name: "Browse public.orders" });
    const other = screen.getByRole("button", { name: "Browse alt.orders" });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current.closest("div")).toHaveClass("bg-surface-2");
    expect(other).toHaveAttribute("aria-current", "false");
    expect(other.closest("div")).not.toHaveClass("bg-surface-2");
  });

  // Nesting a <button> inside a <button> is invalid HTML and breaks focus.
  it("keeps the watch toggle a sibling of the select button, never nested", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    render(
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        onOpenQuery={() => {}}
      />,
    );
    await waitFor(() => screen.getByText("orders"));
    const watch = screen.getByRole("button", { name: "watch public.orders" });
    expect(watch.querySelector("button")).toBeNull();
    expect(watch.closest("button")).toBe(watch);
  });

  // Parameters<typeof …>[0] rather than React.ComponentProps: this file does
  // not import React, and the new JSX transform does not put it in scope.
  function renderRail(overrides: Partial<Parameters<typeof ConnectionRail>[0]> = {}) {
    return render(
      <ConnectionRail
        connectionId="c1"
        selected={null}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
        onConnectionChange={() => {}}
        initialSegment="tables"
        activeQueryId={null}
        onOpenQuery={() => {}}
        {...overrides}
      />,
    );
  }

  it("shows the tables list on the Tables segment and the queries list on Queries", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([
      { id: "q1", connection_id: "c1", name: "failed orders today", sql: "SELECT 1;", created_at: 1 },
    ]);

    renderRail();
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    expect(screen.queryByText("failed orders today")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Queries" }));

    await waitFor(() => expect(screen.getByText("failed orders today")).toBeInTheDocument());
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
  });

  // §3a: tables are not created from here, so the footer belongs to one
  // segment only.
  it("shows the New query footer on Queries only", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([]);

    renderRail();
    expect(screen.queryByRole("button", { name: "New query" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Queries" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "New query" })).toBeInTheDocument());
  });

  it("opens on the Queries segment when its host tab is a query tab", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([
      { id: "q1", connection_id: "c1", name: "already open", sql: "", created_at: 1 },
    ]);

    renderRail({ initialSegment: "queries", activeQueryId: "q1" });
    await waitFor(() => expect(screen.getByText("already open")).toBeInTheDocument());
  });

  it("asks its host to open the query that was clicked", async () => {
    const onOpenQuery = vi.fn();
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([
      { id: "q1", connection_id: "c1", name: "failed orders", sql: "", created_at: 1 },
    ]);

    renderRail({ initialSegment: "queries", onOpenQuery });
    await waitFor(() => expect(screen.getByText("failed orders")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open query failed orders" }));

    expect(onOpenQuery).toHaveBeenCalledWith("q1");
  });

  it("creates a query, stores it and opens it", async () => {
    const onOpenQuery = vi.fn();
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([]);
    const create = vi.spyOn(tauriLib, "invokeCreateSavedQuery").mockResolvedValue({
      id: "new1", connection_id: "c1", name: "untitled query", sql: "", created_at: 9,
    });

    renderRail({ initialSegment: "queries", onOpenQuery });
    fireEvent.click(await screen.findByRole("button", { name: "New query" }));

    await waitFor(() => expect(onOpenQuery).toHaveBeenCalledWith("new1"));
    expect(create).toHaveBeenCalledWith("c1", "untitled query", "");
    expect(useAppStore.getState().savedQueries.map((q) => q.id)).toContain("new1");
  });

  // "+ New query" with no delete is a list that can only grow, and the
  // default name guarantees it fills with "untitled query".
  it("deletes a query from the store and the database", async () => {
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeListSavedQueries").mockResolvedValue([
      { id: "q1", connection_id: "c1", name: "doomed", sql: "", created_at: 1 },
    ]);
    const del = vi.spyOn(tauriLib, "invokeDeleteSavedQuery").mockResolvedValue(undefined);

    renderRail({ initialSegment: "queries" });
    await waitFor(() => expect(screen.getByText("doomed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete query doomed" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith("q1"));
    expect(useAppStore.getState().savedQueries.find((q) => q.id === "q1")).toBeUndefined();
  });
});
