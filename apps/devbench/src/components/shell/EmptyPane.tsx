import { Menu } from "../ui/Menu";
import { TABS } from "./tools";
import type { ToolKind } from "../../store/useAppStore";

const ADD_OPTIONS = TABS.map((t) => ({ value: t.id, label: t.label }));

/** Shown when the active session (or the scratch workspace) has no tabs
 *  open. New sessions start genuinely empty — nothing is seeded. */
export function EmptyPane({ onAddTab }: { onAddTab: (kind: ToolKind) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="text-sm font-semibold text-text">No tools open</div>
      <p className="max-w-70 text-xs text-text-faint">
        Add a tool to get started. Duplicates are allowed — open two DB tabs to compare tables side by side.
      </p>
      <Menu
        label="Add a tool"
        options={ADD_OPTIONS}
        onSelect={(kind) => onAddTab(kind as ToolKind)}
        trigger="Add a tool"
        triggerClassName="rounded-sm border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text transition-colors duration-150 hover:bg-surface-2"
      />
    </div>
  );
}
