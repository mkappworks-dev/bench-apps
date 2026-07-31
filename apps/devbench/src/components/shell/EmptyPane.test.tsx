import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyPane } from "./EmptyPane";

describe("EmptyPane", () => {
  it("explains that duplicates are allowed and offers the same tool menu as +", () => {
    const onAddTab = vi.fn();
    render(<EmptyPane onAddTab={onAddTab} />);

    expect(screen.getByText(/no tools open/i)).toBeInTheDocument();
    expect(screen.getByText(/duplicates are allowed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add a tool/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "API" }));
    expect(onAddTab).toHaveBeenCalledWith("api");
  });
});
