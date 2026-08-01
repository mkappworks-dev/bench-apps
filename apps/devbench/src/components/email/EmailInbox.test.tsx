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
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText("Order confirmation #8841")).toBeInTheDocument();
    expect(screen.getByText("orders@shop.test")).toBeInTheDocument();
  });

  it("marks the selected message", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={2} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByRole("button", { name: /Order confirmation/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Welcome to the beta/ })).toHaveAttribute("aria-current", "false");
  });

  it("selects a message when clicked", () => {
    const onSelect = vi.fn();
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={onSelect} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Welcome to the beta/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("shows an empty state that explains the SMTP setup", () => {
    render(<EmailInbox emails={[]} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText(/point your backend's SMTP/i)).toBeInTheDocument();
  });

  it("clears the inbox", () => {
    const onClear = vi.fn();
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear inbox" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("filters the list by subject", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Filter by subject or address/i), { target: { value: "beta" } });
    expect(screen.getByText("Welcome to the beta")).toBeInTheDocument();
    expect(screen.queryByText("Order confirmation #8841")).not.toBeInTheDocument();
  });

  it("filters the list by sender address", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Filter by subject or address/i), {
      target: { value: "orders@shop.test" },
    });
    expect(screen.getByText("Order confirmation #8841")).toBeInTheDocument();
    expect(screen.queryByText("Welcome to the beta")).not.toBeInTheDocument();
  });

  it("says so when no message matches the filter", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Filter by subject or address/i), {
      target: { value: "nonexistent" },
    });
    expect(screen.getByText("No messages match your filter.")).toBeInTheDocument();
  });

  // `evictedThroughId` is a high-water id, not a row count (it stops agreeing
  // with "how many" the moment ids aren't contiguous, e.g. after a clear), so
  // the footer must say evictions happened without asserting a specific
  // number.
  it("notes that earlier messages were evicted, without stating a count", () => {
    render(<EmailInbox emails={emails} evictedThroughId={212} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.getByText(/older messages were evicted/i)).toBeInTheDocument();
    expect(screen.queryByText(/212/)).not.toBeInTheDocument();
  });

  it("does not show an eviction note when nothing has been evicted", () => {
    render(<EmailInbox emails={emails} evictedThroughId={0} selectedId={null} onSelect={() => {}} onClear={() => {}} />);
    expect(screen.queryByText(/earlier evicted/)).not.toBeInTheDocument();
  });
});
