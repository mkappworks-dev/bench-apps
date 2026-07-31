import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpPane } from "./McpPane";
import * as tauriLib from "../../lib/tauri";

const server = { id: "s1", name: "filesystem", command: "npx", args: ["@mcp/server-filesystem"] };

describe("McpPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeAddMcpServer").mockResolvedValue(server);
    vi.spyOn(tauriLib, "invokeRemoveMcpServer").mockResolvedValue(undefined);
  });

  it("shows an empty state explaining what MCP servers are for", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([]);
    render(<McpPane />);
    await waitFor(() => expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument());
  });

  it("lists configured servers with their command", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([server]);
    render(<McpPane />);
    await waitFor(() => expect(screen.getByText("filesystem")).toBeInTheDocument());
    expect(screen.getByText(/npx @mcp\/server-filesystem/)).toBeInTheDocument();
  });

  it("reports a connected server and its tool count", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([server]);
    vi.spyOn(tauriLib, "invokeCheckMcpServer").mockResolvedValue({
      config: server,
      state: "connected",
      error: null,
      tool_count: 4,
    });
    render(<McpPane />);
    await waitFor(() => screen.getByText("filesystem"));
    fireEvent.click(screen.getByRole("button", { name: "Check filesystem" }));
    await waitFor(() => expect(screen.getByText(/connected · 4 tools/i)).toBeInTheDocument());
  });

  it("shows why a server failed rather than just marking it red", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([server]);
    vi.spyOn(tauriLib, "invokeCheckMcpServer").mockResolvedValue({
      config: server,
      state: "error",
      error: "cannot start MCP server `npx`: No such file or directory",
      tool_count: 0,
    });
    render(<McpPane />);
    await waitFor(() => screen.getByText("filesystem"));
    fireEvent.click(screen.getByRole("button", { name: "Check filesystem" }));
    await waitFor(() => expect(screen.getByText(/No such file or directory/)).toBeInTheDocument());
  });

  it("adds a server, splitting the command line into command and args", async () => {
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([]);
    render(<McpPane />);
    await waitFor(() => screen.getByPlaceholderText("filesystem"));
    fireEvent.change(screen.getByPlaceholderText("filesystem"), { target: { value: "fs" } });
    fireEvent.change(screen.getByPlaceholderText("npx @mcp/server-filesystem"), {
      target: { value: "npx @mcp/server-filesystem /tmp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add MCP server" }));
    await waitFor(() =>
      expect(tauriLib.invokeAddMcpServer).toHaveBeenCalledWith("fs", "npx", [
        "@mcp/server-filesystem",
        "/tmp",
      ]),
    );
  });
});
