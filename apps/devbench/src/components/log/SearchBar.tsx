import { LogIcon } from "./LogIcon";

export interface SearchQuery {
  query: string;
  /** Minimum severity; "" means no level constraint. */
  level: string;
  afterMs: number | null;
  beforeMs: number | null;
}

export const SEARCH_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;

const CONTROL_CLASS = "log-control";

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
    <div className="log-search-form">
      <label className="log-field log-search-query">Search text
      <input
        aria-label="Search history"
        value={value.query}
        onChange={(e) => onChange({ ...value, query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        placeholder="Search history…"
        className={CONTROL_CLASS}
      />
      </label>
      <label className="log-field">
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
      <div className="log-search-range">
      <label className="log-field">
        <span>From</span>
        <input
          aria-label="From"
          type="datetime-local"
          value={toLocalInput(value.afterMs)}
          onChange={(e) => onChange({ ...value, afterMs: fromLocalInput(e.target.value) })}
          className={CONTROL_CLASS}
        />
      </label>
      <label className="log-field">
        <span>To</span>
        <input
          aria-label="To"
          type="datetime-local"
          value={toLocalInput(value.beforeMs)}
          onChange={(e) => onChange({ ...value, beforeMs: fromLocalInput(e.target.value) })}
          className={CONTROL_CLASS}
        />
      </label>
      </div>
      <button
        onClick={onSubmit}
        disabled={busy}
        className="log-primary-button"
      >
        <LogIcon name="search" />{busy ? "Searching…" : "Search"}
      </button>
    </div>
  );
}
