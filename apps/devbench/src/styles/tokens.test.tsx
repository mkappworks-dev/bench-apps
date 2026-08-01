import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("design tokens", () => {
  it("exposes --bg as a computed style on the document root", () => {
    render(<div />);
    const value = getComputedStyle(document.documentElement).getPropertyValue("--bg");
    expect(value.trim()).not.toBe("");
  });

  // The app strip's grid columns must match the sidebar and chat dock widths
  // exactly, or the tab groups stop lining up with the panes they control.
  // One definition here is what keeps them from drifting apart.
  it("exposes the shell width tokens", () => {
    render(<div />);
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue("--w-sidebar").trim()).toBe("15rem");
    expect(root.getPropertyValue("--w-chat").trim()).toBe("20rem");
  });
});
