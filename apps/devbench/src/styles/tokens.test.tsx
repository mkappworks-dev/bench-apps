import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("design tokens", () => {
  it("exposes --bg as a computed style on the document root", () => {
    render(<div />);
    const value = getComputedStyle(document.documentElement).getPropertyValue("--bg");
    expect(value.trim()).not.toBe("");
  });
});
