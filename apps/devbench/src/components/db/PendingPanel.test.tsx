import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PendingPanel } from "./PendingPanel";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";
import type { PendingChange } from "../../lib/pendingChanges";

const ORDERS = { schema: "public", name: "orders" };
const USERS = { schema: "public", name: "users" };

const UPDATE: PendingChange = {
  kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "1",
  column: "status", old_value: "pending", new_value: "shipped",
};
const DELETE: PendingChange = {
  kind: "delete", connection_id: "c1", table: USERS, pk_column: "id", pk_value: "9",
};
// Same shape, staged while the picker was pointing somewhere else.
const OTHER_CONNECTION: PendingChange = {
  kind: "update", connection_id: "c2", table: ORDERS, pk_column: "id", pk_value: "42",
  column: "status", old_value: "pending", new_value: "cancelled",
};

function seed(pending: PendingChange[]) {
  useAppStore.setState({ pending });
}

function renderPanel(onApplied = vi.fn(), connectionId: string | null = "c1", onConflictIndex = vi.fn()) {
  return {
    onApplied,
    onConflictIndex,
    ...render(
      <PendingPanel
        connectionId={connectionId}
        onClose={() => {}}
        onApplied={onApplied}
        onConflictIndex={onConflictIndex}
      />,
    ),
  };
}

describe("PendingPanel", () => {
  beforeEach(() => {
    useAppStore.getState().discardAllPending();
    useAppStore.getState().setApplyInFlight(false);
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

  // The backend enumerates the array it was SENT, which is only this
  // connection's subset. Without mapping, a conflict on the first sent entry
  // reports index 0 — which addresses a different connection's entry.
  it("reports a conflict against the entry's position in the whole set, not the sent subset", async () => {
    // UPDATE is connection c1; it sits at whole-set index 1, sent index 0.
    seed([OTHER_CONNECTION, UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({
      applied: 0,
      conflict: {
        index: 0, table: "public.orders", description: "id = 1", column: "status",
        expected: "pending", found: "cancelled", row_missing: false,
      },
    });
    const { onConflictIndex } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(onConflictIndex).toHaveBeenCalledWith(1);
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

  describe("more than one connection in the set", () => {
    // The set is global, the connection is not. Applying an entry staged
    // against dev to whatever the picker now points at is a write to the wrong
    // database — the whole reason entries carry their connection.
    it("sends only the entries staged against this connection, and counts only those", async () => {
      seed([UPDATE, OTHER_CONNECTION, DELETE]);
      const apply = vi
        .spyOn(tauriLib, "invokeApplyChanges")
        .mockResolvedValue({ applied: 2, conflict: null });
      renderPanel();

      fireEvent.click(screen.getByRole("button", { name: "Apply 2" }));

      await waitFor(() => expect(apply).toHaveBeenCalledWith("c1", [UPDATE, DELETE]));
      // The other connection's work is left exactly where it was.
      await waitFor(() => expect(useAppStore.getState().pending).toEqual([OTHER_CONNECTION]));
    });

    // Not hidden: staged work the user cannot see is staged work they cannot
    // discard, and it would still be counted by the Pending badge.
    it("still shows the other connection's entries, marked as not part of this Apply", () => {
      seed([UPDATE, OTHER_CONNECTION]);
      renderPanel();

      expect(screen.getByText(/staged on another connection/i)).toBeTruthy();
      expect(screen.getByText(/connection c2/i)).toBeTruthy();
      expect(screen.getByText("cancelled")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Apply 1" })).toBeTruthy();
    });

    it("offers nothing to apply when the whole set belongs to another connection", () => {
      seed([OTHER_CONNECTION]);
      renderPanel();
      expect((screen.getByRole("button", { name: /^apply/i }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  // Finding 2: the grid is NOT frozen during Apply, so the set can grow while
  // the call is out. Clearing it wholesale on success destroys the newcomer —
  // and the post-Apply refetch then repaints the stored value over it, so the
  // edit vanishes with no error anywhere.
  it("keeps a change staged during Apply and clears only what it sent", async () => {
    seed([UPDATE]);
    let resolveApply: (outcome: tauriLib.ApplyOutcome) => void = () => {};
    vi.spyOn(tauriLib, "invokeApplyChanges").mockReturnValue(
      new Promise((resolve) => {
        resolveApply = resolve;
      }),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));
    await screen.findByRole("button", { name: "Applying…" });

    // B is staged mid-flight, exactly as toggling a checkbox in the live grid
    // would do it.
    const staged: PendingChange = {
      kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id", pk_value: "7",
      column: "paid", old_value: "false", new_value: "true",
    };
    act(() => {
      useAppStore.getState().stagePendingUpdate(staged);
    });
    expect(useAppStore.getState().pending).toHaveLength(2);

    await act(async () => {
      resolveApply({ applied: 1, conflict: null });
    });

    await waitFor(() => expect(useAppStore.getState().pending).toEqual([staged]));
  });

  // Finding 3: the transaction rolls back and the panel is the only place the
  // conflict can be reported. Dismissing it mid-flight loses that report.
  it("cannot be closed while an Apply is in flight", async () => {
    seed([UPDATE]);
    let resolveApply: (outcome: tauriLib.ApplyOutcome) => void = () => {};
    vi.spyOn(tauriLib, "invokeApplyChanges").mockReturnValue(
      new Promise((resolve) => {
        resolveApply = resolve;
      }),
    );
    renderPanel();

    const close = screen.getByRole("button", { name: "Close pending changes" }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));
    await screen.findByRole("button", { name: "Applying…" });
    expect((screen.getByRole("button", { name: "Close pending changes" }) as HTMLButtonElement).disabled).toBe(true);
    // The dock itself is held open too, so AppStrip's toggle cannot unmount
    // the panel out from under the answer.
    expect(useAppStore.getState().applyInFlight).toBe(true);

    await act(async () => {
      resolveApply({ applied: 1, conflict: null });
    });

    await waitFor(() => expect(useAppStore.getState().applyInFlight).toBe(false));
  });

  // Finding 4: an insert with no values renders as a completely blank card,
  // so the entry that fails the whole transaction is the one the user cannot
  // see. The UI no longer stages one, but the card must still say what it is.
  it("says an insert with no values will be rejected rather than rendering blank", () => {
    seed([{ kind: "insert", connection_id: "c1", table: ORDERS, values: {} }]);
    renderPanel();
    expect(screen.getByText(/no values/i)).toBeTruthy();
  });
});
