import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  invokeGetProviderStatus,
  invokeSendChatMessage,
  type ChatMessage,
} from "../../lib/tauri";

interface Turn extends ChatMessage {
  toolCalls?: string[];
}

// Matches --w-chat's 20rem token default (tokens.css) at a standard 16px
// root font-size, so the panel doesn't jump on first paint.
const DEFAULT_WIDTH_PX = 320;
const MIN_WIDTH_PX = 260;
const MAX_WIDTH_PX = 640;

export function ChatDock({ onClose }: { onClose: () => void }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH_PX);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    invokeGetProviderStatus()
      .then((s) => setHasKey(s.has_key))
      .catch(() => setHasKey(false));
  }, []);

  // AppStrip's topbar sizes its own last grid column from this same
  // `--w-chat` custom property (DESIGN.md's three-column shell) — writing it
  // here, not just an inline style on this element, is what keeps the topbar
  // and the dock in lockstep while dragging.
  useEffect(() => {
    document.documentElement.style.setProperty("--w-chat", `${width}px`);
  }, [width]);

  // No persistence beyond this mount, matching QueryConsole's drag-resize
  // height: reopening the dock (it fully unmounts on close) starts back at
  // DEFAULT_WIDTH_PX. Removing the override here (rather than leaving the
  // last dragged value on the root element) is what makes that true.
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

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    const next: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(next);
    setDraft("");
    setSending(true);
    setError(null);
    try {
      const reply = await invokeSendChatMessage(next.map((t) => ({ role: t.role, content: t.content })));
      setTurns([...next, { role: "assistant", content: reply.content, toolCalls: reply.tool_calls }]);
    } catch (err) {
      // The transcript is preserved: losing the user's question because the
      // provider 401'd would be worse than the 401.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    // Ghosty and a flex sibling of the content column — it RESIZES the
    // workspace rather than overlaying it (DESIGN.md).
    <aside aria-label="AI Assistant" className="relative flex w-(--w-chat) min-w-(--w-chat) border-l border-border">
      {/* Overlays the panel's left edge rather than taking a flex track of its
          own. As a track it pushed the whole content column inward, so the
          header and composer rules started 14px short of the panel edge
          instead of meeting the border like every other divider in the shell. */}
      <div
        onMouseDown={onHandleMouseDown}
        className="absolute inset-y-0 left-0 z-10 flex w-3.5 cursor-col-resize items-center justify-center"
        aria-label="Resize AI Assistant"
        role="separator"
        aria-orientation="vertical"
      >
        <div className="h-9 w-1 rounded-full bg-border" aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center justify-between border-b border-border pl-4 pr-2.5">
          <span className="text-xs font-bold text-text-muted">AI Assistant</span>
          <button
            aria-label="Close chat"
            onClick={onClose}
            className="rounded-sm px-1.5 text-text-faint hover:bg-surface-2 hover:text-text"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
          {turns.length === 0 ? (
            <div className="text-xs text-text-faint">
              Ask about this session, or anything DevBench observed.
            </div>
          ) : (
            turns.map((turn, i) => (
              <div
                key={i}
                className={`rounded-lg px-2.5 py-2 text-xs ${
                  turn.role === "user" ? "bg-surface-2 text-text" : "text-text"
                }`}
              >
                <div className="whitespace-pre-wrap">{turn.content}</div>
                {turn.toolCalls && turn.toolCalls.length > 0 ? (
                  <div className="mt-1 text-[11px] text-text-faint">
                    Used {turn.toolCalls.join(", ")}
                  </div>
                ) : null}
              </div>
            ))
          )}
          {sending ? <div className="text-xs text-text-faint">Thinking…</div> : null}
          {error ? (
            <div className="rounded-sm bg-danger-bg px-2 py-1 text-[11px] text-danger">{error}</div>
          ) : null}
          {hasKey === false ? (
            <div className="rounded-sm bg-warning-bg px-2 py-1 text-[11px] text-warning">
              Add a provider key in Settings &gt; Provider to use the assistant.
            </div>
          ) : null}
        </div>

        <div className="flex gap-2 border-t border-border p-2.5">
          <input
            value={draft}
            disabled={hasKey !== true}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send();
            }}
            placeholder="Ask about this request…"
            className="flex-1 rounded-sm border border-border bg-bg px-2.5 py-1.5 text-xs text-text disabled:opacity-60"
          />
          <button
            aria-label="Send message"
            disabled={hasKey !== true || sending}
            onClick={() => void send()}
            className="rounded-sm bg-accent px-2.5 text-xs font-bold text-accent-on disabled:opacity-60"
          >
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}
