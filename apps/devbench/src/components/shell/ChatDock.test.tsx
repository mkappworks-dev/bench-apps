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

  describe("resize", () => {
    // Same reasoning as QueryConsole's resize tests: this exercises the drag
    // clamp arithmetic and the `--w-chat` custom property write, not real
    // layout — there's no getBoundingClientRect here, so unlike DataGrid's
    // virtualization this is honestly assertable under jsdom. It can't prove
    // how the resize *looks*, or that AppStrip's topbar tracks the same
    // property — see the task report for how those were checked in a browser.
    beforeEach(() => {
      vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
        provider: "anthropic",
        model: "claude-opus-5",
        has_key: true,
      });
    });

    function currentWidth(): string {
      return document.documentElement.style.getPropertyValue("--w-chat");
    }

    it("tracks the raw drag delta between both bounds", async () => {
      render(<ChatDock onClose={() => {}} />);
      await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
      const handle = screen.getByLabelText("Resize AI Assistant");

      expect(currentWidth()).toBe("320px"); // DEFAULT_WIDTH_PX

      fireEvent.mouseDown(handle, { clientX: 500 });
      fireEvent.mouseMove(window, { clientX: 400 }); // dragged left 100px -> wider: 320+100=420
      expect(currentWidth()).toBe("420px");
      fireEvent.mouseMove(window, { clientX: 550 }); // dragged right 50px from the start -> narrower: 320-50=270
      expect(currentWidth()).toBe("270px");
    });

    it("clamps at MIN_WIDTH_PX when dragged past the right", async () => {
      render(<ChatDock onClose={() => {}} />);
      await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
      const handle = screen.getByLabelText("Resize AI Assistant");

      fireEvent.mouseDown(handle, { clientX: 500 });
      fireEvent.mouseMove(window, { clientX: 900 }); // narrower by 400: 320-400=-80, below the 260 min
      expect(currentWidth()).toBe("260px");
      fireEvent.mouseMove(window, { clientX: 1200 }); // even further past the min
      expect(currentWidth()).toBe("260px");
    });

    it("clamps at MAX_WIDTH_PX when dragged past the left", async () => {
      render(<ChatDock onClose={() => {}} />);
      await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
      const handle = screen.getByLabelText("Resize AI Assistant");

      fireEvent.mouseDown(handle, { clientX: 500 });
      fireEvent.mouseMove(window, { clientX: 100 }); // wider by 400: 320+400=720, above the 640 max
      expect(currentWidth()).toBe("640px");
      fireEvent.mouseMove(window, { clientX: -200 }); // even further past the max
      expect(currentWidth()).toBe("640px");
    });

    it("stops resizing once the mouse is released", async () => {
      render(<ChatDock onClose={() => {}} />);
      await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
      const handle = screen.getByLabelText("Resize AI Assistant");

      fireEvent.mouseDown(handle, { clientX: 500 });
      fireEvent.mouseMove(window, { clientX: 400 });
      expect(currentWidth()).toBe("420px");

      fireEvent.mouseUp(window);
      fireEvent.mouseMove(window, { clientX: 100 }); // a mousemove with no active drag must be a no-op
      expect(currentWidth()).toBe("420px");
    });

    it("clears --w-chat on unmount, so a reopen starts back at the default", async () => {
      const { unmount } = render(<ChatDock onClose={() => {}} />);
      await waitFor(() => expect(screen.getByPlaceholderText(/ask about this request/i)).toBeEnabled());
      const handle = screen.getByLabelText("Resize AI Assistant");
      fireEvent.mouseDown(handle, { clientX: 500 });
      fireEvent.mouseMove(window, { clientX: 400 });
      expect(currentWidth()).toBe("420px");

      unmount();
      expect(currentWidth()).toBe("");
    });
  });
});
