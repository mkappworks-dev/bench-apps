import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";
import { useAppStore } from "./store/useAppStore";

describe("App shell", () => {
  it("renders the three-column workspace with one tab per tool", () => {
    render(<App />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["API", "DB", "Log", "Email"]);
    expect(screen.getByRole("complementary", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "AI Assistant" })).toBeInTheDocument();
  });

  it("hides the chat dock when it is toggled off, without overlaying the content", () => {
    useAppStore.getState().setChatOpen(false);
    render(<App />);
    expect(screen.queryByRole("complementary", { name: "AI Assistant" })).not.toBeInTheDocument();
    useAppStore.getState().setChatOpen(true);
  });

  it("navigates to the settings screen", () => {
    useAppStore.getState().setRoute("settings");
    render(<App />);
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab").map((t) => t.textContent)).not.toContain("Email");
    useAppStore.getState().setRoute("workspace");
  });
});
