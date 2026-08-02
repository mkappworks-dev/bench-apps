import { describe, expect, it, beforeEach } from "vitest";
import {
  EMPTY_LAYOUT,
  readLayout,
  writeLayout,
  visualColumns,
  exportColumnOrder,
  pinOffsets,
  MIN_COLUMN_PX,
} from "./gridLayout";

beforeEach(() => localStorage.clear());

describe("visualColumns", () => {
  it("keeps the saved order and appends columns the table has gained", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["status", "id"] };
    expect(visualColumns(["id", "status", "notes"], layout)).toEqual(["status", "id", "notes"]);
  });

  it("drops columns the table no longer has", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["gone", "id"] };
    expect(visualColumns(["id"], layout)).toEqual(["id"]);
  });

  // "pinned" and "leftmost" must never disagree.
  it("hoists pinned columns to the front regardless of saved order", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["status", "id"], pinned: ["id"] };
    expect(visualColumns(["id", "status"], layout)).toEqual(["id", "status"]);
  });

  it("omits hidden columns", () => {
    const layout = { ...EMPTY_LAYOUT, hidden: ["notes"] };
    expect(visualColumns(["id", "notes"], layout)).toEqual(["id"]);
  });
});

describe("exportColumnOrder", () => {
  it("keeps the saved order and appends columns the table has gained", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["status", "id"] };
    expect(exportColumnOrder(["id", "status", "notes"], layout)).toEqual(["status", "id", "notes"]);
  });

  it("drops columns the table no longer has", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["gone", "id"] };
    expect(exportColumnOrder(["id"], layout)).toEqual(["id"]);
  });

  it("hoists pinned columns to the front regardless of saved order", () => {
    const layout = { ...EMPTY_LAYOUT, order: ["status", "id"], pinned: ["id"] };
    expect(exportColumnOrder(["id", "status"], layout)).toEqual(["id", "status"]);
  });

  // The one deliberate difference from visualColumns: hiding is a view concern
  // (spec §5), so an export still carries every column.
  it("keeps hidden columns, unlike visualColumns", () => {
    const layout = { ...EMPTY_LAYOUT, hidden: ["notes"] };
    expect(exportColumnOrder(["id", "notes"], layout)).toEqual(["id", "notes"]);
    expect(visualColumns(["id", "notes"], layout)).toEqual(["id"]);
  });

  it("keeps a hidden column in its pinned position", () => {
    const layout = { ...EMPTY_LAYOUT, pinned: ["notes"], hidden: ["notes"] };
    expect(exportColumnOrder(["id", "notes"], layout)).toEqual(["notes", "id"]);
  });
});

describe("pinOffsets", () => {
  it("accumulates widths across the pinned run only", () => {
    const layout = { ...EMPTY_LAYOUT, pinned: ["id", "status"], widths: { id: 100 } };
    const visual = ["id", "status", "notes"];
    expect(pinOffsets(visual, layout)).toEqual({ id: 0, status: 100 });
  });

  it("falls back to the default width for an undragged pinned column", () => {
    const layout = { ...EMPTY_LAYOUT, pinned: ["id", "status"] };
    expect(pinOffsets(["id", "status"], layout).status).toBe(MIN_COLUMN_PX);
  });
});

describe("readLayout", () => {
  it("round-trips through storage under its key", () => {
    writeLayout("c1:orders", { ...EMPTY_LAYOUT, pinned: ["id"] });
    expect(readLayout("c1:orders").pinned).toEqual(["id"]);
  });

  it("keeps each table's layout separate", () => {
    writeLayout("c1:orders", { ...EMPTY_LAYOUT, pinned: ["id"] });
    expect(readLayout("c1:products").pinned).toEqual([]);
  });

  // Runs on every table switch, so a corrupt entry must not break the grid.
  it("falls back to defaults on unparseable storage", () => {
    localStorage.setItem("devbench.grid-layout.c1:orders", "{not json");
    expect(readLayout("c1:orders")).toEqual(EMPTY_LAYOUT);
  });

  it("returns defaults when no key is given", () => {
    expect(readLayout(undefined)).toEqual(EMPTY_LAYOUT);
  });
});
