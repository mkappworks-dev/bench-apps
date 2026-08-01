// Small-size lockup of the app icon: same ring, same trace line. The app icon
// draws these on a filled black square; here they inherit `currentColor` so the
// mark tracks the theme instead of punching a bright square into the chrome.
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="7" strokeWidth="1.6" />
      <polyline
        points="7.7,12 9.7,12 10.8,9 13.2,15 14.3,12 16.3,12"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Shared by both routes' top strips so the brand holds the same pixels whether
 * the workspace or Settings is showing — duplicating the markup would let the
 * two drift and make the lockup jump on navigation. The left padding clears the
 * traffic lights.
 */
export function BrandLockup() {
  return (
    <div data-tauri-drag-region className="flex select-none items-center gap-2 pl-22 text-text">
      <Logo />
      <span className="text-[13px] font-semibold tracking-tight">Dev Bench</span>
    </div>
  );
}
