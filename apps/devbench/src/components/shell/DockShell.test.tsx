import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DockShell } from "./DockShell";

describe("DockShell", () => {
  it("names the landmark and its resize handle from the label", () => {
    render(
      <DockShell label="Pending changes" closeLabel="Close pending changes" title="Pending changes" onClose={() => {}}>
        <div>body</div>
      </DockShell>,
    );
    expect(screen.getByRole("complementary", { name: "Pending changes" })).toBeTruthy();
    expect(screen.getByLabelText("Resize Pending changes")).toBeTruthy();
  });

  it("closes through the button its own closeLabel names", () => {
    const onClose = vi.fn();
    render(
      <DockShell label="Insert row" closeLabel="Close insert row" title="Insert row" onClose={onClose}>
        <div>body</div>
      </DockShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close insert row" }));
    expect(onClose).toHaveBeenCalled();
  });

  // The Pending panel is the only place an Apply's conflict can be reported.
  // Dismissing it mid-flight rolls the transaction back with nobody to tell.
  it("refuses to close while the occupant says it is mid-flight", () => {
    const onClose = vi.fn();
    render(
      <DockShell
        label="Pending changes"
        closeLabel="Close pending changes"
        title="Pending changes"
        onClose={onClose}
        closeDisabled
      >
        <div>body</div>
      </DockShell>,
    );
    const close = screen.getByRole("button", { name: "Close pending changes" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  // A footer is a slot, not a fixture: the Pending panel hides its Apply row
  // entirely when nothing is staged, and the shell must not leave a stray
  // divider behind when it does.
  it("renders nothing for the footer slot until one is given", () => {
    const { rerender } = render(
      <DockShell label="Insert row" closeLabel="Close insert row" title="Insert row" onClose={() => {}}>
        <div>body</div>
      </DockShell>,
    );
    expect(screen.queryByRole("button", { name: "Stage insert" })).toBeNull();

    rerender(
      <DockShell
        label="Insert row"
        closeLabel="Close insert row"
        title="Insert row"
        onClose={() => {}}
        footer={<button type="button">Stage insert</button>}
      >
        <div>body</div>
      </DockShell>,
    );
    expect(screen.getByRole("button", { name: "Stage insert" })).toBeTruthy();
  });
});
