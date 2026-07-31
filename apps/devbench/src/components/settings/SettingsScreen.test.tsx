import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SettingsScreen } from "./SettingsScreen";
import * as tauriLib from "../../lib/tauri";

const settings = {
  theme: "dark",
  correlation_window_ms: 5000,
  smtp_port: 1025,
  provider: "anthropic",
  model: "claude-opus-5",
  active_session_id: null,
};

describe("SettingsScreen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(settings);
    vi.spyOn(tauriLib, "invokeListArchivedSessions").mockResolvedValue([]);
    vi.spyOn(tauriLib, "invokeGetProviderStatus").mockResolvedValue({ has_key: false, provider: "anthropic", model: "claude-opus-5" });
    vi.spyOn(tauriLib, "invokeListMcpServers").mockResolvedValue([]);
  });

  it("offers the five settings sections from the spec", async () => {
    render(<SettingsScreen onBack={() => {}} />);
    await waitFor(() => screen.getByRole("heading", { name: "General" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "General",
      "Appearance",
      "Provider",
      "MCP",
      "Archive",
    ]);
  });

  it("starts on General", async () => {
    render(<SettingsScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument());
  });

  it("switches panes", async () => {
    render(<SettingsScreen onBack={() => {}} />);
    await waitFor(() => screen.getByRole("heading", { name: "General" }));
    fireEvent.click(screen.getByRole("tab", { name: "Provider" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Provider" })).toBeInTheDocument());
  });

  it("navigates back to the workspace", async () => {
    const onBack = vi.fn();
    render(<SettingsScreen onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back to devbench/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
