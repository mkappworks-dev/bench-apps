import type { ButtonHTMLAttributes } from "react";

/** A hairline of the surface's own light rather than a --border hairline,
 *  which disappears against a translucent panel. Height is deliberately NOT
 *  set here: a footer sets one height for its secondary and primary buttons
 *  together, which is what stops the pair drifting apart. */
export const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border " +
  "border-btn-ghost-border bg-btn-ghost-bg px-2.5 text-xs font-medium text-text-muted " +
  "transition-colors duration-150 hover:border-text-faint hover:text-text " +
  "aria-pressed:bg-surface-2 aria-pressed:text-text disabled:opacity-40";

export function SecondaryButton({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`${SECONDARY_BUTTON_CLASS} ${className}`} {...props} />;
}
