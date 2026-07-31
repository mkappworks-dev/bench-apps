import { useCallback, useEffect, useState } from "react";
import {
  invokeAddMcpServer,
  invokeCheckMcpServer,
  invokeListMcpServers,
  invokeRemoveMcpServer,
  type McpServerConfig,
  type McpServerStatus,
} from "../../lib/tauri";

export function McpPane() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setServers(await invokeListMcpServers());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add() {
    setError(null);
    // A single command-line field is what a developer already has in their
    // notes; splitting it here beats making them fill in a JSON array.
    const parts = commandLine.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      setError("Enter the command that starts the server.");
      return;
    }
    try {
      await invokeAddMcpServer(name, parts[0], parts.slice(1));
      setName("");
      setCommandLine("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function check(id: string) {
    try {
      const status = await invokeCheckMcpServer(id);
      setStatuses((prev) => ({ ...prev, [id]: status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(id: string) {
    await invokeRemoveMcpServer(id).catch(() => {});
    await refresh();
  }

  return (
    <div className="max-w-160">
      <h2 className="text-lg font-bold text-text">MCP Servers</h2>
      <p className="mt-1 text-sm text-text-muted">Tools the AI assistant can call during a chat.</p>

      <div className="mt-6 flex flex-col gap-2">
        {servers.length === 0 ? (
          <div className="rounded-lg border border-border p-4 text-sm text-text-faint">
            No MCP servers configured. Add one to let the assistant call external tools during a chat.
          </div>
        ) : (
          servers.map((s) => {
            const status = statuses[s.id];
            return (
              <div key={s.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text">{s.name}</div>
                    <div className="truncate font-mono text-xs text-text-muted">
                      {[s.command, ...s.args].join(" ")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {status ? (
                      <span
                        className={`rounded-sm px-2 py-0.5 text-[11px] font-semibold ${
                          status.state === "connected"
                            ? "bg-success-bg text-success"
                            : "bg-danger-bg text-danger"
                        }`}
                      >
                        {status.state === "connected"
                          ? `Connected · ${status.tool_count} tools`
                          : "Error"}
                      </span>
                    ) : (
                      <span className="text-[11px] text-text-faint">Unchecked</span>
                    )}
                    <button
                      aria-label={`Check ${s.name}`}
                      onClick={() => void check(s.id)}
                      className="rounded-sm px-2 py-1 text-xs text-text-muted hover:bg-surface-2"
                    >
                      Check
                    </button>
                    <button
                      aria-label={`Remove ${s.name}`}
                      onClick={() => void remove(s.id)}
                      className="rounded-sm px-2 py-1 text-xs text-text-faint hover:bg-surface-2 hover:text-text"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {status?.error ? (
                  <div className="mt-2 rounded-sm bg-danger-bg px-2 py-1 font-mono text-[11px] text-danger">
                    {status.error}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <section className="mt-4 rounded-lg border border-border p-4">
        <div className="text-sm font-semibold text-text">Add a server</div>
        <div className="mt-2 flex flex-col gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="filesystem"
            aria-label="Server name"
            className="rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text"
          />
          <input
            value={commandLine}
            onChange={(e) => setCommandLine(e.target.value)}
            placeholder="npx @mcp/server-filesystem"
            aria-label="Command"
            className="rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-sm text-text"
          />
          <button
            onClick={() => void add()}
            className="self-start rounded-sm bg-accent px-3 py-2 text-sm font-bold text-accent-on"
          >
            Add MCP server
          </button>
        </div>
        <div className="mt-2 text-[11px] text-text-faint">
          DevBench starts this command and speaks MCP over its stdin/stdout. Credentials come from the
          command’s own environment — DevBench never stores them.
        </div>
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </section>
    </div>
  );
}
