export const LIVE_LEVELS = ["INFO", "WARN", "ERROR"] as const;

/** Live mode's level filter: an exact multi-select, not a threshold. Nothing
 *  selected means "no level constraint" rather than "match nothing". */
export function LevelChips({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (level: string) => void;
}) {
  return (
    <div className="log-level-chips" role="group" aria-label="Filter by log level">
      {LIVE_LEVELS.map((level) => {
        const on = selected.includes(level);
        return (
          <button
            key={level}
            onClick={() => onToggle(level)}
            aria-pressed={on}
            className="log-level-chip"
            data-level={level}
          >
            {level}
          </button>
        );
      })}
    </div>
  );
}
