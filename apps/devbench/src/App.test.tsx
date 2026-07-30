import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App shell", () => {
  it("renders the DevBench brand and both tabs", () => {
    render(<App />);
    expect(screen.getByText("DevBench")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "API" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "DB" })).toBeInTheDocument();
  });
});
