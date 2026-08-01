import { useState } from "react";
import { Tabs } from "../ui/Tabs";
import { Menu } from "../ui/Menu";
import { TABS, TOOL_MENU_OPTIONS } from "./tools";
import { isSplitOpen, type Pane, type Tab, type ToolKind } from "../../store/useAppStore";

export function AppStrip({
  tabs,
  activeTabId,
  chatOpen,
  onSetActiveTab,
  onAddTab,
  onCloseTab,
  onToggleSplit,
  onCloseSplitPane,
  onToggleChat,
}: {
  tabs: Tab[];
  activeTabId: { left: string | null; right: string | null };
  chatOpen: boolean;
  onSetActiveTab: (pane: Pane, id: string) => void;
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onCloseTab: (id: string) => void;
  onToggleSplit: () => boolean;
  onCloseSplitPane: () => void;
  onToggleChat: () => void;
}) {
  const splitOpen = isSplitOpen(tabs);
  // Split, declined: no right-pane tab exists to anchor a menu near, so the
  // right TabGroup renders early (bare, its + already open) to serve as its
  // own anchor. Picking a tool — or dismissing — clears this back to false;
  // `splitOpen` itself is untouched, since no tab has actually moved yet.
  const [pendingSplitAdd, setPendingSplitAdd] = useState(false);
  // Always a defined boolean, never `undefined`, once this exists — Base UI's
  // Menu.Root cannot switch from controlled back to uncontrolled on the same
  // mounted instance, and the right pane's TabGroup can stay mounted across
  // the phantom-group-to-real-tab transition (a real tab landing while this
  // menu is still open, hopping straight from `pendingSplitAdd` to `splitOpen`
  // with no unmount in between).
  const [rightMenuOpen, setRightMenuOpen] = useState(false);
  const showRightGroup = splitOpen || pendingSplitAdd;

  function handleToggleSplit() {
    const moved = onToggleSplit();
    if (!moved) {
      setPendingSplitAdd(true);
      setRightMenuOpen(true);
    }
  }

  return (
    <header
      data-tauri-drag-region="deep"
      style={{ gridTemplateColumns: `var(--w-sidebar) 1fr ${chatOpen ? "var(--w-chat)" : "auto"}` }}
      className="grid h-11 shrink-0 border-b border-border"
    >
      <div aria-hidden="true" data-tauri-drag-region />

      <div className="flex min-w-0">
        <TabGroup
          pane="left"
          label="Primary pane tools"
          tabs={tabs}
          activeId={activeTabId.left}
          onSetActiveTab={onSetActiveTab}
          onAddTab={onAddTab}
          onCloseTab={onCloseTab}
        />
        {showRightGroup ? (
          <TabGroup
            pane="right"
            label="Secondary pane tools"
            tabs={tabs}
            activeId={activeTabId.right}
            onSetActiveTab={onSetActiveTab}
            onAddTab={(pane, kind) => {
              onAddTab(pane, kind);
              setPendingSplitAdd(false);
              setRightMenuOpen(false);
            }}
            onCloseTab={onCloseTab}
            className="border-l border-border"
            menuOpen={rightMenuOpen}
            onMenuOpenChange={(open) => {
              setRightMenuOpen(open);
              if (!open) setPendingSplitAdd(false);
            }}
            trailing={
              splitOpen ? (
                <button
                  aria-label="Close split"
                  onClick={onCloseSplitPane}
                  className="ml-auto grid size-7 shrink-0 place-items-center rounded-sm text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
                >
                  <CloseIcon />
                </button>
              ) : null
            }
          />
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-0.5 px-2.5">
        <button aria-label="Toggle split view" aria-pressed={splitOpen} onClick={handleToggleSplit} className={ACTION_CLASS}>
          <SplitIcon />
          <span>Split</span>
        </button>
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        <button aria-label="Toggle AI chat" aria-pressed={chatOpen} onClick={onToggleChat} className={ACTION_CLASS}>
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

function tabLabel(tab: Tab): React.ReactNode {
  const meta = TABS.find((t) => t.id === tab.kind);
  const base = meta?.label ?? tab.kind;
  const subtitle = tab.kind === "db" && typeof tab.state.table === "string" ? tab.state.table : null;
  return (
    <span className="flex items-center gap-1.5">
      {meta ? (
        <span aria-hidden="true" className="shrink-0 text-text-faint">
          {meta.icon}
        </span>
      ) : null}
      <span className="flex flex-col items-start leading-tight">
        <span>{base}</span>
        {subtitle ? <span className="font-mono text-[10px] text-text-faint">{subtitle}</span> : null}
      </span>
    </span>
  );
}

function tabCloseName(tab: Tab): string {
  const base = TABS.find((t) => t.id === tab.kind)?.label ?? tab.kind;
  return typeof tab.state.table === "string" ? `${base} ${tab.state.table}` : base;
}

function TabGroup({
  pane,
  tabs,
  activeId,
  onSetActiveTab,
  onAddTab,
  onCloseTab,
  label,
  className = "",
  trailing,
  menuOpen,
  onMenuOpenChange,
}: {
  pane: Pane;
  tabs: Tab[];
  activeId: string | null;
  onSetActiveTab: (pane: Pane, id: string) => void;
  onAddTab: (pane: Pane, kind: ToolKind) => void;
  onCloseTab: (id: string) => void;
  label: string;
  className?: string;
  trailing?: React.ReactNode;
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const paneTabs = tabs.filter((t) => t.pane === pane).sort((a, b) => a.ordinal - b.ordinal);

  return (
    <Tabs.Root
      // Always a defined string, never `undefined` — Base UI's Tabs.Root has
      // the same controlled/uncontrolled-switch hazard Menu.Root did (see the
      // fix above). Both panes' TabGroup stay mounted across an empty-to-non-
      // empty transition (a fresh session starts with zero tabs in both
      // panes), so this must hold from first render, not just for the right
      // pane's declined-split path. "" is a safe sentinel: real tab ids are
      // UUIDs, so no Tabs.Tab ever has value="".
      value={activeId ?? ""}
      onValueChange={(next) => onSetActiveTab(pane, String(next))}
      className={`flex min-w-0 flex-1 items-center gap-0.5 px-2 ${className}`}
    >
      <Tabs.List className="flex min-w-0 items-center gap-0.5 overflow-x-auto" aria-label={label}>
        {paneTabs.map((tab) => (
          // A sibling close button, not a child of Tabs.Tab: Tabs.Tab renders
          // a <button>, and a nested <button> is invalid HTML and breaks
          // click targeting. Same shape SessionsSidebar already uses for its
          // per-row archive button.
          <div key={tab.id} className="group flex shrink-0 items-center">
            <Tabs.Tab
              value={tab.id}
              data-selected={tab.id === activeId ? "" : undefined}
              className="shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 data-selected:bg-surface-2 data-selected:font-semibold data-selected:text-text"
            >
              {tabLabel(tab)}
            </Tabs.Tab>
            <button
              aria-label={`Close ${tabCloseName(tab)}`}
              onClick={() => onCloseTab(tab.id)}
              className="-ml-1 grid size-5 shrink-0 place-items-center rounded-sm text-text-faint opacity-0 transition-opacity duration-150 hover:bg-surface-2 hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </Tabs.List>
      <Menu
        label={`Add a tool to the ${pane === "left" ? "primary" : "secondary"} pane`}
        options={TOOL_MENU_OPTIONS}
        onSelect={(kind) => onAddTab(pane, kind as ToolKind)}
        trigger={<PlusIcon />}
        triggerClassName="grid size-7 shrink-0 place-items-center rounded-sm text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
      />
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
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
