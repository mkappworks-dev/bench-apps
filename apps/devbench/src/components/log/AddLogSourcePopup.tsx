import { useState } from "react";
import { Menu } from "../ui/Menu";
import { LogIcon } from "./LogIcon";
import type { AddLogSourceInput } from "../../lib/tauri";

export type AddSourceKind = "file" | "command" | "docker";

export const LOG_SOURCE_OPTIONS = [
  { value: "file", label: "File", description: "Tail a log file", icon: <LogIcon name="file" /> },
  { value: "command", label: "Command", description: "Capture stdout and stderr", icon: <LogIcon name="command" /> },
  { value: "docker", label: "Docker", description: "Follow a container's logs", icon: <LogIcon name="docker" /> },
];

const INPUT_CLASS = "log-control w-full min-w-0";

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
  initialKind,
}: {
  onSubmit: (input: AddLogSourceInput) => void;
  onCancel: () => void;
  error: string | null;
  initialKind?: AddSourceKind;
}) {
  const [kind, setKind] = useState<AddSourceKind | null>(initialKind ?? null);
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
    <form className="log-add-form" aria-label={kind ? `Add ${kind} source` : "Add source"} onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="flex items-center justify-between gap-2">
        {initialKind ? (
          <span className="flex items-center gap-2 text-xs font-semibold text-text-muted">
            <LogIcon name={initialKind} />{KIND_LABELS[initialKind]}
          </span>
        ) : (
          <Menu label="Add log source" options={LOG_SOURCE_OPTIONS} onSelect={(value) => setKind(value as AddSourceKind)}
            triggerClassName="log-ghost-button" trigger={<span>{kind ? KIND_LABELS[kind] : "Choose a kind…"}</span>} />
        )}
        <button type="button" aria-label="Cancel adding source" onClick={onCancel} className="log-icon-button"><LogIcon name="close" /></button>
      </div>
      {kind === "file" ? (
        <label className="log-field">File path
          <input autoFocus aria-label="File path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/tmp/devbench.log" className={`${INPUT_CLASS} font-mono`} />
        </label>
      ) : null}
      {kind === "command" ? (
        <>
          <label className="log-field">Program
            <input autoFocus aria-label="Program" value={program} onChange={(e) => setProgram(e.target.value)} placeholder="npm" className={`${INPUT_CLASS} font-mono`} />
          </label>
          <label className="log-field">Arguments
            <input aria-label="Arguments" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="run dev" className={`${INPUT_CLASS} font-mono`} />
          </label>
          <label className="log-field">Working directory <span className="text-text-faint">(optional)</span>
            <input aria-label="Working directory" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project (optional)" className={`${INPUT_CLASS} font-mono`} />
          </label>
        </>
      ) : null}
      {kind === "docker" ? (
        <label className="log-field">Container name
          <input autoFocus aria-label="Container name" value={container} onChange={(e) => setContainer(e.target.value)} placeholder="my-container" className={`${INPUT_CLASS} font-mono`} />
        </label>
      ) : null}
      {kind ? (
        <>
          <label className="log-field">Label <span className="text-text-faint">(optional)</span>
            <input aria-label="Label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "file" ? "server.log" : kind === "command" ? "web" : "api"} className={INPUT_CLASS} />
          </label>
          <p className="text-[11px] leading-relaxed text-text-muted">{KIND_HINTS[kind]}</p>
          <div className="log-form-actions flex justify-end gap-1.5 pt-1">
            <button type="button" onClick={onCancel} className="log-ghost-button">Cancel</button>
            <button type="submit" className="log-primary-button">Add source</button>
          </div>
        </>
      ) : null}
      {error ? <div role="alert" className="rounded-sm bg-danger-bg px-2 py-1.5 text-xs text-danger">{error}</div> : null}
    </form>
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
