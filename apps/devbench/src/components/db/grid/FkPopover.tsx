import { useEffect, useRef } from "react";
import { cellDisplay } from "../DataGrid";
import { describeTarget, type ForeignKeyRef } from "./columnMeta";
import type { TableRows } from "../../../lib/tauri";

/** The mockup's `I.link`. */
function LinkIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

/** The mockup's `I.openIn`. */
function OpenInIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * Spec §8: always visible. No `invisible`/`group-hover` classes here on
 * purpose — whether a column has a foreign key is a fact about the schema, and
 * hiding it until hover would mean you have to already suspect a key exists to
 * discover that it does.
 */
export function FkLinkButton({ target, onOpen }: { target: ForeignKeyRef; onOpen: () => void }) {
  const label = describeTarget(target);
  return (
    <button
      type="button"
      data-fk-trigger
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Show referenced row in ${label}`}
      title={label}
      className="shrink-0 rounded-sm p-px text-text-faint hover:bg-surface hover:text-text"
    >
      <LinkIcon />
    </button>
  );
}

const actionButtonClass =
  "grid size-5 shrink-0 place-items-center rounded-sm text-text-faint hover:bg-surface-2 hover:text-text";

export function FkPopover({
  target,
  row,
  loading,
  error,
  onJump,
  onClose,
}: {
  target: ForeignKeyRef;
  /** `null` with no error and not loading means the key points nowhere. */
  row: TableRows | null;
  loading: boolean;
  error: string | null;
  onJump: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const targetTable = `${target.schema}.${target.table}`;

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const node = event.target as Node | null;
      // The trigger's own click already toggles this popover; closing here
      // first would make that toggle reopen what the user just dismissed.
      // Same guard GridToolbar uses for its own popovers.
      if (node instanceof Element && node.closest("[data-fk-trigger]")) return;
      if (ref.current?.contains(node)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Referenced row in ${targetTable}`}
      // z-20 is deliberate: above sibling cells (pinned cells are z-10) and
      // below DataGrid's z-30 sticky header, which must keep covering anything
      // scrolled up under it. Positioned against the cell, which DataGrid
      // already marks `relative` for the inline editor.
      className="absolute left-0 top-full z-20 mt-1 min-w-70 rounded-lg border border-border bg-surface shadow-lg"
    >
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2 font-mono text-xs text-text">
        <LinkIcon />
        <span className="truncate">{describeTarget(target)}</span>
        <span className="ml-auto flex gap-0.5">
          <button
            type="button"
            onClick={onJump}
            aria-label={`Open ${targetTable} at this row`}
            title={`Open ${targetTable} at this row`}
            className={actionButtonClass}
          >
            <OpenInIcon />
          </button>
          <button type="button" onClick={onClose} aria-label="Close referenced row" className={actionButtonClass}>
            <CloseIcon />
          </button>
        </span>
      </div>

      <div className="px-2.5 pb-2.5 pt-1.5">
        {loading ? (
          <div className="py-0.75 text-xs text-text-faint">Loading…</div>
        ) : error ? (
          // A failed lookup is not the same fact as a key pointing nowhere,
          // and saying "no matching row" when the query never ran would be a
          // guess presented as a finding.
          <div role="alert" className="py-0.75 text-xs text-danger">
            {error}
          </div>
        ) : row === null || row.rows.length === 0 ? (
          <div className="py-0.75 text-xs text-text-faint">No matching row in {targetTable}.</div>
        ) : (
          row.columns.map((column, index) => {
            const value = row.rows[0][index] ?? null;
            const { text, className } = cellDisplay(value);
            return (
              <div key={column} className="flex gap-3 py-0.75 font-mono text-xs">
                <span className="min-w-24 shrink-0 text-text-faint">{column}</span>
                {/* cellDisplay carries the grid's own NULL / unsupported
                    treatment, so the popover cannot drift into rendering a
                    real NULL the same as the string "NULL". */}
                <span className={`min-w-0 flex-1 truncate text-text-muted ${className}`}>{text}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
