import { Tabs } from "../ui/Tabs";
import { TABS } from "./tools";
import type { TabId } from "../../store/useAppStore";

// Grid columns mirror the body's so each tab group sits above the pane it controls.
export function AppStrip({
  activeTab,
  secondaryTab,
  splitOpen,
  chatOpen,
  onActiveTabChange,
  onSecondaryTabChange,
  onToggleSplit,
  onCloseSplit,
  onToggleChat,
}: {
  activeTab: TabId;
  secondaryTab: TabId;
  splitOpen: boolean;
  chatOpen: boolean;
  onActiveTabChange: (tab: TabId) => void;
  onSecondaryTabChange: (tab: TabId) => void;
  onToggleSplit: () => void;
  onCloseSplit: () => void;
  onToggleChat: () => void;
}) {
  return (
    <header
      // "deep" makes the whole subtree draggable (not just this element itself),
      // while still treating interactive descendants (buttons, tabs) as non-draggable.
      data-tauri-drag-region="deep"
      // Grid columns use inline style, not Tailwind class, to allow var() in template.
      style={{ gridTemplateColumns: `var(--w-sidebar) 1fr ${chatOpen ? "var(--w-chat)" : "auto"}` }}
      className="grid h-11 shrink-0 border-b border-border"
    >
      <div aria-hidden="true" data-tauri-drag-region />

      <div className="flex min-w-0">
        <TabGroup value={activeTab} onValueChange={onActiveTabChange} label="Primary pane tools" />
        {splitOpen ? (
          <TabGroup
            value={secondaryTab}
            onValueChange={onSecondaryTabChange}
            label="Secondary pane tools"
            className="border-l border-border"
            trailing={
              <button
                aria-label="Close split"
                onClick={onCloseSplit}
                className="ml-auto grid size-7 shrink-0 place-items-center rounded-sm text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
              >
                <CloseIcon />
              </button>
            }
          />
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-0.5 px-2.5">
        <button
          aria-label="Toggle split view"
          aria-pressed={splitOpen}
          onClick={onToggleSplit}
          className={ACTION_CLASS}
        >
          <SplitIcon />
          <span>Split</span>
        </button>
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        <button
          aria-label="Toggle AI chat"
          aria-pressed={chatOpen}
          onClick={onToggleChat}
          className={ACTION_CLASS}
        >
          <ChatIcon />
          <span>Chat</span>
        </button>
      </div>
    </header>
  );
}

const ACTION_CLASS =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-text-muted " +
  "transition-colors duration-150 hover:bg-surface-2 hover:text-text " +
  "aria-pressed:bg-surface-2 aria-pressed:text-text";

function TabGroup({
  value,
  onValueChange,
  label,
  className = "",
  trailing,
}: {
  value: TabId;
  onValueChange: (tab: TabId) => void;
  label: string;
  className?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <Tabs.Root
      value={value}
      onValueChange={(next) => onValueChange(next as TabId)}
      className={`flex min-w-0 flex-1 items-center gap-0.5 px-2 ${className}`}
    >
      <Tabs.List className="flex min-w-0 gap-0.5 overflow-x-auto" aria-label={label}>
        {TABS.map((tab) => (
          <Tabs.Tab
            key={tab.id}
            value={tab.id}
            // Base UI renders selection state; this data-selected powers the styling.
            data-selected={tab.id === value ? "" : undefined}
            className="shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 data-[selected]:bg-surface-2 data-[selected]:font-semibold data-[selected]:text-text"
          >
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {trailing}
    </Tabs.Root>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
