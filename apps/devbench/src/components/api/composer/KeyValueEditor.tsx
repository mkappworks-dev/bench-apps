import { useEffect, useRef, useState } from "react";
import { SecondaryButton } from "../../ui/SecondaryButton";

export interface KeyValueRow {
  key: string;
  value: string;
  enabled?: boolean;
}

const DEFAULT_HEIGHT = 168;
const MIN_HEIGHT = 64;
const MAX_HEIGHT = 420;
const clamp = (height: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height));

export function KeyValueEditor({
  rows, onChange, showEnabled = false, rowKind = showEnabled ? "header" : "param", addLabel, emptyLabel,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  showEnabled?: boolean;
  rowKind?: "param" | "header";
  addLabel: string;
  emptyLabel: string;
}) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const endDrag = useRef<(() => void) | null>(null);
  const rowName = rowKind === "header" ? "Header" : "Param";

  useEffect(() => () => endDrag.current?.(), []);

  function updateRow(index: number, patch: Partial<KeyValueRow>) {
    onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    endDrag.current?.();
    event.preventDefault();
    const grip = event.currentTarget;
    grip.focus();
    const startY = event.clientY;
    const startHeight = height;
    const pointerId = event.pointerId;
    function move(ev: PointerEvent) {
      if (ev.pointerId === pointerId) setHeight(clamp(startHeight + ev.clientY - startY));
    }
    function finish(ev?: PointerEvent) {
      if (ev && ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      endDrag.current = null;
      if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
    }
    endDrag.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    grip.setPointerCapture?.(pointerId);
  }

  function resizeWithKeys(event: React.KeyboardEvent) {
    const increments: Record<string, number> = { ArrowDown: 16, ArrowUp: -16 };
    if (event.key in increments) {
      event.preventDefault();
      setHeight((current) => clamp(current + increments[event.key]));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHeight(event.key === "Home" ? MIN_HEIGHT : MAX_HEIGHT);
    }
  }

  return (
    <div className="min-w-0">
      <div style={{ height }} className="overflow-y-auto rounded-lg border border-border p-2" data-testid="rows-box">
        {rows.length === 0 ? <div className="p-1 text-sm text-text-muted">{emptyLabel}</div> : rows.map((row, i) => (
          <div key={i} className="mb-1.5 flex min-w-0 items-center gap-1.5">
            {showEnabled ? <input type="checkbox" checked={row.enabled ?? true}
              onChange={(e) => updateRow(i, { enabled: e.target.checked })}
              aria-label={`Include ${rowKind} ${i + 1} when sending`}
              className="shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" /> : null}
            <input className="api-kv-input h-7.5 min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 font-mono text-sm text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              aria-label={`${rowName} ${i + 1} key`} placeholder="key" value={row.key}
              onChange={(e) => updateRow(i, { key: e.target.value })} />
            <input className="api-kv-input h-7.5 min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 font-mono text-sm text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              aria-label={`${rowName} ${i + 1} value`} placeholder="value" value={row.value}
              onChange={(e) => updateRow(i, { value: e.target.value })} />
            <button type="button" onClick={() => onChange(rows.filter((_, index) => index !== i))}
              aria-label={`Remove ${rowKind} ${i + 1}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
        ))}
      </div>
      <div onPointerDown={startDrag} onLostPointerCapture={() => endDrag.current?.()} onKeyDown={resizeWithKeys}
        role="separator" tabIndex={0} aria-label={`Resize ${rowKind}s`} aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={height}
        className="group flex h-3 touch-none cursor-ns-resize items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        data-testid="rows-resize-handle">
        <span className="h-1 w-9 rounded-full bg-border transition-colors group-hover:bg-text-muted group-focus-visible:bg-text-muted" />
      </div>
      <SecondaryButton onClick={() => onChange([...rows, { key: "", value: "", enabled: true }])}
        className="mt-1.5 h-7.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        {addLabel}
      </SecondaryButton>
    </div>
  );
}
