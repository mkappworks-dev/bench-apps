import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { KeyValueEditor } from "./KeyValueEditor";

beforeAll(() => vi.stubGlobal("PointerEvent", MouseEvent));
afterAll(() => vi.unstubAllGlobals());

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
    fireEvent.click(screen.getAllByRole("button", { name: /Remove param/ })[0]);
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
    fireEvent.pointerDown(handle, { clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 200 });
    fireEvent.pointerUp(window);
    expect(box).toHaveStyle({ height: "268px" });
  });

  it("drops a drag's window listeners when it unmounts mid-drag", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(
      <KeyValueEditor
        rows={[{ key: "a", value: "1", enabled: true }]}
        onChange={() => {}}
        addLabel="Add header"
        emptyLabel="No headers set."
      />,
    );
    fireEvent.pointerDown(screen.getByTestId("rows-resize-handle"), { clientY: 100 });
    removeSpy.mockClear();

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    removeSpy.mockRestore();
  });
});


describe("row editor accessibility", () => {
  function editor() {
    return render(<KeyValueEditor rows={[{ key: "status", value: "pending" }]} onChange={() => {}} addLabel="Add param" emptyLabel="No params." />);
  }
  it("names each row and supports keyboard height adjustment within bounds", () => {
    editor();
    expect(screen.getByRole("textbox", { name: "Param 1 key" })).toHaveValue("status");
    expect(screen.getByRole("textbox", { name: "Param 1 value" })).toHaveValue("pending");
    expect(screen.getByRole("button", { name: "Remove param 1" })).toBeInTheDocument();
    const grip = screen.getByRole("separator", { name: "Resize params" });
    expect(grip).toHaveAttribute("aria-valuenow", "168");
    expect(grip).toHaveAttribute("aria-valuemin", "64");
    expect(grip).toHaveAttribute("aria-valuemax", "420");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(grip).toHaveAttribute("aria-valuenow", "184");
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(grip).toHaveAttribute("aria-valuenow", "168");
    fireEvent.keyDown(grip, { key: "Home" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(grip).toHaveAttribute("aria-valuenow", "64");
    fireEvent.keyDown(grip, { key: "End" });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(grip).toHaveAttribute("aria-valuenow", "420");
  });
  it("clamps pointer resize and ends it on cancellation or lost capture", () => {
    editor();
    const grip = screen.getByRole("separator");
    fireEvent.pointerDown(grip, { clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 1000 });
    expect(grip).toHaveAttribute("aria-valuenow", "420");
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientY: 0 });
    expect(grip).toHaveAttribute("aria-valuenow", "420");
    fireEvent.pointerDown(grip, { clientY: 100 });
    fireEvent.pointerMove(window, { clientY: -1000 });
    expect(grip).toHaveAttribute("aria-valuenow", "64");
    fireEvent.lostPointerCapture(grip);
    fireEvent.pointerMove(window, { clientY: 500 });
    expect(grip).toHaveAttribute("aria-valuenow", "64");
  });
});
