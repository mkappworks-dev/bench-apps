import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { QueryConsole } from "./QueryConsole";
import * as tauriLib from "../../lib/tauri";
import type { QueryPreview } from "../../lib/tauri";

const SQL_PLACEHOLDER = "SELECT * FROM orders LIMIT 10;";

// DataGrid virtualizes rows via TanStack Virtual, which computes a zero-row
// viewport under jsdom's default zero-size layout (see DataGrid.test.tsx).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => {} };
  };
});

describe("QueryConsole", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("previews a SELECT and shows its rows without committing anything", async () => {
    const previewQuery = vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: ["id"],
      rows: [["1"]],
      rows_affected: null,
    });
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "SELECT id FROM orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(previewQuery).toHaveBeenCalledWith("c1", "SELECT id FROM orders"));
    expect(await screen.findByText("held in an open transaction — not yet committed")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("previews a write and reports rows affected, never a misleading zero rows", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), {
      target: { value: "UPDATE orders SET status = 'shipped' WHERE id = 1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("1 row affected — no rows returned.")).toBeInTheDocument();
  });

  // The backend's honesty contract (Task 7): a result-set-shaped statement
  // reports rows_affected: null with columns populated *even when it matches
  // zero rows*; only a true write reports a number. A discriminator based on
  // "are there rows" rather than "is rows_affected null" would flatten this
  // exact distinction — the one that cost three backend fix rounds.
  it("a SELECT matching zero rows still renders as a (empty) result grid, not a rows-affected count", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: ["id"],
      rows: [],
      rows_affected: null,
    });
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), {
      target: { value: "SELECT id FROM orders WHERE 1 = 0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("held in an open transaction — not yet committed")).toBeInTheDocument();
    expect(screen.getByText("No rows.")).toBeInTheDocument();
    expect(screen.queryByText(/rows? affected/)).not.toBeInTheDocument();
  });

  it("a write matching zero rows reports 0 rows affected, distinctly from a zero-row SELECT", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 0,
    });
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), {
      target: { value: "UPDATE orders SET status = 'x' WHERE id = -1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("0 rows affected — no rows returned.")).toBeInTheDocument();
    expect(screen.queryByText("No rows.")).not.toBeInTheDocument();
  });

  it("commits a preview", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    const commit = vi.spyOn(tauriLib, "invokeCommitPreview").mockResolvedValue(undefined);
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "UPDATE orders SET status = 'x'" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Commit" });

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(commit).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("✓ COMMITTED")).toBeInTheDocument();
  });

  it("rolls back a preview and returns to idle", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "UPDATE orders SET status = 'x'" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Rollback" });

    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));

    await waitFor(() => expect(rollback).toHaveBeenCalledWith("p1"));
    expect(screen.queryByText("✓ COMMITTED")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
  });

  it("editing the SQL after a preview discards it, requiring a fresh Preview", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: ["id"],
      rows: [["1"]],
      rows_affected: null,
    });
    render(<QueryConsole connectionId="c1" />);

    const textarea = screen.getByPlaceholderText(SQL_PLACEHOLDER);
    fireEvent.change(textarea, { target: { value: "SELECT id FROM orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Commit" });

    fireEvent.change(textarea, { target: { value: "SELECT id FROM orders WHERE id = 2" } });

    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
  });

  // Design choice, matching the comment left in QueryConsole.tsx: unlike an
  // abandoned cell edit (DbTab), invalidating a preview by editing the SQL
  // does not eagerly roll it back — the transaction is still open and will
  // still expire via the ~2-minute sweep, but the console has no way back to
  // that preview_id once the text it previewed has changed. This is
  // deliberately different from what happens when the console itself is
  // unmounted (see the "unmounting" tests below), which does roll back.
  it("editing the SQL after a preview does not roll back the still-open transaction", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: ["id"],
      rows: [["1"]],
      rows_affected: null,
    });
    const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);
    render(<QueryConsole connectionId="c1" />);

    const textarea = screen.getByPlaceholderText(SQL_PLACEHOLDER);
    fireEvent.change(textarea, { target: { value: "SELECT id FROM orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Commit" });

    fireEvent.change(textarea, { target: { value: "SELECT id FROM orders WHERE id = 2" } });

    expect(rollback).not.toHaveBeenCalled();
  });

  it("a failed preview reports the failure and does not enter the preview phase", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockRejectedValue(new Error("syntax error at or near \"SELCT\""));
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "SELCT 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText(/syntax error/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
  });

  // Failure-honesty regression guard, commit side (this bug class has been
  // caught five times on this branch): an expired preview (the sweep can
  // beat the user to a commit) must read as neither "committed" nor "nothing
  // happened," and must not leave stale Commit/Rollback buttons pointed at a
  // preview_id that's now unusable regardless of which way the commit failed.
  it("a failed commit reports the failure, does not claim success, and requires a fresh preview to retry", async () => {
    vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
      preview_id: "p1",
      columns: [],
      rows: [],
      rows_affected: 1,
    });
    vi.spyOn(tauriLib, "invokeCommitPreview").mockRejectedValue(new Error("no open preview with id p1"));
    render(<QueryConsole connectionId="c1" />);

    fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "UPDATE orders SET status = 'x'" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Commit" }));

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    expect(screen.queryByText("✓ COMMITTED")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
  });

  describe("interacting while a request is still in flight", () => {
    it("double-clicking Preview fires exactly one preview request", async () => {
      const deferred: { resolve: ((v: QueryPreview) => void) | null } = { resolve: null };
      const previewQuery = vi
        .spyOn(tauriLib, "invokePreviewQuery")
        .mockImplementation(() => new Promise<QueryPreview>((resolve) => (deferred.resolve = resolve)));
      render(<QueryConsole connectionId="c1" />);

      fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "SELECT 1" } });
      const previewButton = screen.getByRole("button", { name: "Preview" });
      fireEvent.click(previewButton);
      fireEvent.click(previewButton);

      expect(previewQuery).toHaveBeenCalledTimes(1);

      await act(async () => {
        deferred.resolve?.({ preview_id: "p1", columns: ["n"], rows: [["1"]], rows_affected: null });
        await Promise.resolve();
      });
      expect(await screen.findByRole("button", { name: "Commit" })).toBeInTheDocument();
    });

    it("double-clicking Commit fires exactly one commit request and reports the true outcome", async () => {
      vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });
      const deferredCommit: { resolve: (() => void) | null } = { resolve: null };
      const commit = vi
        .spyOn(tauriLib, "invokeCommitPreview")
        .mockImplementation(() => new Promise<void>((resolve) => (deferredCommit.resolve = resolve)));
      render(<QueryConsole connectionId="c1" />);

      fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "UPDATE orders SET status = 'x'" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      const commitButton = await screen.findByRole("button", { name: "Commit" });

      fireEvent.click(commitButton);
      fireEvent.click(commitButton);
      expect(commit).toHaveBeenCalledTimes(1);

      await act(async () => {
        deferredCommit.resolve?.();
        await Promise.resolve();
      });

      expect(await screen.findByText("✓ COMMITTED")).toBeInTheDocument();
      expect(screen.queryByText(/nothing was written/i)).not.toBeInTheDocument();
    });

    // The sharpest case (mirrors DbTab's identical regression guard): no
    // component left to react at all once the drawer is closed. runPreview is
    // a plain async function invoked from onClick — unmounting does not tear
    // down its continuation. The stale-success branch has to recover using
    // only a ref and the rollback call itself, since there is no live
    // component afterward to show a Rollback button on.
    it("unmounting while Preview is in flight rolls back the preview once it lands, with no live component to react to it", async () => {
      const deferred: { resolve: ((v: QueryPreview) => void) | null } = { resolve: null };
      vi.spyOn(tauriLib, "invokePreviewQuery").mockImplementation(
        () => new Promise<QueryPreview>((resolve) => (deferred.resolve = resolve)),
      );
      const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);
      const { unmount } = render(<QueryConsole connectionId="c1" />);

      fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "SELECT 1" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));

      unmount();

      await act(async () => {
        deferred.resolve?.({ preview_id: "p1", columns: ["n"], rows: [["1"]], rows_affected: null });
        await Promise.resolve();
      });

      expect(rollback).toHaveBeenCalledWith("p1");
    });

    // Distinct from the case above: here the preview already landed and is
    // sitting uncommitted (Commit/Rollback visible) when the drawer closes.
    // This is the real production path (DbTab unmounts QueryConsole when the
    // toggle is clicked off) for the hazard called out in the task brief: an
    // open preview holds a real transaction and row lock that must not leak
    // for the sweep's full ~2-minute window just because the drawer closed.
    it("unmounting with an already-open, uncommitted preview rolls it back immediately", async () => {
      vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });
      const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);
      const { unmount } = render(<QueryConsole connectionId="c1" />);

      fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "UPDATE orders SET status = 'x'" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      await screen.findByRole("button", { name: "Commit" });

      unmount();

      expect(rollback).toHaveBeenCalledWith("p1");
    });

    // A commit or rollback already in flight owns deciding that preview's
    // fate — the unmount cleanup must not race it with a redundant second
    // rollback call once the drawer closes mid-request.
    it("unmounting while Commit is in flight does not also fire a redundant rollback", async () => {
      vi.spyOn(tauriLib, "invokePreviewQuery").mockResolvedValue({
        preview_id: "p1",
        columns: [],
        rows: [],
        rows_affected: 1,
      });
      const deferredCommit: { resolve: (() => void) | null } = { resolve: null };
      vi.spyOn(tauriLib, "invokeCommitPreview").mockImplementation(
        () => new Promise<void>((resolve) => (deferredCommit.resolve = resolve)),
      );
      const rollback = vi.spyOn(tauriLib, "invokeRollbackPreview").mockResolvedValue(undefined);
      const { unmount } = render(<QueryConsole connectionId="c1" />);

      fireEvent.change(screen.getByPlaceholderText(SQL_PLACEHOLDER), { target: { value: "UPDATE orders SET status = 'x'" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      fireEvent.click(await screen.findByRole("button", { name: "Commit" }));

      unmount();
      await act(async () => {
        deferredCommit.resolve?.();
        await Promise.resolve();
      });

      expect(rollback).not.toHaveBeenCalled();
    });
  });

  describe("resize", () => {
    // This exercises the actual clamp arithmetic (dragState + clientY delta
    // + Math.min/Math.max), not real layout — there is no getBoundingClientRect
    // or offsetHeight read anywhere in the drag handlers, so unlike DataGrid's
    // virtualization this is honestly assertable under jsdom: the rendered
    // inline `height` style is a direct, unmocked reflection of component
    // state. What this can't prove is how the resize *looks* in a real
    // browser (flex/overflow behavior of the sibling Browse pane) — see the
    // task report for how that was checked instead.
    it("tracks the raw drag delta below both bounds", () => {
      const { container } = render(<QueryConsole connectionId="c1" />);
      const drawer = container.firstElementChild as HTMLElement;
      const handle = screen.getByLabelText("Resize query console");

      expect(drawer.style.height).toBe("220px"); // DEFAULT_HEIGHT_PX

      fireEvent.mouseDown(handle, { clientY: 500 });
      fireEvent.mouseMove(window, { clientY: 550 }); // dragged down 50px -> shrink by 50: 220-50=170
      expect(drawer.style.height).toBe("170px");
      fireEvent.mouseMove(window, { clientY: 450 }); // dragged up 50px from the start -> grow by 50: 220+50=270
      expect(drawer.style.height).toBe("270px");
    });

    it("clamps at MIN_HEIGHT_PX when dragged past the bottom", () => {
      const { container } = render(<QueryConsole connectionId="c1" />);
      const drawer = container.firstElementChild as HTMLElement;
      const handle = screen.getByLabelText("Resize query console");

      fireEvent.mouseDown(handle, { clientY: 500 });
      fireEvent.mouseMove(window, { clientY: 620 }); // shrink by 120: 220-120=100, below the 120 min
      expect(drawer.style.height).toBe("120px");
      fireEvent.mouseMove(window, { clientY: 900 }); // even further past the min
      expect(drawer.style.height).toBe("120px");
    });

    it("clamps at MAX_HEIGHT_PX when dragged past the top", () => {
      const { container } = render(<QueryConsole connectionId="c1" />);
      const drawer = container.firstElementChild as HTMLElement;
      const handle = screen.getByLabelText("Resize query console");

      fireEvent.mouseDown(handle, { clientY: 500 });
      fireEvent.mouseMove(window, { clientY: 100 }); // grow by 400: 220+400=620, above the 560 max
      expect(drawer.style.height).toBe("560px");
      fireEvent.mouseMove(window, { clientY: -200 }); // even further past the max
      expect(drawer.style.height).toBe("560px");
    });

    it("stops resizing once the mouse is released", () => {
      const { container } = render(<QueryConsole connectionId="c1" />);
      const drawer = container.firstElementChild as HTMLElement;
      const handle = screen.getByLabelText("Resize query console");

      fireEvent.mouseDown(handle, { clientY: 500 });
      fireEvent.mouseMove(window, { clientY: 550 });
      expect(drawer.style.height).toBe("170px");

      fireEvent.mouseUp(window);
      fireEvent.mouseMove(window, { clientY: 900 }); // a mousemove with no active drag must be a no-op
      expect(drawer.style.height).toBe("170px");
    });
  });
});
