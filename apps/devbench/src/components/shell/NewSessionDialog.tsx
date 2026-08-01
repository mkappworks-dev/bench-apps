import { useEffect, useRef, useState } from "react";

export function NewSessionDialog({
  open,
  onCreate,
  onCancel,
}: {
  open: boolean;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  function submit() {
    if (!name.trim()) return;
    onCreate(name.trim());
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New session"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter") submit();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-32"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {/* Glass, per DESIGN.md: a transient overlay, so blur is earned here
          (and by Menu's popup, the other transient surface). The
          `prefers-reduced-transparency` fallback is part of the rule, not an
          extra — a translucent panel with no fallback is a broken surface for
          anyone who has asked the OS to stop doing that. */}
      <div
        className="w-100 rounded-lg border border-border p-4 shadow-2xl backdrop-blur-xl backdrop-saturate-150"
        style={{
          background: "color-mix(in srgb, var(--surface) 72%, transparent)",
          boxShadow: "inset 0 1px 0 0 rgb(255 255 255 / 0.06)",
        }}
      >
        <div className="mb-3 text-sm font-bold text-text">New session</div>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Order flow debug"
          className="w-full rounded-sm border border-border bg-bg px-2.5 py-2 text-sm text-text"
        />
        <div className="mt-2 text-[11px] text-text-faint">
          A session is a named investigation. It never limits which tools you can use.
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-sm px-3 py-1.5 text-sm text-text-muted hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-sm bg-accent px-3 py-1.5 text-sm font-bold text-accent-on"
          >
            Create session
          </button>
        </div>
      </div>
    </div>
  );
}
