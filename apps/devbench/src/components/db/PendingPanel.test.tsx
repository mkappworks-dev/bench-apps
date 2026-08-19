import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PendingPanel } from "./PendingPanel";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";
import type { PendingChange } from "../../lib/pendingChanges";

const ORDERS = { schema: "public", name: "orders" };
const USERS = { schema: "public", name: "users" };

const UPDATE: PendingChange = {
  kind: "update", table: ORDERS, pk_column: "id", pk_value: "1",
  column: "status", old_value: "pending", new_value: "shipped",
};
const DELETE: PendingChange = { kind: "delete", table: USERS, pk_column: "id", pk_value: "9" };

function seed(pending: PendingChange[]) {
  useAppStore.setState({ pending });
}

function renderPanel(onApplied = vi.fn()) {
  return { onApplied, ...render(<PendingPanel connectionId="c1" onClose={() => {}} onApplied={onApplied} />) };
}

describe("PendingPanel", () => {
  beforeEach(() => {
    useAppStore.getState().discardAllPending();
  });

  it("says nothing is staged, and offers no Apply, when the set is empty", () => {
    renderPanel();
    expect(screen.getByText(/nothing staged/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^apply/i })).toBeNull();
  });

  it("groups entries by table and labels each entry's kind", () => {
    seed([UPDATE, DELETE]);
    renderPanel();
    expect(screen.getByText("public.orders")).toBeTruthy();
    expect(screen.getByText("public.users")).toBeTruthy();
    expect(screen.getByText("update")).toBeTruthy();
    expect(screen.getByText("delete")).toBeTruthy();
  });

  it("shows an update as old then new, so the diff is readable without the grid", () => {
    seed([UPDATE]);
    renderPanel();
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("shipped")).toBeTruthy();
    expect(screen.getByText("id = 1")).toBeTruthy();
  });

  it("counts the whole set on the Apply button", () => {
    seed([UPDATE, DELETE]);
    renderPanel();
    expect(screen.getByRole("button", { name: "Apply 2" })).toBeTruthy();
  });

  it("discards one entry by its position in the whole set", () => {
    seed([UPDATE, DELETE]);
    renderPanel();
    fireEvent.click(screen.getAllByRole("button", { name: /^discard this/i })[0]);
    expect(useAppStore.getState().pending).toEqual([DELETE]);
  });

  it("discards everything at once", () => {
    seed([UPDATE, DELETE]);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    expect(useAppStore.getState().pending).toEqual([]);
  });

  it("sends the whole ordered set in one call and clears it on success", async () => {
    seed([UPDATE, DELETE]);
    const apply = vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({ applied: 2, conflict: null });
    const { onApplied } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 2" }));

    await waitFor(() => expect(apply).toHaveBeenCalledWith("c1", [UPDATE, DELETE]));
    await waitFor(() => expect(useAppStore.getState().pending).toEqual([]));
    expect(onApplied).toHaveBeenCalled();
  });

  // Spec §10: a conflict rolls the transaction back whole. The set must
  // SURVIVE, or the user loses work to a failure that wrote nothing.
  it("keeps the set and reports what it expected versus what it found on a conflict", async () => {
    seed([UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({
      applied: 0,
      conflict: {
        index: 0, table: "public.orders", description: "id = 1", column: "status",
        expected: "pending", found: "cancelled", row_missing: false,
      },
    });
    const { onApplied } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("cancelled");
    expect(useAppStore.getState().pending).toEqual([UPDATE]);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("says the row is gone rather than reporting a NULL it did not find", async () => {
    seed([DELETE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({
      applied: 0,
      conflict: {
        index: 0, table: "public.users", description: "id = 9", column: null,
        expected: null, found: null, row_missing: true,
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toMatch(/no longer exists|already gone|no row/i);
  });

  it("keeps the set when the call itself fails", async () => {
    seed([UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockRejectedValue(new Error("connection refused"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
    expect(useAppStore.getState().pending).toEqual([UPDATE]);
  });
});
