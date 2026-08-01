import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmailViewer } from "./EmailViewer";
import type { CapturedEmail } from "../../lib/tauri";

const email: CapturedEmail = {
  id: 1,
  captured_at_ms: 1_800_000_000_000,
  from: "orders@shop.test",
  to: ["customer@example.com"],
  subject: "Order confirmation #8841",
  size_bytes: 300,
  html_body: "<h2>Thanks for your order.</h2>",
  text_body: "Thanks for your order.",
  raw: "Subject: Order confirmation #8841\r\nFrom: orders@shop.test\r\n\r\nThanks for your order.\r\n",
  request_id: null,
  request_method: null,
  request_url: null,
};

describe("EmailViewer", () => {
  it("prompts when nothing is selected", () => {
    render(<EmailViewer email={null} />);
    expect(screen.getByText(/select a message/i)).toBeInTheDocument();
  });

  it("shows the subject and the envelope from/to", () => {
    render(<EmailViewer email={email} />);
    expect(screen.getByText("Order confirmation #8841")).toBeInTheDocument();
    expect(screen.getByText(/orders@shop\.test/)).toBeInTheDocument();
    expect(screen.getByText(/customer@example\.com/)).toBeInTheDocument();
  });

  // Captured HTML is untrusted and the webview has `invoke` on `window`.
  // It must never reach the app's own DOM.
  it("renders HTML inside a fully sandboxed iframe, never inline", () => {
    render(<EmailViewer email={email} />);
    const frame = screen.getByTitle("Email HTML body");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain("<h2>Thanks for your order.</h2>");
    expect(document.querySelector("h2")).toBeNull();
  });

  it("switches to the plain-text view", () => {
    render(<EmailViewer email={email} />);
    fireEvent.click(screen.getByRole("tab", { name: "Plain" }));
    expect(screen.getByText("Thanks for your order.")).toBeInTheDocument();
  });

  it("switches to the raw view", () => {
    render(<EmailViewer email={email} />);
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByTestId("email-raw").textContent).toContain("Subject: Order confirmation #8841");
  });

  it("shows only the header block in the headers view", () => {
    render(<EmailViewer email={email} />);
    fireEvent.click(screen.getByRole("tab", { name: "Headers" }));
    const headers = screen.getByTestId("email-headers").textContent ?? "";
    expect(headers).toContain("From: orders@shop.test");
    expect(headers).not.toContain("Thanks for your order.");
  });

  it("says so when a message has no HTML part rather than showing a blank frame", () => {
    render(<EmailViewer email={{ ...email, html_body: null }} />);
    expect(screen.getByText(/no html part/i)).toBeInTheDocument();
  });
});

describe("EmailViewer — Sent by link", () => {
  const linkedEmail: CapturedEmail = {
    id: 1,
    captured_at_ms: 1_800_000_000_000,
    from: "orders@shop.test",
    to: ["customer@example.com"],
    subject: "Order confirmation #8841",
    size_bytes: 512,
    html_body: "<p>Thanks!</p>",
    text_body: "Thanks!",
    raw: "Subject: Order confirmation #8841\r\n\r\nThanks!",
    request_id: "hist-1",
    request_method: "POST",
    request_url: "/api/checkout",
  };

  it("shows the Sent by chip when the email is linked to a request", () => {
    render(<EmailViewer email={linkedEmail} />);
    expect(screen.getByText(/Sent by/)).toBeInTheDocument();
    expect(screen.getByText("POST /api/checkout")).toBeInTheDocument();
  });

  it("calls onOpenHistory with the request id when the chip is clicked", () => {
    const onOpenHistory = vi.fn();
    render(<EmailViewer email={linkedEmail} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByText(/Sent by/));
    expect(onOpenHistory).toHaveBeenCalledWith("hist-1");
  });

  it("shows no Sent by chip when the email has no linked request", () => {
    const unlinked: CapturedEmail = { ...linkedEmail, request_id: null, request_method: null, request_url: null };
    render(<EmailViewer email={unlinked} />);
    expect(screen.queryByText(/Sent by/)).not.toBeInTheDocument();
  });

  // getByText only concatenates a node's direct text-node children, so it can't
  // see whitespace dropped between the <b> and <span> siblings — check the full
  // textContent instead, which is what a screen reader's accessible name reflects.
  it("keeps a space between the request and the arrow in the chip text", () => {
    render(<EmailViewer email={linkedEmail} />);
    const chip = screen.getByRole("button", { name: /Sent by/ });
    expect(chip.textContent).toBe("Sent by POST /api/checkout → view in History");
  });
});
