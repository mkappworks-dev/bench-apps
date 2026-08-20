import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryTab } from "./QueryTab";
import * as tauriLib from "../../lib/tauri";
import { useAppStore, type Tab } from "../../store/useAppStore";

const QUERY_TAB: Tab = {
  id: "t-q",
  kind: "query",
  pane: "left",
  ordinal: 0,
  state: { queryId: "q1", connectionId: "c1" },
};

describe("QueryTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({
      route: "workspace",
      settingsPane: "general",
      activeConnectionId: "c1",
      savedQueries: [{ id: "q1", connection_id: "c1", name: "failed orders today", sql: "", created_at: 1 }],
    });
  });

  function renderTab() {
    return render(
      <QueryTab tab={QUERY_TAB} onOpenQuery={() => {}} watchedTables={new Set()} onToggleWatch={() => {}} />,
    );
  }

  // The other branch of the head's name. A restored tab renders before the
  // rail's fetch has repopulated `savedQueries`, so the miss is a normal
  // moment in the tab's life, not a broken state.
  it("heads the pane with a fallback while its query row is not loaded yet", () => {
    useAppStore.setState({ savedQueries: [] });
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);

    renderTab();

    expect(screen.getByText("untitled query")).toBeInTheDocument();
  });

  // The rail is a browser; the tab is a document. Moving the picker browses
  // another connection, and the tab stays pinned to the one it was opened
  // against — so the rail follows the store, not `tab.state.connectionId`.
  // The name still resolves across the move because `mergeSavedQueries` merges
  // into one global list rather than replacing it per connection.
  it("browses the store's active connection, not the one its query is pinned to", async () => {
    useAppStore.setState({ activeConnectionId: "c2" });
    vi.spyOn(tauriLib, "invokeListConnections").mockResolvedValue([]);
    const listTables = vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([]);

    renderTab();

    await waitFor(() => expect(listTables).toHaveBeenCalledWith("c2"));
    expect(listTables).not.toHaveBeenCalledWith("c1");
    expect(screen.getByText("failed orders today")).toBeInTheDocument();
  });
});
