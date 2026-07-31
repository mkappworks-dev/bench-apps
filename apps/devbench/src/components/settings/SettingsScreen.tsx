import { useState } from "react";
import { Tabs } from "@base-ui-components/react/tabs";
import { GeneralPane } from "./GeneralPane";
import { ProviderPane } from "./ProviderPane";
import { McpPane } from "./McpPane";
import { ArchivePane } from "./ArchivePane";

type PaneId = "general" | "provider" | "mcp" | "archive";

const PANES: { id: PaneId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "provider", label: "Provider" },
  { id: "mcp", label: "MCP" },
  { id: "archive", label: "Archive" },
];

/**
 * A full navigated screen, not an overlay: a 4-section surface does not fit a
 * compact modal, and app-wide config is not scoped to any session the way the
 * four tools are (v1 spec, Components). Because it is persistent rather than
 * transient, it is ghosty — no blur. That is the same DESIGN.md rule the New
 * Session picker satisfies by being glass.
 */
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [pane, setPane] = useState<PaneId>("general");

  return (
    <div className="flex min-h-0 flex-1">
      <Tabs.Root
        value={pane}
        onValueChange={(next) => setPane(next as PaneId)}
        orientation="vertical"
        className="flex min-h-0 flex-1"
      >
        <aside className="flex w-56 min-w-56 flex-col border-r border-border p-1.5">
          <button
            onClick={onBack}
            className="mb-2 rounded-sm p-2 text-left text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
          >
            ← Back to DevBench
          </button>
          <Tabs.List className="flex flex-col gap-0.5" aria-label="Settings sections">
            {PANES.map((p) => (
              <Tabs.Tab
                key={p.id}
                value={p.id}
                // Base UI 1.0.0-rc.0 renamed `[data-selected]` to `[data-active]`
                // on `<Tabs.Tab>` — see ToolTabs.tsx's identical fix (Task 4/6).
                // Without this, the selected-pane highlight is dead CSS.
                data-selected={p.id === pane ? "" : undefined}
                className="rounded-sm p-2 text-left text-sm text-text-muted transition-colors duration-150 hover:bg-surface-2 data-[selected]:bg-surface-2 data-[selected]:text-text"
              >
                {p.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </aside>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Tabs.Panel value="general" className="p-6">
            <GeneralPane />
          </Tabs.Panel>
          <Tabs.Panel value="provider" className="p-6">
            <ProviderPane />
          </Tabs.Panel>
          <Tabs.Panel value="mcp" className="p-6">
            <McpPane />
          </Tabs.Panel>
          <Tabs.Panel value="archive" className="p-6">
            <ArchivePane />
          </Tabs.Panel>
        </div>
      </Tabs.Root>
    </div>
  );
}
