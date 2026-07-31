import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewSessionDialog } from "./NewSessionDialog";

describe("NewSessionDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<NewSessionDialog open={false} onCreate={() => {}} onCancel={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("creates a session with the entered name", () => {
    const onCreate = vi.fn();
    render(<NewSessionDialog open onCreate={onCreate} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Order flow debug"), {
      target: { value: "Checkout API" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onCreate).toHaveBeenCalledWith("Checkout API");
  });

  it("does not create a session with a blank name", () => {
    const onCreate = vi.fn();
    render(<NewSessionDialog open onCreate={onCreate} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<NewSessionDialog open onCreate={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
