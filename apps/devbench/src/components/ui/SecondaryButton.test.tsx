import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecondaryButton } from "./SecondaryButton";

describe("SecondaryButton", () => {
  it("renders its label and fires onClick", () => {
    const onClick = vi.fn();
    render(<SecondaryButton onClick={onClick}>Cancel</SecondaryButton>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClick).toHaveBeenCalled();
  });

  // The border is what distinguishes it from the ghost buttons already in the
  // chrome; losing it would make it indistinguishable from a plain text button.
  it("carries the ghost border and fill", () => {
    render(<SecondaryButton>Cancel</SecondaryButton>);
    expect(screen.getByRole("button")).toHaveClass("border-btn-ghost-border", "bg-btn-ghost-bg");
  });

  it("passes through native button props", () => {
    render(<SecondaryButton disabled aria-pressed>Discard</SecondaryButton>);
    const button = screen.getByRole("button", { name: "Discard" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("appends caller classes rather than replacing its own", () => {
    render(<SecondaryButton className="w-13">Cancel</SecondaryButton>);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("w-13");
    expect(button).toHaveClass("border-btn-ghost-border");
  });
});
