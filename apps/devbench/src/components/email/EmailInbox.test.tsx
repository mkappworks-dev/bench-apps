import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmailInbox } from "./EmailInbox";
import type { EmailSummary } from "../../lib/tauri";

const emails: EmailSummary[] = [
  {
    id: 2,
    captured_at_ms: 1_800_000_000_000,
    from: "orders@shop.test",
    to: ["customer@example.com"],
    subject: "Order confirmation #8841",
    size_bytes: 512,
  },
  {
    id: 1,
    captured_at_ms: 1_700_000_000_000,
    from: "hello@shop.test",
    to: ["cus_2290@example.com"],
    subject: "Welcome to the beta",
    size_bytes: 256,
  },
];

describe("EmailInbox", () => {
  it("lists subjects and senders", () => {
    render(<EmailInbox emails={emails} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText("Order confirmation #8841")).toBeInTheDocument();
    expect(screen.getByText("orders@shop.test")).toBeInTheDocument();
  });

  it("marks the selected message", () => {
    render(<EmailInbox emails={emails} selectedId={2} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByRole("button", { name: /Order confirmation/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Welcome to the beta/ })).toHaveAttribute("aria-current", "false");
  });

  it("selects a message when clicked", () => {
    const onSelect = vi.fn();
    render(<EmailInbox emails={emails} selectedId={null} onSelect={onSelect} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Welcome to the beta/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("shows an empty state that explains the SMTP setup", () => {
    render(<EmailInbox emails={[]} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText(/point your backend's SMTP/i)).toBeInTheDocument();
  });

  it("clears the inbox", () => {
    const onClear = vi.fn();
    render(<EmailInbox emails={emails} selectedId={null} onSelect={() => {}} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear inbox" }));
    expect(onClear).toHaveBeenCalled();
  });
});
