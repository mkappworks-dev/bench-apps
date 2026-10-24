import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LevelChips } from "./LevelChips";

describe("LevelChips", () => {
  it("renders one chip per level", () => {
    render(<LevelChips selected={[]} onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "INFO" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "WARN" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ERROR" })).toBeInTheDocument();
  });

  it("marks a selected chip as pressed", () => {
    render(<LevelChips selected={["WARN"]} onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "WARN" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "INFO" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the toggled level", () => {
    const onToggle = vi.fn();
    render(<LevelChips selected={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "ERROR" }));
    expect(onToggle).toHaveBeenCalledWith("ERROR");
  });
});
