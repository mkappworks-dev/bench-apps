import { useEffect, useRef, useState } from "react";

export interface KeyValueRow {
  key: string;
  value: string;
  enabled?: boolean;
}

const DEFAULT_HEIGHT = 168;
const MIN_HEIGHT = 64;
const MAX_HEIGHT = 420;

export function KeyValueEditor({
  rows,
  onChange,
  showEnabled = false,
  addLabel,
  emptyLabel,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  showEnabled?: boolean;
  addLabel: string;
  emptyLabel: string;
}) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const dragStart = useRef<{ y: number; height: number } | null>(null);
  const endDrag = useRef<(() => void) | null>(null);

  // Unmounting mid-drag would otherwise leave this drag's listeners on window.
  useEffect(() => () => endDrag.current?.(), []);

  function updateRow(index: number, patch: Partial<KeyValueRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function addRow() {
    onChange([...rows, { key: "", value: "", enabled: true }]);
  }

  function onHandleMouseDown(e: React.MouseEvent) {
    dragStart.current = { y: e.clientY, height };
    function onMouseMove(ev: MouseEvent) {
      if (!dragStart.current) return;
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragStart.current.height + (ev.clientY - dragStart.current.y)));
      setHeight(next);
    }
    function onMouseUp() {
      dragStart.current = null;
      endDrag.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    endDrag.current = onMouseUp;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div>
      <div style={{ height }} className="overflow-y-auto rounded-lg border border-border p-2" data-testid="rows-box">
        {rows.length === 0 ? (
          <div className="p-1 text-sm text-text-faint">{emptyLabel}</div>
        ) : (
          rows.map((row, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5">
              {showEnabled ? (
                <input
                  type="checkbox"
                  checked={row.enabled ?? true}
                  onChange={(e) => updateRow(i, { enabled: e.target.checked })}
                  aria-label="Include this header when sending"
                />
              ) : null}
              <input
                className="flex-1 rounded-sm border border-border bg-surface px-2 py-1 font-mono text-sm text-text"
                placeholder="key"
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
              />
              <input
                className="flex-1 rounded-sm border border-border bg-surface px-2 py-1 font-mono text-sm text-text"
                placeholder="value"
                value={row.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
              />
              <button type="button" onClick={() => removeRow(i)} aria-label="Remove" className="text-text-faint hover:text-text">
                ✕
              </button>
            </div>
          ))
        )}
      </div>
      <div
        onMouseDown={onHandleMouseDown}
        className="flex h-2.5 cursor-ns-resize items-center justify-center"
        data-testid="rows-resize-handle"
      >
        <span className="h-1 w-9 rounded-full bg-border" />
      </div>
      <button type="button" onClick={addRow} className="mt-1.5 rounded-sm border border-border px-2.5 py-1 text-sm text-text">
        {addLabel}
      </button>
    </div>
  );
}
