import { Menu, ChevronIcon } from "../ui/Menu";
import { useAppStore, type ThemePref } from "../../store/useAppStore";
import { invokeSetSetting } from "../../lib/tauri";

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

// Applying the theme is App.tsx's data-theme effect; this pane only sets and persists the value.
export function AppearancePane() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  function choose(next: string) {
    setTheme(next as ThemePref);
    void invokeSetSetting("theme", next).catch(() => {});
  }

  const current = THEMES.find((t) => t.value === theme) ?? THEMES[1];

  return (
    <div className="max-w-2xl">
      <h2 className="text-base font-bold text-text">Appearance</h2>
      <p className="mb-4 text-xs text-text-faint">Applies to every session.</p>

      <div className="flex items-start justify-between gap-6 border-b border-border py-4">
        <div>
          <div className="text-sm font-semibold text-text">Theme</div>
          <p className="mt-0.5 max-w-[42ch] text-xs text-text-faint">
            Dark is the authored default. “System” follows your OS setting.
          </p>
        </div>
        <Menu
          label="Theme"
          options={THEMES}
          value={theme}
          onSelect={choose}
          align="end"
          trigger={<>{current.label}<ChevronIcon /></>}
          triggerClassName="flex h-9 w-40 shrink-0 items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 text-sm text-text transition-colors duration-150 hover:border-text-faint hover:bg-surface-2"
        />
      </div>
    </div>
  );
}
