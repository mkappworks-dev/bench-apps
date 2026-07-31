import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SchemaTree } from "./SchemaTree";
import * as tauriLib from "../../lib/tauri";

const connection = { host: "localhost", port: 5432, database: "d", username: "u", password: "p" };

describe("SchemaTree", () => {
  it("lists tables and toggles watch state", async () => {
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    const onToggleWatch = vi.fn();

    render(
      <SchemaTree
        connection={connection}
        watchedTables={new Set()}
        onToggleWatch={onToggleWatch}
        onSelectTable={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /watch orders/i }));
    expect(onToggleWatch).toHaveBeenCalledWith("orders");
  });

  it("exposes each table as a keyboard-reachable button, not a clickable div", async () => {
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    const onSelectTable = vi.fn();

    render(
      <SchemaTree
        connection={connection}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={onSelectTable}
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
    vi.spyOn(tauriLib, "invokeDbConnectAndListTables").mockResolvedValue([
      { schema: "public", name: "orders" },
    ]);
    render(
      <SchemaTree
        connection={connection}
        watchedTables={new Set()}
        onToggleWatch={() => {}}
        onSelectTable={() => {}}
      />,
    );
    await waitFor(() => screen.getByText("orders"));
    const watch = screen.getByRole("button", { name: "watch orders" });
    expect(watch.querySelector("button")).toBeNull();
    expect(watch.closest("button")).toBe(watch);
  });
});
