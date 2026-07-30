import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App shell", () => {
  it("renders the DevBench brand and one tab per configured tool", () => {
    render(<App />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["API", "DB", "Log"]);
  });

  it("marks exactly one tab selected", () => {
    render(<App />);
    const selected = screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
  });
});
