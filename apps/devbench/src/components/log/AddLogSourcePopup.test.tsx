import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddLogSourcePopup, parseArgs } from "./AddLogSourcePopup";

function pickKind(kind: "File" | "Command" | "Docker") {
  fireEvent.click(screen.getByRole("button", { name: "Add log source" }));
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(kind) }));
}

describe("parseArgs", () => {
  it("splits on whitespace", () => {
    expect(parseArgs("run dev --port 3000")).toEqual(["run", "dev", "--port", "3000"]);
  });

  it("keeps a double-quoted group together", () => {
    expect(parseArgs('-c "echo hello world"')).toEqual(["-c", "echo hello world"]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseArgs("   ")).toEqual([]);
  });
});

describe("AddLogSourcePopup", () => {
  it("shows no form until a kind is picked", () => {
    render(<AddLogSourcePopup onSubmit={() => {}} onCancel={() => {}} error={null} />);
    expect(screen.queryByPlaceholderText("/tmp/devbench.log")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("npm")).not.toBeInTheDocument();
  });

  it("submits a file source", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("File");
    fireEvent.change(screen.getByPlaceholderText("/tmp/devbench.log"), {
      target: { value: "/tmp/app.log" },
    });
    fireEvent.change(screen.getByPlaceholderText("server.log"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({ label: "api", kind: "file", path: "/tmp/app.log" });
  });

  it("shows only the file field for a file source", () => {
    render(<AddLogSourcePopup onSubmit={() => {}} onCancel={() => {}} error={null} />);
    pickKind("File");
    expect(screen.getByPlaceholderText("/tmp/devbench.log")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("npm")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("my-container")).not.toBeInTheDocument();
  });

  it("submits a command source with parsed args and an optional cwd", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("Command");
    fireEvent.change(screen.getByPlaceholderText("npm"), { target: { value: "npm" } });
    fireEvent.change(screen.getByPlaceholderText("run dev"), { target: { value: "run dev" } });
    fireEvent.change(screen.getByPlaceholderText("/path/to/project (optional)"), {
      target: { value: "/home/dev/app" },
    });
    fireEvent.change(screen.getByPlaceholderText("web"), { target: { value: "web" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({
      label: "web",
      kind: "command",
      program: "npm",
      args: ["run", "dev"],
      cwd: "/home/dev/app",
    });
  });

  it("omits cwd when it is left blank", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("Command");
    fireEvent.change(screen.getByPlaceholderText("npm"), { target: { value: "npm" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({
      label: "",
      kind: "command",
      program: "npm",
      args: [],
      cwd: undefined,
    });
  });

  it("turns the docker preset into a plain command source", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("Docker");
    fireEvent.change(screen.getByPlaceholderText("my-container"), { target: { value: "api-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({
      label: "api-1",
      kind: "command",
      program: "docker",
      args: ["logs", "-f", "api-1"],
      cwd: undefined,
    });
  });

  it("does not submit a file source with an empty path", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("File");
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit a command source with an empty program", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourcePopup onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    pickKind("Command");
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a backend error", () => {
    render(<AddLogSourcePopup onSubmit={() => {}} onCancel={() => {}} error="is not a regular file" />);
    expect(screen.getByText(/is not a regular file/)).toBeInTheDocument();
  });
});
