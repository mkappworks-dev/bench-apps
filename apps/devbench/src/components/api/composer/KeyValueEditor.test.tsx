import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeyValueEditor } from "./KeyValueEditor";

describe("KeyValueEditor", () => {
  it("shows the empty-state label when there are no rows", () => {
    render(<KeyValueEditor rows={[]} onChange={() => {}} addLabel="Add header" emptyLabel="No headers set." />);
    expect(screen.getByText("No headers set.")).toBeInTheDocument();
  });

  it("adds a row when Add is clicked", () => {
    const onChange = vi.fn();
    render(<KeyValueEditor rows={[]} onChange={onChange} addLabel="Add header" emptyLabel="No headers set." />);
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    expect(onChange).toHaveBeenCalledWith([{ key: "", value: "", enabled: true }]);
  });

  it("removes a row when its remove button is clicked", () => {
    const onChange = vi.fn();
    render(
      <KeyValueEditor
        rows={[
          { key: "a", value: "1", enabled: true },
          { key: "b", value: "2", enabled: true },
        ]}
        onChange={onChange}
        addLabel="Add header"
        emptyLabel="No headers set."
      />,
    );
    fireEvent.click(screen.getAllByLabelText("Remove")[0]);
    expect(onChange).toHaveBeenCalledWith([{ key: "b", value: "2", enabled: true }]);
  });

  it("updates a row's key on input", () => {
    const onChange = vi.fn();
    render(
      <KeyValueEditor
        rows={[{ key: "", value: "", enabled: true }]}
        onChange={onChange}
        addLabel="Add param"
        emptyLabel="No params."
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("key"), { target: { value: "status" } });
    expect(onChange).toHaveBeenCalledWith([{ key: "status", value: "", enabled: true }]);
  });

  it("hides the enabled checkbox when showEnabled is false", () => {
    render(<KeyValueEditor rows={[{ key: "a", value: "1" }]} onChange={() => {}} addLabel="Add param" emptyLabel="No params." />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("toggles a row's enabled flag via its checkbox", () => {
    const onChange = vi.fn();
    render(
      <KeyValueEditor
        rows={[{ key: "a", value: "1", enabled: true }]}
        onChange={onChange}
        showEnabled
        addLabel="Add header"
        emptyLabel="No headers set."
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith([{ key: "a", value: "1", enabled: false }]);
  });

  it("resizes the rows box by dragging its handle", () => {
    render(
      <KeyValueEditor
        rows={[{ key: "a", value: "1", enabled: true }]}
        onChange={() => {}}
        addLabel="Add header"
        emptyLabel="No headers set."
      />,
    );
    const handle = screen.getByTestId("rows-resize-handle");
    const box = screen.getByTestId("rows-box");
    expect(box).toHaveStyle({ height: "168px" });
    fireEvent.mouseDown(handle, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 200 });
    fireEvent.mouseUp(window);
    expect(box).toHaveStyle({ height: "268px" });
  });
});
