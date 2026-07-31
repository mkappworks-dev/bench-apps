import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ChatDock } from "./ChatDock";
import * as tauriLib from "../../lib/tauri";

describe("ChatDock", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("prompts for a key when none is stored, instead of failing on send", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: false,
    });
    render(<ChatDock onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/add a provider key in settings/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/ask about this request/i)).toBeDisabled();
  });

  it("sends a message and renders the reply", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    vi.spyOn(tauriLib, "invokeSendChatMessage").mockResolvedValue({
      content: "Three rows changed in orders.",
      tool_calls: [],
    });

    render(<ChatDock onClose={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/ask about this request/i), {
      target: { value: "what happened?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByText("Three rows changed in orders.")).toBeInTheDocument());
    expect(screen.getByText("what happened?")).toBeInTheDocument();
  });

  it("names the MCP tools the assistant used", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    vi.spyOn(tauriLib, "invokeSendChatMessage").mockResolvedValue({
      content: "Done.",
      tool_calls: ["read_file"],
    });
    render(<ChatDock onClose={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/ask about this request/i), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByText(/used read_file/i)).toBeInTheDocument());
  });

  it("shows a send failure without losing the transcript", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    vi.spyOn(tauriLib, "invokeSendChatMessage").mockRejectedValue(new Error("provider returned 401"));
    render(<ChatDock onClose={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/ask about this request/i), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByText(/provider returned 401/)).toBeInTheDocument());
    expect(screen.getByText("hi")).toBeInTheDocument();
  });

  it("closes", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    const onClose = vi.fn();
    render(<ChatDock onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(onClose).toHaveBeenCalled();
  });
});
