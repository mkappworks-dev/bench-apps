import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ProviderPane } from "./ProviderPane";
import * as tauriLib from "../../lib/tauri";

describe("ProviderPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);
    vi.spyOn(tauriLib, "invokeSetProviderApiKey").mockResolvedValue(undefined);
    vi.spyOn(tauriLib, "invokeClearProviderApiKey").mockResolvedValue(undefined);
  });

  it("says no key is stored and explains BYOK", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: false,
    });
    render(<ProviderPane />);
    await waitFor(() => expect(screen.getByText(/no key stored/i)).toBeInTheDocument());
    expect(screen.getByText(/never through a devbench server/i)).toBeInTheDocument();
  });

  it("stores a key and never renders it back", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus")
      .mockResolvedValueOnce({ provider: "anthropic", model: "claude-opus-5", has_key: false })
      .mockResolvedValue({ provider: "anthropic", model: "claude-opus-5", has_key: true });

    render(<ProviderPane />);
    await waitFor(() => screen.getByLabelText(/api key/i));
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(tauriLib.invokeSetProviderApiKey).toHaveBeenCalledWith("sk-ant-secret"));
    await waitFor(() => expect(screen.getByText(/key stored in your os keychain/i)).toBeInTheDocument());
    // The input is cleared and the key is never echoed anywhere in the DOM.
    expect(document.body.textContent).not.toContain("sk-ant-secret");
  });

  it("removes a stored key", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    render(<ProviderPane />);
    await waitFor(() => screen.getByRole("button", { name: "Remove key" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(tauriLib.invokeClearProviderApiKey).toHaveBeenCalled());
  });

  it("persists the selected model", async () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    render(<ProviderPane />);
    await waitFor(() => screen.getByRole("button", { name: /model/i }));
    fireEvent.click(screen.getByRole("button", { name: /model/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Claude Haiku 4.5 — fastest" }));
    await waitFor(() => expect(tauriLib.invokeSetSetting).toHaveBeenCalledWith("model", "claude-haiku-4-5"));
  });

  it("uses the styled menu rather than a native select for the model", () => {
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({
      provider: "anthropic",
      model: "claude-opus-5",
      has_key: true,
    });
    const { container } = render(<ProviderPane />);
    expect(container.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: /model/i })).toBeInTheDocument();
  });
});
