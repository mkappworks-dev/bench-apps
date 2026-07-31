import { Tabs } from "@base-ui-components/react/tabs";
import type { TabId } from "../../store/useAppStore";

/**
 * Single source of truth for the tool tabs. Adding a fifth tool is one entry
 * here (see the post-v1 roadmap: outbound HTTP inspector, jobs, cache…).
 */
export const TABS: { id: TabId; label: string }[] = [
  { id: "api", label: "API" },
  { id: "db", label: "DB" },
  { id: "log", label: "Log" },
  { id: "email", label: "Email" },
];

/**
 * The app's ONLY Base UI import. Base UI is here for the behaviour a hand-
 * rolled tab bar keeps getting wrong — roving tabindex, arrow-key navigation,
 * correct `tablist`/`tab` wiring — across the three tab bars this plan creates
 * (tools, split-pane tools, settings nav). Keeping the import in one file means
 * dropping the dependency later is a one-file change.
 *
 * Styling is entirely ours: ghosty per DESIGN.md — transparent until hover,
 * hairline border, no blur, `--radius-sm`.
 */
export function ToolTabs({
  value,
  onValueChange,
  children,
}: {
  value: TabId;
  onValueChange: (tab: TabId) => void;
  children?: React.ReactNode;
}) {
  return (
    <Tabs.Root
      value={value}
      onValueChange={(next) => onValueChange(next as TabId)}
      className="flex items-center gap-1 border-b border-border px-2"
    >
      <Tabs.List className="flex gap-1" aria-label="DevBench tools">
        {TABS.map((tab) => (
          <Tabs.Tab
            key={tab.id}
            value={tab.id}
            data-selected={tab.id === value ? "" : undefined}
            className="rounded-sm px-3 py-2 text-sm font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 data-[selected]:bg-surface-2 data-[selected]:text-text"
          >
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {children}
    </Tabs.Root>
  );
}
