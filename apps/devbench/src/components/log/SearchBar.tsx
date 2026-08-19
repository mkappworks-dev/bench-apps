export interface SearchQuery {
  query: string;
  /** Minimum severity; "" means no level constraint. */
  level: string;
  afterMs: number | null;
  beforeMs: number | null;
}

export const SEARCH_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;

const CONTROL_CLASS = "rounded-sm border border-border bg-bg px-2.5 py-1.5 text-sm text-text";

/** `1754121600000` -> `2026-08-02T10:00`, the format `datetime-local` wants. */
function toLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: SearchQuery;
  onChange: (next: SearchQuery) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-2.5">
      <input
        value={value.query}
        onChange={(e) => onChange({ ...value, query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        placeholder="Search history…"
        className={`min-w-40 flex-1 ${CONTROL_CLASS}`}
      />
      <label className="flex items-center gap-1.5 text-xs text-text-muted">
        <span>Level</span>
        <select
          aria-label="Minimum level"
          value={value.level}
          onChange={(e) => onChange({ ...value, level: e.target.value })}
          className={CONTROL_CLASS}
        >
          <option value="">Any level</option>
          {SEARCH_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level} and above
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-text-muted">
        <span>From</span>
        <input
          aria-label="From"
          type="datetime-local"
          value={toLocalInput(value.afterMs)}
          onChange={(e) => onChange({ ...value, afterMs: fromLocalInput(e.target.value) })}
          className={CONTROL_CLASS}
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-text-muted">
        <span>To</span>
        <input
          aria-label="To"
          type="datetime-local"
          value={toLocalInput(value.beforeMs)}
          onChange={(e) => onChange({ ...value, beforeMs: fromLocalInput(e.target.value) })}
          className={CONTROL_CLASS}
        />
      </label>
      <button
        onClick={onSubmit}
        disabled={busy}
        className="rounded-sm bg-accent px-4 py-1.5 text-sm font-bold text-accent-on disabled:opacity-60"
      >
        {busy ? "Searching…" : "Search"}
      </button>
    </div>
  );
}
