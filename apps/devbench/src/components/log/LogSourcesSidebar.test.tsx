import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogSourcesSidebar } from "./LogSourcesSidebar";

const sources = [
  { id: "a", label: "server.log", path: "/tmp/server.log", state: "live", error: null },
  { id: "b", label: "worker.log", path: "/tmp/worker.log", state: "error", error: "cannot read /tmp/worker.log" },
];

describe("LogSourcesSidebar", () => {
  it("lists sources and highlights the selected one", () => {
    render(
      <LogSourcesSidebar
        sources={sources}
        activeSourceId="a"
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "server.log" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "worker.log" })).toHaveAttribute("aria-current", "false");
  });

  it("shows the error text for a source that cannot be read", () => {
    render(
      <LogSourcesSidebar sources={sources} activeSourceId={null} onSelect={() => {}} onRemove={() => {}} onAdd={() => {}} />,
    );
    expect(screen.getByText(/cannot read \/tmp\/worker\.log/)).toBeInTheDocument();
  });

  it("selects a source when clicked", () => {
    const onSelect = vi.fn();
    render(
      <LogSourcesSidebar sources={sources} activeSourceId={null} onSelect={onSelect} onRemove={() => {}} onAdd={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "worker.log" }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("removes a source", () => {
    const onRemove = vi.fn();
    render(
      <LogSourcesSidebar sources={sources} activeSourceId={null} onSelect={() => {}} onRemove={onRemove} onAdd={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove server.log" }));
    expect(onRemove).toHaveBeenCalledWith("a");
  });
});
