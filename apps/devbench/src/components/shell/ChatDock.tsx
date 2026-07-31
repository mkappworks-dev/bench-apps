import { useEffect, useState } from "react";
import {
  invokeGetProviderStatus,
  invokeSendChatMessage,
  type ChatMessage,
} from "../../lib/tauri";

interface Turn extends ChatMessage {
  toolCalls?: string[];
}

export function ChatDock({ onClose }: { onClose: () => void }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invokeGetProviderStatus()
      .then((s) => setHasKey(s.has_key))
      .catch(() => setHasKey(false));
  }, []);

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
    <aside aria-label="AI Assistant" className="flex w-[var(--w-chat)] min-w-[var(--w-chat)] flex-col border-l border-border">
      <div className="flex items-center justify-between border-b border-border p-2.5">
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
    </aside>
  );
}
