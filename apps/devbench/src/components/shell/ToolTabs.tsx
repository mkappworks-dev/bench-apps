import { Tabs } from "../ui/Tabs";
import { TABS } from "./tools";
import type { TabId } from "../../store/useAppStore";

// Base UI via ../ui/Tabs; see that file for the confinement strategy.
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
