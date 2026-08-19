import { useEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";

// Matches --w-chat's 20rem token default (tokens.css) at a standard 16px root
// font-size, so the panel doesn't jump on first paint.
const DEFAULT_WIDTH_PX = 320;
const MIN_WIDTH_PX = 260;
const MAX_WIDTH_PX = 640;

/** The right dock's frame, shared by all three occupants (spec §1). Width, the
 *  resize handle and the `--w-chat` custom property live here so chat, pending
 *  and insert cannot drift apart — and so two side panels can never compete
 *  for the same edge. */
export function DockShell({
  label,
  closeLabel,
  title,
  onClose,
  closeDisabled = false,
  footer,
  children,
}: {
  /** Accessible name for the landmark, and the stem of the resize handle's
   *  name. */
  label: string;
  /** The close button's accessible name in full. Separate from `label`
   *  because "Close chat" is not "Close AI Assistant", and that string is
   *  already what tests and screen readers ask for. */
  closeLabel: string;
  title: ReactNode;
  onClose: () => void;
  /** Blocks dismissal while the occupant has an answer still coming. Pending's
   *  Apply is the only such round trip: closing mid-flight would leave a
   *  rolled-back transaction with nobody to report the conflict to. */
  closeDisabled?: boolean;
  /** Rendered below the body with no styling of its own — each occupant
   *  brings its own border and padding, and one that has nothing to act on
   *  passes none at all. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH_PX);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  // AppStrip's topbar sizes its own last grid column from this same `--w-chat`
  // custom property (DESIGN.md's three-column shell) — writing it here, not
  // just an inline style on this element, is what keeps the topbar and the
  // dock in lockstep while dragging.
  useEffect(() => {
    document.documentElement.style.setProperty("--w-chat", `${width}px`);
  }, [width]);

  // No persistence beyond this mount, matching QueryConsole's drag-resize
  // height: reopening the dock (it fully unmounts on close) starts back at
  // DEFAULT_WIDTH_PX. Removing the override here (rather than leaving the last
  // dragged value on the root element) is what makes that true.
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty("--w-chat");
    };
  }, []);

  function onHandleMouseMove(e: MouseEvent) {
    if (!dragState.current) return;
    const dx = dragState.current.startX - e.clientX;
    setWidth(Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, dragState.current.startWidth + dx)));
  }

  function onHandleMouseUp() {
    dragState.current = null;
    window.removeEventListener("mousemove", onHandleMouseMove);
    window.removeEventListener("mouseup", onHandleMouseUp);
  }

  function onHandleMouseDown(e: ReactMouseEvent) {
    dragState.current = { startX: e.clientX, startWidth: width };
    window.addEventListener("mousemove", onHandleMouseMove);
    window.addEventListener("mouseup", onHandleMouseUp);
  }

  return (
    // Ghosty and a flex sibling of the content column — it RESIZES the
    // workspace rather than overlaying it (DESIGN.md).
    <aside aria-label={label} className="relative flex w-(--w-chat) min-w-(--w-chat) border-l border-border">
      {/* Overlays the panel's left edge rather than taking a flex track of its
          own. As a track it pushed the whole content column inward, so the
          header and composer rules started 14px short of the panel edge
          instead of meeting the border like every other divider in the shell. */}
      <div
        onMouseDown={onHandleMouseDown}
        className="absolute inset-y-0 left-0 z-10 flex w-3.5 cursor-col-resize items-center justify-center"
        aria-label={`Resize ${label}`}
        role="separator"
        aria-orientation="vertical"
      >
        <div className="h-9 w-1 rounded-full bg-border" aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center justify-between border-b border-border pl-4 pr-2.5">
          <span className="min-w-0 truncate text-xs font-bold text-text-muted">{title}</span>
          <button
            aria-label={closeLabel}
            disabled={closeDisabled}
            onClick={onClose}
            className="shrink-0 rounded-sm px-1.5 text-text-faint hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
          >
            ✕
          </button>
        </div>
        {children}
        {footer}
      </div>
    </aside>
  );
}
