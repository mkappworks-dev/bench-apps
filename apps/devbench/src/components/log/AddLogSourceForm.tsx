import { useState } from "react";

export function AddLogSourceForm({
  onSubmit,
  onCancel,
  error,
}: {
  onSubmit: (input: { label: string; path: string }) => void;
  onCancel: () => void;
  error: string | null;
}) {
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");

  function submit() {
    if (!path.trim()) return;
    onSubmit({ label: label.trim(), path: path.trim() });
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border bg-surface p-3">
      <div className="flex gap-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/tmp/devbench.log"
          className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-sm text-text"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="server.log"
          className="w-40 rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text"
        />
        <button onClick={submit} className="rounded-sm bg-accent px-4 text-sm font-bold text-accent-on">
          Add source
        </button>
        <button onClick={onCancel} className="rounded-sm px-3 text-sm text-text-muted hover:bg-surface-2">
          Cancel
        </button>
      </div>
      <div className="text-[11px] text-text-faint">
        DevBench v1 tails regular files. For a process that writes to stdout, run it as{" "}
        <code className="font-mono">yourapp 2&gt;&amp;1 | tee /tmp/devbench.log</code> and point here.
      </div>
      {error ? (
        <div className="rounded-sm bg-danger-bg px-2 py-1 text-xs text-danger">{error}</div>
      ) : null}
    </div>
  );
}
