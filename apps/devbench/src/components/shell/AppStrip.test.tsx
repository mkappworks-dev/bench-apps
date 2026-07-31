import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppStrip } from "./AppStrip";

const BASE = {
  activeTab: "api" as const,
  secondaryTab: "db" as const,
  splitOpen: false,
  chatOpen: true,
  onActiveTabChange: () => {},
  onSecondaryTabChange: () => {},
  onToggleSplit: () => {},
  onCloseSplit: () => {},
  onToggleChat: () => {},
};

describe("AppStrip", () => {
  it("carries no product wordmark", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.queryByText("DevBench")).not.toBeInTheDocument();
  });

  it("offers no theme control", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.queryByRole("button", { name: /theme/i })).not.toBeInTheDocument();
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

  it("shows one tablist when unsplit and two when split", () => {
    const { rerender } = render(<AppStrip {...BASE} />);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    rerender(<AppStrip {...BASE} splitOpen />);
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });

  it("selects a tool in the primary pane", () => {
    const onActiveTabChange = vi.fn();
    render(<AppStrip {...BASE} onActiveTabChange={onActiveTabChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Log" }));
    expect(onActiveTabChange).toHaveBeenCalledWith("log");
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

  it("closes the split from the secondary group", () => {
    const onCloseSplit = vi.fn();
    render(<AppStrip {...BASE} splitOpen onCloseSplit={onCloseSplit} />);
    fireEvent.click(screen.getByRole("button", { name: /close split/i }));
    expect(onCloseSplit).toHaveBeenCalled();
  });
});
