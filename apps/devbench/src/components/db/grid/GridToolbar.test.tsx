import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GridToolbar } from "./GridToolbar";
import { EMPTY_LAYOUT } from "./gridLayout";
import type { FilterCondition, SortTerm } from "./types";

function renderToolbar(overrides: Partial<Parameters<typeof GridToolbar>[0]> = {}) {
  const props = {
    columns: ["id", "status"],
    rows: [["1", "paid"]] as (string | null)[][],
    layout: EMPTY_LAYOUT,
    onLayoutChange: vi.fn(),
    filter: [] as FilterCondition[],
    onFilterChange: vi.fn(),
    sort: [] as SortTerm[],
    onSortChange: vi.fn(),
    page: 1,
    pageCount: 3,
    onPageChange: vi.fn(),
    limit: 100,
    onLimitChange: vi.fn(),
    onRefresh: vi.fn(),
    familyOf: () => "text" as const,
    ...overrides,
  };
  const { rerender } = render(<GridToolbar {...props} />);
  return { ...props, rerender: (patch: Partial<Parameters<typeof GridToolbar>[0]>) => rerender(<GridToolbar {...props} {...patch} />) };
}

describe("GridToolbar", () => {
  it("shows no count badge when nothing is filtered or sorted", () => {
    renderToolbar();
    expect(screen.getByRole("button", { name: "Filter" })).not.toHaveTextContent(/\d/);
  });

  // The badge counts what is ACTING on the grid, not what is stored.
  it("counts only enabled conditions", () => {
    renderToolbar({
      filter: [
        { column: "status", op: "eq", value: "paid", enabled: true },
        { column: "id", op: "eq", value: "1", enabled: false },
      ],
    });
    expect(screen.getByRole("button", { name: /^Filter/ })).toHaveTextContent("1");
  });

  it("does not count a condition still missing its value", () => {
    renderToolbar({ filter: [{ column: "status", op: "eq", value: "", enabled: true }] });
    expect(screen.getByRole("button", { name: /^Filter/ })).not.toHaveTextContent(/\d/);
  });

  it("counts only enabled sort terms", () => {
    renderToolbar({
      sort: [
        { column: "id", descending: false, enabled: true },
        { column: "status", descending: false, enabled: false },
      ],
    });
    expect(screen.getByRole("button", { name: /^Sort/ })).toHaveTextContent("1");
  });

  it("counts hidden columns on the Columns button", () => {
    renderToolbar({ layout: { ...EMPTY_LAYOUT, hidden: ["status"] } });
    expect(screen.getByRole("button", { name: /^Columns/ })).toHaveTextContent("1");
  });

  it("goes to the page typed into the field", () => {
    const props = renderToolbar();
    const field = screen.getByRole("textbox", { name: "Page number" });
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onPageChange).toHaveBeenCalledWith(2);
  });

  // Out of range clamps rather than erroring or fetching an empty page.
  it("clamps a page beyond the last one", () => {
    const props = renderToolbar({ pageCount: 3 });
    const field = screen.getByRole("textbox", { name: "Page number" });
    fireEvent.change(field, { target: { value: "99" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onPageChange).toHaveBeenCalledWith(3);
  });

  it("disables Previous on the first page and Next on the last", () => {
    renderToolbar({ page: 1, pageCount: 1 });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  // A new page size makes the current offset meaningless.
  it("returns to page 1 when the limit changes", () => {
    const props = renderToolbar({ page: 3 });
    fireEvent.change(screen.getByRole("combobox", { name: "Rows per page" }), { target: { value: "25" } });
    expect(props.onLimitChange).toHaveBeenCalledWith(25);
    expect(props.onPageChange).toHaveBeenCalledWith(1);
  });

  it("refreshes", () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  // pageField is local state seeded once from the page prop — Prev/Next and
  // any other external page change (filter/sort/limit resets) must still
  // resync the field, not just the field's own commit path.
  it("keeps the page-number field in sync when the page prop changes externally", () => {
    const props = renderToolbar({ page: 1, pageCount: 3 });
    expect(screen.getByRole("textbox", { name: "Page number" })).toHaveValue("1");
    props.rerender({ page: 2 });
    expect(screen.getByRole("textbox", { name: "Page number" })).toHaveValue("2");
  });

  it("opens the filter popover and closes it again", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByText(/applied as a WHERE clause/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/applied as a WHERE clause/i)).not.toBeInTheDocument();
  });

  // Under 620px of container width `.tb-label` is display:none, so the label
  // stops contributing to the name-from-contents and the button would announce
  // as the bare badge digit. The explicit aria-label is what survives that.
  describe("accessible names", () => {
    it("names a badged trigger by its label, not just its count", () => {
      renderToolbar({
        filter: [{ column: "status", op: "eq", value: "paid", enabled: true }],
        layout: { ...EMPTY_LAYOUT, hidden: ["status"] },
      });
      expect(screen.getByRole("button", { name: "Filter, 1 applied" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Columns, 1 hidden" })).toBeInTheDocument();
    });

    // The digit is already spelled out in the aria-label above.
    it("keeps the count badge out of the accessible name", () => {
      renderToolbar({ filter: [{ column: "status", op: "eq", value: "paid", enabled: true }] });
      const badge = screen.getByRole("button", { name: /^Filter/ }).querySelector("[aria-hidden='true']");
      expect(badge).toHaveTextContent("1");
    });

    it("declares each trigger as opening a dialog, and names the dialog", () => {
      renderToolbar();
      const trigger = screen.getByRole("button", { name: "Sort" });
      expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
      fireEvent.click(trigger);
      expect(screen.getByRole("dialog", { name: "Sort options" })).toBeInTheDocument();
    });
  });

  // Spec §4: "Cancel, or dismissing the popover by clicking away, discards the
  // draft and closes." Both dismissals must behave exactly like Cancel.
  describe("dismissal", () => {
    it("closes on a click outside without applying the draft", () => {
      const props = renderToolbar();
      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
      fireEvent.click(screen.getByRole("button", { name: /add filter/i }));

      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(props.onFilterChange).not.toHaveBeenCalled();
    });

    it("closes on Escape without applying the draft", () => {
      const props = renderToolbar();
      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
      fireEvent.click(screen.getByRole("button", { name: /add filter/i }));

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(props.onFilterChange).not.toHaveBeenCalled();
    });

    it("discards the draft rather than keeping it for the next open", () => {
      renderToolbar();
      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
      fireEvent.click(screen.getByRole("button", { name: /add filter/i }));
      expect(screen.getByRole("combobox", { name: /^Filter column/ })).toBeInTheDocument();

      fireEvent.pointerDown(document.body);
      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
      expect(screen.queryByRole("combobox", { name: /^Filter column/ })).not.toBeInTheDocument();
    });

    // A press on a trigger must reach that trigger's own toggle: closing from
    // the document handler first would make the toggle reopen what was just
    // dismissed, and would break switching straight from one popover to another.
    it("still lets a trigger close its own popover and switch to another", () => {
      renderToolbar();
      const filter = screen.getByRole("button", { name: "Filter" });
      fireEvent.pointerDown(filter);
      fireEvent.click(filter);
      expect(screen.getByRole("dialog", { name: "Filter options" })).toBeInTheDocument();

      const sort = screen.getByRole("button", { name: "Sort" });
      fireEvent.pointerDown(sort);
      fireEvent.click(sort);
      expect(screen.getByRole("dialog", { name: "Sort options" })).toBeInTheDocument();

      fireEvent.pointerDown(sort);
      fireEvent.click(sort);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("stays open for a click inside itself", () => {
      renderToolbar();
      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
      const dialog = screen.getByRole("dialog");
      fireEvent.pointerDown(dialog);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  // Spec §5: hiding a column is a view concern — it "is still fetched, still
  // filterable and sortable, and still exported."
  describe("export", () => {
    // downloadText puts the payload in a Blob and hands it to an anchor, so
    // asserting on real exported content means intercepting both: the Blob for
    // the text (Blob.text() is async, click() is not, so it is stashed at
    // construction) and the anchor for the filename.
    const captured: { name: string; text: string }[] = [];
    let lastBlobText = "";
    const RealBlob = globalThis.Blob;
    const realCreateElement = document.createElement.bind(document);

    beforeEach(() => {
      captured.length = 0;
      globalThis.Blob = class extends RealBlob {
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
          super(parts, options);
          lastBlobText = parts.join("");
        }
      } as typeof Blob;
      // jsdom implements neither, so these are defined rather than spied on.
      URL.createObjectURL = vi.fn(() => "blob:mock");
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
        const element = realCreateElement(tag);
        if (tag === "a") {
          element.click = () =>
            captured.push({ name: (element as HTMLAnchorElement).download, text: lastBlobText });
        }
        return element;
      });
    });

    afterEach(() => {
      globalThis.Blob = RealBlob;
      vi.restoreAllMocks();
    });

    const layout = {
      ...EMPTY_LAYOUT,
      order: ["status", "id", "notes"],
      pinned: ["id"],
      hidden: ["notes"],
    };
    const exportProps = {
      columns: ["id", "status", "notes"],
      rows: [["1", "paid", "rush"], ["2", "pending", null]] as (string | null)[][],
      layout,
    };

    it("includes hidden columns in the CSV, in the grid's visual order", () => {
      renderToolbar(exportProps);
      fireEvent.click(screen.getByRole("button", { name: /^Export/ }));
      fireEvent.click(screen.getByRole("button", { name: "CSV" }));

      expect(captured).toHaveLength(1);
      expect(captured[0].name).toBe("rows.csv");
      // Pinned "id" first, then saved order, with hidden "notes" still present.
      expect(captured[0].text).toBe("id,status,notes\n1,paid,rush\n2,pending,");
    });

    it("includes hidden columns in the JSON", () => {
      renderToolbar(exportProps);
      fireEvent.click(screen.getByRole("button", { name: /^Export/ }));
      fireEvent.click(screen.getByRole("button", { name: "JSON" }));

      expect(captured[0].name).toBe("rows.json");
      expect(JSON.parse(captured[0].text)).toEqual([
        { id: "1", status: "paid", notes: "rush" },
        { id: "2", status: "pending", notes: null },
      ]);
    });
  });
});
