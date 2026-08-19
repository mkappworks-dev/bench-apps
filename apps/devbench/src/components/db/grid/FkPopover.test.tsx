import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FkLinkButton, FkPopover } from "./FkPopover";
import type { ForeignKeyRef } from "./columnMeta";

const TARGET: ForeignKeyRef = { schema: "public", table: "users", column: "id" };

const ROW = {
  columns: ["id", "email", "status"],
  rows: [["usr_88", "grace@example.com", "active"]] as (string | null)[][],
  pk_column: "id",
};

function renderPopover(overrides: Partial<Parameters<typeof FkPopover>[0]> = {}) {
  const props = {
    target: TARGET,
    row: ROW,
    loading: false,
    error: null,
    onJump: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<FkPopover {...props} />);
  return props;
}

describe("FkLinkButton", () => {
  // Spec §8: "always visible — it is information about the data, not an
  // affordance for a hover state." A hover-revealed class would make the
  // presence of a key invisible until you happen to point at the cell.
  it("names the target it points at, without needing a hover", () => {
    render(<FkLinkButton target={TARGET} onOpen={vi.fn()} />);
    const button = screen.getByRole("button", { name: /public\.users\.id/ });
    expect(button.className).not.toMatch(/invisible|opacity-0|group-hover/);
  });

  it("opens on click", async () => {
    const onOpen = vi.fn();
    render(<FkLinkButton target={TARGET} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: /public\.users\.id/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("FkPopover", () => {
  it("is a dialog with an accessible name naming the referenced table", () => {
    renderPopover();
    expect(screen.getByRole("dialog", { name: /public\.users/ })).toBeInTheDocument();
  });

  it("heads with the fully qualified target column", () => {
    renderPopover();
    expect(screen.getByText("public.users.id")).toBeInTheDocument();
  });

  it("lists the referenced row as label and value pairs", () => {
    renderPopover();
    for (const label of ROW.columns) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("usr_88")).toBeInTheDocument();
    expect(screen.getByText("grace@example.com")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  // Spec §8: "A referenced row that no longer exists shows 'No matching row in
  // public.users' rather than an empty popover."
  it("says where the row is missing from rather than showing an empty card", () => {
    renderPopover({ row: null });
    expect(screen.getByText("No matching row in public.users.")).toBeInTheDocument();
  });

  it("reports a failed lookup as an alert, not as a missing row", () => {
    renderPopover({ row: null, error: "connection refused" });
    expect(screen.getByRole("alert")).toHaveTextContent("connection refused");
    expect(screen.queryByText(/No matching row/)).not.toBeInTheDocument();
  });

  it("shows a loading state instead of claiming the row is missing", () => {
    renderPopover({ row: null, loading: true });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/No matching row/)).not.toBeInTheDocument();
  });

  it("offers open and close actions with real names", async () => {
    const props = renderPopover();
    await userEvent.click(screen.getByRole("button", { name: /open public\.users/i }));
    expect(props.onJump).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    const props = renderPopover();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("closes when the pointer goes down outside it", async () => {
    const props = renderPopover();
    await userEvent.click(document.body);
    expect(props.onClose).toHaveBeenCalled();
  });

  // The trigger's own click toggles the popover. If a pointerdown on it also
  // closed here, the toggle would reopen what this just dismissed and the
  // popover would never close by clicking its own icon.
  it("leaves a pointer down on the trigger to the trigger", async () => {
    const props = renderPopover();
    const { container } = render(<FkLinkButton target={TARGET} onOpen={vi.fn()} />);
    const trigger = container.querySelector("[data-fk-trigger]") as HTMLElement;
    await userEvent.click(trigger);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  // A NULL in the referenced row must not read as the string "NULL" — the
  // same distinction the grid keeps (regression-critical constraint 4).
  it("keeps NULL visually distinct in the referenced row", () => {
    renderPopover({
      row: { columns: ["id", "notes"], rows: [["usr_88", null]], pk_column: "id" },
    });
    const nullCell = screen.getByText("NULL");
    expect(nullCell.className).toMatch(/italic/);
  });
});
