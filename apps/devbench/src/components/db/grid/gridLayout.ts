export const ROW_HEIGHT_PX = 33;
/** Width an undragged column is guaranteed at least — the readable default. */
export const MIN_COLUMN_PX = 140;
/** Floor for a column the user has dragged. Far below MIN_COLUMN_PX: sharing
 *  one constant meant the default width was also the smallest achievable one,
 *  so a drag could only ever widen a column. */
export const MIN_RESIZED_COLUMN_PX = 56;
export const ACTIONS_COLUMN_PX = 90;
const LAYOUT_STORAGE_PREFIX = "devbench.grid-layout.";

/** Per-table view preferences. Only ever holds column *names*, never indices —
 *  a table whose shape changed then degrades to "that column is gone" rather
 *  than to a silent mis-mapping. */
export interface GridLayout {
  widths: Record<string, number>;
  order: string[];
  pinned: string[];
  hidden: string[];
}

export const EMPTY_LAYOUT: GridLayout = { widths: {}, order: [], pinned: [], hidden: [] };

export function readLayout(key: string | undefined): GridLayout {
  if (!key) return EMPTY_LAYOUT;
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_PREFIX + key);
    if (!raw) return EMPTY_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_LAYOUT;
    const { widths, order, pinned, hidden } = parsed as Partial<GridLayout>;
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
    return {
      widths: typeof widths === "object" && widths !== null ? widths : {},
      order: strings(order),
      pinned: strings(pinned),
      hidden: strings(hidden),
    };
  } catch {
    // Unreadable or corrupt storage means "no saved layout", never a broken
    // grid — this runs on every table switch.
    return EMPTY_LAYOUT;
  }
}

export function writeLayout(key: string | undefined, layout: GridLayout): void {
  if (!key) return;
  try {
    localStorage.setItem(LAYOUT_STORAGE_PREFIX + key, JSON.stringify(layout));
  } catch {
    // A full or disabled store must not take the grid down with it.
  }
}

/** Saved order, minus columns this table no longer has, plus any it gained —
 *  then pinned hoisted to the front. Visibility is the callers' business. */
function arrange(columns: string[], layout: GridLayout): string[] {
  const known = layout.order.filter((c) => columns.includes(c));
  const ordered = [...known, ...columns.filter((c) => !known.includes(c))];
  return [
    ...ordered.filter((c) => layout.pinned.includes(c)),
    ...ordered.filter((c) => !layout.pinned.includes(c)),
  ];
}

/** On-screen order — `arrange`, minus the columns the user has hidden. */
export function visualColumns(columns: string[], layout: GridLayout): string[] {
  return arrange(columns, layout).filter((c) => !layout.hidden.includes(c));
}

/** Export order — `arrange`, keeping hidden columns. Hiding is a view concern
 *  (spec §5): a hidden column is still fetched, filterable, sortable and
 *  exported, so an export must not quietly drop the user's data. */
export function exportColumnOrder(columns: string[], layout: GridLayout): string[] {
  return arrange(columns, layout);
}

export function widthOf(column: string, layout: GridLayout): number {
  return layout.widths[column] ?? MIN_COLUMN_PX;
}

/** Left offset for each pinned column, accumulated across the pinned run. */
export function pinOffsets(visual: string[], layout: GridLayout): Record<string, number> {
  const offsets: Record<string, number> = {};
  let accumulated = 0;
  for (const column of visual) {
    if (!layout.pinned.includes(column)) break;
    offsets[column] = accumulated;
    accumulated += widthOf(column, layout);
  }
  return offsets;
}
