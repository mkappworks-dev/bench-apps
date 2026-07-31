import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { SplitContent } from "./SplitContent";
import { useAppStore } from "../../store/useAppStore";

function renderSplit() {
  return render(
    <SplitContent
      dbFocusTable={null}
      emailFocusId={null}
      onOpenTableInDb={() => {}}
      onOpenEmail={() => {}}
    />,
  );
}

describe("SplitContent", () => {
  beforeEach(() => {
    useAppStore.getState().setSplitOpen(false);
    useAppStore.getState().setActiveTab("api");
    useAppStore.getState().setSecondaryTab("db");
  });

  it("shows one tab bar when not split", () => {
    renderSplit();
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("opens a second, independently-tabbed pane", () => {
    renderSplit();
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(useAppStore.getState().splitOpen).toBe(true);
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });

  it("keeps the two panes' tools independent", () => {
    useAppStore.getState().setSplitOpen(true);
    renderSplit();
    const [primary, secondary] = screen.getAllByRole("tablist");
    fireEvent.click(within(secondary).getByRole("tab", { name: "Log" }));
    expect(useAppStore.getState().secondaryTab).toBe("log");
    expect(useAppStore.getState().activeTab).toBe("api");
    expect(within(primary).getByRole("tab", { name: "API" })).toHaveAttribute("data-selected");
  });

  it("closes the split", () => {
    useAppStore.getState().setSplitOpen(true);
    renderSplit();
    fireEvent.click(screen.getByRole("button", { name: "Close split" }));
    expect(useAppStore.getState().splitOpen).toBe(false);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });
});
