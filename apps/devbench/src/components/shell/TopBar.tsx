import type { ThemePref } from "../../store/useAppStore";

/**
 * The product mark: one origin node fanning into three connected nodes —
 * one request, three observed effects (DB / Log / Email). DESIGN.md picks this
 * over a letter-in-a-rounded-square precisely because it encodes the mechanic.
 */
function BrandMark() {
  return (
    <span aria-hidden="true" className="text-text">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
        <circle cx="12" cy="5" r="2" fill="currentColor" />
        <circle cx="5" cy="19" r="2" fill="currentColor" />
        <circle cx="12" cy="19" r="2" fill="currentColor" />
        <circle cx="19" cy="19" r="2" fill="currentColor" />
        <path
          d="M12 7v5M12 12L5 17M12 12v5M12 12l7 5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

const THEME_LABEL: Record<ThemePref, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

export function TopBar({
  chatOpen,
  theme,
  onToggleChat,
  onCycleTheme,
}: {
  chatOpen: boolean;
  theme: ThemePref;
  onToggleChat: () => void;
  onCycleTheme: () => void;
}) {
  return (
    // Ghosty: transparent, hairline division, no blur (DESIGN.md).
    <header className="flex h-13 shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2">
        <BrandMark />
        <span className="font-bold text-text">DevBench</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          aria-label={`Theme: ${THEME_LABEL[theme]}`}
          onClick={onCycleTheme}
          className="rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          {THEME_LABEL[theme]}
        </button>
        <button
          aria-label="Toggle AI chat"
          aria-pressed={chatOpen}
          onClick={onToggleChat}
          className="rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text aria-pressed:text-text"
        >
          Chat
        </button>
      </div>
    </header>
  );
}
