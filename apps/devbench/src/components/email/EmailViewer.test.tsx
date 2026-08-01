import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
