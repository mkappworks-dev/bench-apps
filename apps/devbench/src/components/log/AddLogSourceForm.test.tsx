import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddLogSourceForm } from "./AddLogSourceForm";

describe("AddLogSourceForm", () => {
  it("submits the entered path and label", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourceForm onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    fireEvent.change(screen.getByPlaceholderText("/tmp/devbench.log"), {
      target: { value: "/tmp/app.log" },
    });
    fireEvent.change(screen.getByPlaceholderText("server.log"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).toHaveBeenCalledWith({ label: "api", path: "/tmp/app.log" });
  });

  it("does not submit an empty path", () => {
    const onSubmit = vi.fn();
    render(<AddLogSourceForm onSubmit={onSubmit} onCancel={() => {}} error={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a backend error", () => {
    render(<AddLogSourceForm onSubmit={() => {}} onCancel={() => {}} error="is not a regular file" />);
    expect(screen.getByText(/is not a regular file/)).toBeInTheDocument();
  });
});
