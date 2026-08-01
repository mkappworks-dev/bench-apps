import type { DbInitError } from "../../lib/tauri";

/** Blocking, full-screen — not a toast a user could miss. Shown in place of
 *  the entire workspace when the local database failed to open. */
export function StartupErrorScreen({ error }: { error: DbInitError }) {
  return (
    <div className="flex h-screen items-center justify-center bg-bg px-6">
      <div className="flex max-w-lg flex-col gap-4">
        <h1 className="text-sm font-semibold text-text">DevBench couldn't start</h1>
        <p className="text-xs text-text-muted">
          DevBench's local database failed to open at{" "}
          <span className="break-all font-mono text-text">{error.db_path}</span>. This usually means the
          file was created by a different branch or version of DevBench whose database migrations don't
          match this one.
        </p>
        <div className="flex flex-col gap-1 text-xs text-text-muted">
          <p className="font-semibold text-text">To fix it, do one of the following:</p>
          <p>Move or rename the file above, then relaunch — DevBench will create a fresh one.</p>
          <p>
            In development, set <span className="font-mono text-text">DEVBENCH_DATA_DIR</span> to point
            this checkout at its own database directory instead of sharing one with other checkouts.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-text">Underlying error</p>
          <pre className="whitespace-pre-wrap break-all rounded-sm bg-danger-bg px-2 py-1 font-mono text-[11px] text-danger">
            {error.error}
          </pre>
        </div>
      </div>
    </div>
  );
}
