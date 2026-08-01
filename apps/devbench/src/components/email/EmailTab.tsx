import { useCallback, useEffect, useRef, useState } from "react";
import { EmailInbox } from "./EmailInbox";
import { EmailViewer } from "./EmailViewer";
import { useAppStore } from "../../store/useAppStore";
import {
  invokeClearEmails,
  invokeGetEmail,
  invokeListEmails,
  invokeSmtpStatus,
  type CapturedEmail,
  type EmailSummary,
  type SmtpStatus,
} from "../../lib/tauri";

/** How often the inbox is refreshed. Mail is far rarer than log lines. */
const POLL_INTERVAL_MS = 1_000;
/** Matches the backend's global retention cap (`MAX_CAPTURED_EMAILS`). */
const LIST_LIMIT = 5_000;

export function EmailTab({ focusEmailId = null }: { focusEmailId?: number | null }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [evictedThroughId, setEvictedThroughId] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<CapturedEmail | null>(null);
  const [status, setStatus] = useState<SmtpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The live session. A poll tick started under session A can resolve after
  // the user has switched to B; comparing against this ref (not the tick's
  // closed-over value) is what lets that resolution be dropped. Same
  // approach as ApiTab.tsx's `belongsToCurrentSession`.
  const activeSessionIdRef = useRef(activeSessionId);

  // Switching sessions must not leave a previous session's selected email
  // sitting in the viewer — same rationale as ApiTab.tsx's clear-on-switch.
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    setSelectedId(null);
  }, [activeSessionId]);

  const refresh = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    try {
      const result = await invokeListEmails(activeSessionId, LIST_LIMIT);
      if (activeSessionIdRef.current !== requestedSessionId) return;
      setEmails(result.emails);
      setEvictedThroughId(result.evicted_through_id);
    } catch {
      // A transient IPC failure is not worth tearing the pane down.
    }
  }, [activeSessionId]);

  useEffect(() => {
    invokeSmtpStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (focusEmailId !== null) setSelectedId(focusEmailId);
  }, [focusEmailId]);

  useEffect(() => {
    if (selectedId === null) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    invokeGetEmail(selectedId)
      .then((full) => {
        if (!cancelled) {
          setSelected(full);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSelected(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function handleClear() {
    try {
      await invokeClearEmails(activeSessionId);
      setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="-m-6 flex h-full flex-col">
      <div className="flex flex-1 overflow-hidden">
        <EmailInbox
          emails={emails}
          evictedThroughId={evictedThroughId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onClear={handleClear}
        />
        <div className="flex-1 overflow-hidden">
          {error ? (
            <div className="m-4 rounded-lg border border-border bg-danger-bg p-3 text-sm text-danger">{error}</div>
          ) : (
            <EmailViewer email={selected} />
          )}
        </div>
      </div>
      <div className="border-t border-border px-4 py-2 text-xs text-text-muted">
        {status === null ? (
          "Checking SMTP catcher…"
        ) : status.listening ? (
          <>
            Listening on <b className="text-text">localhost:{status.port}</b> — point your backend's SMTP
            config here.
          </>
        ) : (
          <span className="text-danger">
            SMTP catcher is not running{status.error ? `: ${status.error}` : ""}. No mail is being caught.
          </span>
        )}
      </div>
    </div>
  );
}
