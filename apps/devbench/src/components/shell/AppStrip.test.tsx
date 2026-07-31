import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppStrip } from "./AppStrip";
import type { Tab } from "../../store/useAppStore";

const TWO_LEFT_TABS: Tab[] = [
  { id: "t-api", kind: "api", pane: "left", ordinal: 0, state: {} },
  { id: "t-db", kind: "db", pane: "left", ordinal: 1, state: { table: "orders" } },
];

const BASE = {
  tabs: TWO_LEFT_TABS,
  activeTabId: { left: "t-api", right: null } as { left: string | null; right: string | null },
  chatOpen: true,
  onSetActiveTab: () => {},
  onAddTab: () => {},
  onCloseTab: () => {},
  onToggleSplit: () => false,
  onCloseSplitPane: () => {},
  onToggleChat: () => {},
};

describe("AppStrip", () => {
  it("carries no product wordmark", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.queryByText("DevBench")).not.toBeInTheDocument();
  });

  it("offers no theme control", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.queryByRole("button", { name: /^theme$/i })).not.toBeInTheDocument();
  });

  it("renders one tab per instance, and only one tablist when nothing occupies the right pane", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["API", "DBorders"]);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("shows a second tablist once a tab occupies the right pane", () => {
    const tabs = [...TWO_LEFT_TABS, { id: "t-log", kind: "log" as const, pane: "right" as const, ordinal: 0, state: {} }];
    render(<AppStrip {...BASE} tabs={tabs} activeTabId={{ left: "t-api", right: "t-log" }} />);
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });

  // Spec item 2: "Tab labels disambiguate duplicates. A DB tab renders DB
  // plus its table name in mono as a subtitle."
  it("labels a DB tab with its table as a subtitle", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.getByRole("tab", { name: /DB/ })).toHaveTextContent("orders");
  });

  it("selects a tab on click", () => {
    const onSetActiveTab = vi.fn();
    render(<AppStrip {...BASE} onSetActiveTab={onSetActiveTab} />);
    fireEvent.click(screen.getByRole("tab", { name: /DB/ }));
    expect(onSetActiveTab).toHaveBeenCalledWith("left", "t-db");
  });

  it("closes a tab from its own close button, without also selecting it", () => {
    const onCloseTab = vi.fn();
    const onSetActiveTab = vi.fn();
    render(<AppStrip {...BASE} onCloseTab={onCloseTab} onSetActiveTab={onSetActiveTab} />);
    fireEvent.click(screen.getByRole("button", { name: /close db/i }));
    expect(onCloseTab).toHaveBeenCalledWith("t-db");
    expect(onSetActiveTab).not.toHaveBeenCalled();
  });

  it("adds a tab of the chosen kind to the primary pane via its + menu", () => {
    const onAddTab = vi.fn();
    render(<AppStrip {...BASE} onAddTab={onAddTab} />);
    fireEvent.click(screen.getByRole("button", { name: /add a tool to the primary pane/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Email" }));
    expect(onAddTab).toHaveBeenCalledWith("left", "email");
  });

  // Spec item 2: "Split with one tab open creates a tab rather than emptying
  // a pane... Split instead opens the + menu targeting the right pane."
  it("opens a + menu targeting the right pane when Split declines to move a tab", () => {
    const onToggleSplit = vi.fn(() => false);
    render(<AppStrip {...BASE} tabs={[TWO_LEFT_TABS[0]]} onToggleSplit={onToggleSplit} />);

    fireEvent.click(screen.getByRole("button", { name: /toggle split view/i }));

    expect(onToggleSplit).toHaveBeenCalled();
    expect(screen.getByRole("menu")).toHaveAccessibleName(/secondary pane/i);
  });

  it("adding a tool from the declined-split menu targets the right pane", () => {
    const onAddTab = vi.fn();
    render(<AppStrip {...BASE} tabs={[TWO_LEFT_TABS[0]]} onToggleSplit={() => false} onAddTab={onAddTab} />);

    fireEvent.click(screen.getByRole("button", { name: /toggle split view/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Log" }));

    expect(onAddTab).toHaveBeenCalledWith("right", "log");
  });

  it("does not open a menu when Split successfully moves a tab", () => {
    render(<AppStrip {...BASE} onToggleSplit={() => true} />);
    fireEvent.click(screen.getByRole("button", { name: /toggle split view/i }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Regression: the right pane's Menu must close after a pick even though the
  // real app never unmounts it across this transition — App.tsx's onAddTab
  // both mutates the store AND re-renders AppStrip with the landed tab in the
  // same update, so `splitOpen` (from the new `tabs` prop) picks up right
  // where `pendingSplitAdd` left off and the TabGroup/Menu instance persists.
  // Rerendering from inside the onAddTab callback itself — before AppStrip's
  // own pendingSplitAdd/rightMenuOpen state settles — reproduces that same
  // continuity; rerendering as a separate statement afterward would let the
  // group unmount and remount fresh, masking the bug this test exists for.
  it("closes the declined-split menu after picking a tool, once the real tab lands in the right pane", () => {
    const tabsAfterAdd: Tab[] = [TWO_LEFT_TABS[0], { id: "t-log", kind: "log", pane: "right", ordinal: 0, state: {} }];
    let rerender!: (ui: React.ReactElement) => void;
    const onAddTab = () => {
      rerender(
        <AppStrip
          {...BASE}
          tabs={tabsAfterAdd}
          activeTabId={{ left: "t-api", right: "t-log" }}
          onToggleSplit={() => false}
          onAddTab={onAddTab}
        />,
      );
    };

    ({ rerender } = render(
      <AppStrip {...BASE} tabs={[TWO_LEFT_TABS[0]]} onToggleSplit={() => false} onAddTab={onAddTab} />,
    ));

    fireEvent.click(screen.getByRole("button", { name: /toggle split view/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Log" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Regression: the left pane's TabGroup is unconditionally mounted, even
  // with zero tabs (a fresh session starts empty in both panes) — so its
  // Tabs.Root goes from uncontrolled (activeId null) to controlled (a real
  // tab id) on the very same mounted instance the first time a tab is ever
  // added, not just on the right pane's declined-split path. `aria-selected`
  // — not the component's own `data-selected`, which mirrors the `activeId`
  // prop directly regardless of whether Base UI's internal tracking is
  // actually correct — is Base UI's own computed selection state, so it's
  // what would go stale if this same controlled/uncontrolled hazard hit here.
  it("selects the left pane's first tab, without a Base UI controlled/uncontrolled warning, going from zero tabs to one", () => {
    const { rerender } = render(<AppStrip {...BASE} tabs={[]} activeTabId={{ left: null, right: null }} />);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rerender(<AppStrip {...BASE} tabs={[TWO_LEFT_TABS[0]]} activeTabId={{ left: "t-api", right: null }} />);

    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("controlled"))).toBe(false);
    expect(screen.getByRole("tab", { name: "API" })).toHaveAttribute("aria-selected", "true");

    errorSpy.mockRestore();
  });

  it("closes the split from the secondary group's own close-split button", () => {
    const onCloseSplitPane = vi.fn();
    const tabs = [...TWO_LEFT_TABS, { id: "t-log", kind: "log" as const, pane: "right" as const, ordinal: 0, state: {} }];
    render(<AppStrip {...BASE} tabs={tabs} activeTabId={{ left: "t-api", right: "t-log" }} onCloseSplitPane={onCloseSplitPane} />);
    fireEvent.click(screen.getByRole("button", { name: /close split/i }));
    expect(onCloseSplitPane).toHaveBeenCalled();
  });

  it("mirrors the body grid columns and collapses the chat column when closed", () => {
    const { container, rerender } = render(<AppStrip {...BASE} />);
    expect(container.querySelector("header")!.getAttribute("style")).toContain(
      "grid-template-columns: var(--w-sidebar) 1fr var(--w-chat)",
    );
    rerender(<AppStrip {...BASE} chatOpen={false} />);
    expect(container.querySelector("header")!.getAttribute("style")).toContain(
      "grid-template-columns: var(--w-sidebar) 1fr auto",
    );
  });

  it("toggles the chat dock and reflects its state", () => {
    const onToggleChat = vi.fn();
    const { rerender } = render(<AppStrip {...BASE} onToggleChat={onToggleChat} />);
    const button = screen.getByRole("button", { name: /toggle ai chat/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleChat).toHaveBeenCalled();
    rerender(<AppStrip {...BASE} chatOpen={false} onToggleChat={onToggleChat} />);
    expect(screen.getByRole("button", { name: /toggle ai chat/i })).toHaveAttribute("aria-pressed", "false");
  });
});
