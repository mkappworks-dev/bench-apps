import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EmailTab } from "./EmailTab";
import { useAppStore } from "../../store/useAppStore";
import * as tauriLib from "../../lib/tauri";
import type { CapturedEmail, ListEmailsResult } from "../../lib/tauri";

/** A promise whose settlement this test controls, standing in for a slow backend call. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function emailList(id: number, subject: string): ListEmailsResult {
  return {
    emails: [
      {
        id,
        captured_at_ms: 1_800_000_000_000,
        from: "sender@shop.test",
        to: ["customer@example.com"],
        subject,
        size_bytes: 128,
      },
    ],
    evicted_through_id: 0,
  };
}

const fullEmail: CapturedEmail = {
  id: 1,
  captured_at_ms: 1_800_000_000_000,
  from: "sender@shop.test",
  to: ["customer@example.com"],
  subject: "A's message",
  size_bytes: 128,
  html_body: null,
  text_body: "hi",
  raw: "Subject: A's message\r\n\r\nhi",
  request_id: null,
};

describe("EmailTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.getState().setActiveSessionId(null);
  });

  // A poll tick started under one session can resolve after the user has
  // already moved to another; unguarded, its stale result overwrites the new
  // session's already-painted inbox.
  it("drops an email list fetch that resolves after the session it was fired in was left", async () => {
    const listA = deferred<ListEmailsResult>();
    const listB = deferred<ListEmailsResult>();
    vi.spyOn(tauriLib, "invokeListEmails")
      .mockReturnValueOnce(listA.promise)
      .mockReturnValueOnce(listB.promise);

    render(<EmailTab />);

    act(() => useAppStore.getState().setActiveSessionId("sess-b"));

    // The newer session's fetch resolves first.
    await act(async () => {
      listB.resolve(emailList(2, "B's message"));
      await listB.promise;
    });
    expect(screen.getByText("B's message")).toBeInTheDocument();

    // The older, slower session's fetch resolves after — it must be dropped.
    await act(async () => {
      listA.resolve(emailList(1, "A's message"));
      await listA.promise;
    });

    expect(screen.getByText("B's message")).toBeInTheDocument();
    expect(screen.queryByText("A's message")).not.toBeInTheDocument();
  });

  // Same root cause as the fetch race: leaving a previous session's open
  // message in the viewer would show mail attributed to an inbox no longer
  // on screen.
  it("clears the selected email when the active session changes", async () => {
    vi.spyOn(tauriLib, "invokeListEmails").mockResolvedValue(emailList(1, "A's message"));
    vi.spyOn(tauriLib, "invokeGetEmail").mockResolvedValue(fullEmail);

    render(<EmailTab />);

    fireEvent.click(await screen.findByRole("button", { name: /A's message/ }));
    await waitFor(() => expect(screen.getByText(/from sender@shop\.test/)).toBeInTheDocument());

    act(() => useAppStore.getState().setActiveSessionId("sess-b"));

    await waitFor(() => expect(screen.getByText(/select a message/i)).toBeInTheDocument());
  });
});
