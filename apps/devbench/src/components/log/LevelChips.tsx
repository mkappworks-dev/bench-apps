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
    <div className="flex gap-1">
      {LIVE_LEVELS.map((level) => {
        const on = selected.includes(level);
        return (
          <button
            key={level}
            onClick={() => onToggle(level)}
            aria-pressed={on}
            className={`rounded-sm px-2 py-1 text-[11px] font-bold ${
              on ? "bg-surface-2 text-text" : "text-text-faint hover:bg-surface-2"
            }`}
          >
            {level}
          </button>
        );
      })}
    </div>
  );
}
