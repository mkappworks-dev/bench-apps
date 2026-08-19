import { useState } from "react";
import { Menu } from "../ui/Menu";
import type { AddLogSourceInput } from "../../lib/tauri";

export type AddSourceKind = "file" | "command" | "docker";

const KIND_OPTIONS = [
  { value: "file", label: "File", description: "Tail a log file this app can read" },
  { value: "command", label: "Command", description: "Run a program and capture its output" },
  { value: "docker", label: "Docker", description: "Follow a container's logs" },
];

const INPUT_CLASS = "rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text";

/** Splits a whitespace-separated argument string, keeping double-quoted
 *  groups intact. Args are passed to the process directly (no shell), so this
 *  is only about letting one argument contain spaces. */
export function parseArgs(raw: string): string[] {
  const matches = raw.match(/"[^"]*"|\S+/g);
  if (!matches) return [];
  return matches.map((token) =>
    token.startsWith('"') && token.endsWith('"') && token.length >= 2 ? token.slice(1, -1) : token,
  );
}

export function AddLogSourcePopup({
  onSubmit,
  onCancel,
  error,
}: {
  onSubmit: (input: AddLogSourceInput) => void;
  onCancel: () => void;
  error: string | null;
}) {
  const [kind, setKind] = useState<AddSourceKind | null>(null);
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [container, setContainer] = useState("");

  function submit() {
    const trimmedLabel = label.trim();
    if (kind === "file") {
      if (!path.trim()) return;
      onSubmit({ label: trimmedLabel, kind: "file", path: path.trim() });
    } else if (kind === "command") {
      if (!program.trim()) return;
      onSubmit({
        label: trimmedLabel,
        kind: "command",
        program: program.trim(),
        args: parseArgs(args),
        cwd: cwd.trim() || undefined,
      });
    } else if (kind === "docker") {
      const name = container.trim();
      if (!name) return;
      // Docker is a preset, not a backend kind — it fills in a Command source.
      onSubmit({
        label: trimmedLabel || name,
        kind: "command",
        program: "docker",
        args: ["logs", "-f", name],
        cwd: undefined,
      });
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <Menu
          label="Add log source"
          options={KIND_OPTIONS}
          onSelect={(value) => setKind(value as AddSourceKind)}
          triggerClassName="rounded-sm border border-border bg-bg px-2.5 py-1.5 text-sm text-text-muted hover:bg-surface-2"
          trigger={<span>{kind ? KIND_LABELS[kind] : "Choose a kind…"}</span>}
        />
        {kind ? <span className="text-xs text-text-faint">{KIND_HINTS[kind]}</span> : null}
      </div>

      {kind === "file" ? (
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/tmp/devbench.log"
            className={`flex-1 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="server.log"
            className={`w-40 ${INPUT_CLASS}`}
          />
        </div>
      ) : null}

      {kind === "command" ? (
        <div className="flex gap-2">
          <input
            value={program}
            onChange={(e) => setProgram(e.target.value)}
            placeholder="npm"
            className={`w-32 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="run dev"
            className={`flex-1 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project (optional)"
            className={`w-56 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="web"
            className={`w-32 ${INPUT_CLASS}`}
          />
        </div>
      ) : null}

      {kind === "docker" ? (
        <div className="flex gap-2">
          <input
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            placeholder="my-container"
            className={`flex-1 font-mono ${INPUT_CLASS}`}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="api"
            className={`w-32 ${INPUT_CLASS}`}
          />
        </div>
      ) : null}

      {kind ? (
        <div className="flex gap-2">
          <button onClick={submit} className="rounded-sm bg-accent px-4 py-1.5 text-sm font-bold text-accent-on">
            Add source
          </button>
          <button onClick={onCancel} className="rounded-sm px-3 text-sm text-text-muted hover:bg-surface-2">
            Cancel
          </button>
        </div>
      ) : null}

      {error ? <div className="rounded-sm bg-danger-bg px-2 py-1 text-xs text-danger">{error}</div> : null}
    </div>
  );
}

const KIND_LABELS: Record<AddSourceKind, string> = {
  file: "File",
  command: "Command",
  docker: "Docker",
};

const KIND_HINTS: Record<AddSourceKind, string> = {
  file: "DevBench tails the file; it is never written to.",
  command: "DevBench runs the program and captures stdout and stderr. No shell is involved.",
  docker: "Runs `docker logs -f <container>`.",
};
