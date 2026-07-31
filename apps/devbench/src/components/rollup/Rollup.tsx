import type { EmailSummary, LogLine, TableDiff } from "../../lib/tauri";

export interface RollupData {
  /** `null` = the DB was not verified. `[]` = verified, nothing changed. */
  tableDiffs: TableDiff[] | null;
  watchedTableCount: number;
  /** `null` = no log source configured, so logs were not observed. */
  logLines: LogLine[] | null;
  /** True when the buffer evicted lines belonging to this window. */
  logLinesTruncated: boolean;
  /** `null` = the SMTP catcher is not listening, so mail was not observed. */
  emails: EmailSummary[] | null;
  emailsTruncated: boolean;
  dbError: string | null;
  /** True while the correlation window has not closed yet. */
  windowOpen: boolean;
}

function summarize(diff: TableDiff): string {
  const parts: string[] = [];
  if (diff.inserted > 0) parts.push(`${diff.inserted} inserted`);
  if (diff.updated > 0) parts.push(`${diff.updated} updated`);
  if (diff.deleted > 0) parts.push(`${diff.deleted} deleted`);
  return parts.join(", ");
}

function totalWrites(diffs: TableDiff[]): number {
  return diffs.reduce((n, d) => n + d.inserted + d.updated + d.deleted, 0);
}

/** The table with the most changes — where the DB chip's deep-link lands. */
function busiestTable(diffs: TableDiff[]): string | null {
  let best: TableDiff | null = null;
  for (const d of diffs) {
    const n = d.inserted + d.updated + d.deleted;
    if (!best || n > best.inserted + best.updated + best.deleted) best = d;
  }
  return best?.table ?? null;
}

function Chip({ label, count, onClick }: { label: string; count: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-sm font-semibold text-text hover:bg-surface-2"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-text-faint" aria-hidden="true" />
      {label}
      <span className="font-normal tabular-nums text-text-muted">{count}</span>
      <span className="font-bold text-accent" aria-hidden="true">→</span>
    </button>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-text-faint">{children}</span>;
}

export function Rollup({
  data,
  loading,
  onOpenDb,
  onOpenLog,
  onOpenEmail,
}: {
  data: RollupData | null;
  loading: boolean;
  onOpenDb: (table: string) => void;
  onOpenLog: () => void;
  onOpenEmail: (emailId: number | null) => void;
}) {
  if (loading) {
    return (
      <div data-testid="rollup-loading" className="flex gap-4.5 p-3">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  if (!data) return null;

  const chips: React.ReactNode[] = [];

  // --- DB ---
  if (data.tableDiffs === null && data.dbError) {
    chips.push(
      <span key="db" className="rounded-sm bg-warning-bg px-2 py-1 text-sm font-semibold text-warning">
        ⚠ DB unable to verify — {data.dbError}
      </span>,
    );
  } else if (data.tableDiffs === null) {
    chips.push(<Note key="db">DB: not available for past requests.</Note>);
  } else if (data.watchedTableCount === 0) {
    chips.push(<Note key="db">No tables are being watched — select tables in the DB tab.</Note>);
  } else if (data.tableDiffs.length === 0) {
    chips.push(<Note key="db">DB: no observed effects.</Note>);
  } else {
    const target = busiestTable(data.tableDiffs);
    const writes = totalWrites(data.tableDiffs);
    chips.push(
      <Chip
        key="db"
        label="DB"
        count={`${writes} write${writes === 1 ? "" : "s"}`}
        onClick={() => target && onOpenDb(target)}
      />,
    );
  }

  // --- Log ---
  if (data.windowOpen) {
    chips.push(
      <span key="log" data-testid="rollup-log-pending" className="flex items-center gap-1.5 text-sm text-text-faint">
        <span className="h-3 w-16 animate-pulse rounded bg-surface-2" />
      </span>,
    );
  } else if (data.logLines === null) {
    chips.push(<Note key="log">Log: not observed — no source configured.</Note>);
  } else {
    const n = data.logLines.length;
    chips.push(
      <Chip
        key="log"
        label="Log"
        count={`${n}${data.logLinesTruncated ? "+" : ""} line${n === 1 && !data.logLinesTruncated ? "" : "s"}`}
        onClick={onOpenLog}
      />,
    );
  }

  // --- Email ---
  if (data.windowOpen) {
    chips.push(
      <span key="email" data-testid="rollup-email-pending" className="flex items-center gap-1.5 text-sm text-text-faint">
        <span className="h-3 w-16 animate-pulse rounded bg-surface-2" />
      </span>,
    );
  } else if (data.emails === null) {
    chips.push(<Note key="email">Email: not observed — the SMTP catcher is not running.</Note>);
  } else {
    const n = data.emails.length;
    chips.push(
      <Chip
        key="email"
        label="Email"
        count={`${n}${data.emailsTruncated ? "+" : ""} sent`}
        // Deep-link to the first message in the window when there is one, so
        // the Email tab opens on the mail this request actually caused rather
        // than on whatever happened to be selected.
        onClick={() => onOpenEmail(data.emails && data.emails.length > 0 ? data.emails[0].id : null)}
      />,
    );
  }

  const perTable = data.tableDiffs ?? [];

  return (
    <div className="flex flex-col gap-1.5 p-3">
      <div className="flex flex-wrap items-center gap-4">{chips}</div>
      {perTable.length > 0 ? (
        <div className="flex flex-wrap gap-3 pl-0.5">
          {perTable.map((diff) => (
            <button
              key={diff.table}
              onClick={() => onOpenDb(diff.table)}
              className="text-xs text-text-muted hover:text-text"
            >
              <span className="font-semibold">{diff.table}</span> {summarize(diff)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
