import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogSourcesSidebar } from "./LogSourcesSidebar";

const sources = [
  { id: "a", label: "server.log", path: "/tmp/server.log", kind: "file", state: "live", error: null, exit_code: null },
  {
    id: "b",
    label: "worker.log",
    path: "/tmp/worker.log",
    kind: "file",
    state: "error",
    error: "cannot read /tmp/worker.log",
    exit_code: null,
  },
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

  it("shows the error text for a source that cannot be read, once it is selected", () => {
    render(
      <LogSourcesSidebar sources={sources} activeSourceId="b" onSelect={() => {}} onRemove={() => {}} onAdd={() => {}} />,
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

  const exited = {
    id: "s-exited",
    label: "one-shot",
    path: "sh -c exit 3",
    kind: "command",
    state: "exited",
    error: null,
    exit_code: 3,
  };

  it("marks an exited source distinctly from an errored one", () => {
    render(
      <LogSourcesSidebar
        sources={[exited]}
        activeSourceId={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByTestId("status-s-exited")).toHaveAttribute("data-state", "exited");
  });

  it("shows a kind glyph for a command source", () => {
    render(
      <LogSourcesSidebar
        sources={[exited]}
        activeSourceId={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByTestId("kind-s-exited").querySelector("svg")).toHaveAttribute("data-icon", "command");
  });

  it("explains an exited source only when it is the selected one", () => {
    const { rerender } = render(
      <LogSourcesSidebar
        sources={[exited]}
        activeSourceId={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.queryByText(/not auto-restarted/)).not.toBeInTheDocument();

    rerender(
      <LogSourcesSidebar
        sources={[exited]}
        activeSourceId="s-exited"
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText(/exited \(code 3\) — not auto-restarted/)).toBeInTheDocument();
  });

  it("shows an error message only for the selected source", () => {
    const broken = {
      id: "s-err",
      label: "gone",
      path: "/tmp/gone.log",
      kind: "file",
      state: "error",
      error: "cannot read /tmp/gone.log",
      exit_code: null,
    };
    const { rerender } = render(
      <LogSourcesSidebar
        sources={[broken]}
        activeSourceId={null}
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.queryByText(/cannot read/)).not.toBeInTheDocument();

    rerender(
      <LogSourcesSidebar
        sources={[broken]}
        activeSourceId="s-err"
        onSelect={() => {}}
        onRemove={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText(/cannot read/)).toBeInTheDocument();
  });
});
