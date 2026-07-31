import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

describe("TopBar", () => {
  it("shows the product identity", () => {
    render(<TopBar chatOpen theme="dark" onToggleChat={() => {}} onCycleTheme={() => {}} />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
  });

  it("toggles the chat dock and reflects its state", () => {
    const onToggleChat = vi.fn();
    const { rerender } = render(
      <TopBar chatOpen theme="dark" onToggleChat={onToggleChat} onCycleTheme={() => {}} />,
    );
    const button = screen.getByRole("button", { name: /toggle ai chat/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleChat).toHaveBeenCalled();

    rerender(<TopBar chatOpen={false} theme="dark" onToggleChat={onToggleChat} onCycleTheme={() => {}} />);
    expect(screen.getByRole("button", { name: /toggle ai chat/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("cycles the theme", () => {
    const onCycleTheme = vi.fn();
    render(<TopBar chatOpen theme="light" onToggleChat={() => {}} onCycleTheme={onCycleTheme} />);
    fireEvent.click(screen.getByRole("button", { name: /theme/i }));
    expect(onCycleTheme).toHaveBeenCalled();
  });

  // DESIGN.md: the topbar carries identity and app-wide actions only. Settings
  // is entered from the sessions sidebar, deliberately, to avoid two ways in.
  it("does not offer a settings entry point", () => {
    render(<TopBar chatOpen theme="dark" onToggleChat={() => {}} onCycleTheme={() => {}} />);
    expect(screen.queryByRole("button", { name: /settings/i })).not.toBeInTheDocument();
  });
});
