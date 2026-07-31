import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "./Menu";

const OPTIONS = [
  { value: "api", label: "API", description: "Send requests" },
  { value: "db", label: "DB", description: "Browse rows" },
];

describe("Menu", () => {
  it("opens on trigger click and reports the chosen value", () => {
    const onSelect = vi.fn();
    render(<Menu label="Add a tool" options={OPTIONS} onSelect={onSelect} trigger="Add" />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    fireEvent.click(screen.getByRole("menuitem", { name: /DB/ }));
    expect(onSelect).toHaveBeenCalledWith("db");
  });

  // A value-bound menu is a picker, not an action list: exactly one option is
  // checked, which is what lets it stand in for a native <select>.
  it("marks the current value as checked when used as a picker", () => {
    render(<Menu label="Theme" options={OPTIONS} value="db" onSelect={() => {}} trigger="Theme" />);
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));

    const items = screen.getAllByRole("menuitemradio");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveAttribute("aria-checked", "true");
    expect(items[0]).toHaveAttribute("aria-checked", "false");
  });

  it("labels the popup for screen readers", () => {
    render(<Menu label="Add a tool" options={OPTIONS} onSelect={() => {}} trigger="Add" />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("menu")).toHaveAccessibleName("Add a tool");
  });
});
