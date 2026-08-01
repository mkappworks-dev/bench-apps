import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GeneralPane } from "./GeneralPane";
import * as tauriLib from "../../lib/tauri";

const settings = {
  theme: "dark",
  correlation_window_ms: 5000,
  smtp_port: 1025,
  provider: "anthropic",
  model: "claude-opus-5",
  active_session_id: null,
};

describe("GeneralPane", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue(settings);
    vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);
  });

  it("shows the stored values", async () => {
    render(<GeneralPane />);
    await waitFor(() => expect(screen.getByLabelText(/correlation window/i)).toHaveValue(5));
    expect(screen.getByLabelText(/smtp port/i)).toHaveValue(1025);
  });

  it("persists the correlation window in milliseconds while showing seconds", async () => {
    render(<GeneralPane />);
    await waitFor(() => screen.getByLabelText(/correlation window/i));
    fireEvent.change(screen.getByLabelText(/correlation window/i), { target: { value: "12" } });
    fireEvent.blur(screen.getByLabelText(/correlation window/i));
    await waitFor(() =>
      expect(tauriLib.invokeSetSetting).toHaveBeenCalledWith("correlation_window_ms", "12000"),
    );
  });

  it("rejects an out-of-range correlation window instead of storing it", async () => {
    render(<GeneralPane />);
    await waitFor(() => screen.getByLabelText(/correlation window/i));
    fireEvent.change(screen.getByLabelText(/correlation window/i), { target: { value: "999" } });
    fireEvent.blur(screen.getByLabelText(/correlation window/i));
    await waitFor(() => expect(screen.getByText(/between 1 and 60 seconds/i)).toBeInTheDocument());
    expect(tauriLib.invokeSetSetting).not.toHaveBeenCalledWith("correlation_window_ms", "999000");
  });

  // The catcher binds once at startup; saying otherwise would be a lie the
  // user only discovers when no mail arrives.
  it("says an SMTP port change takes effect on restart", async () => {
    render(<GeneralPane />);
    await waitFor(() => expect(screen.getByText(/takes effect the next time devbench starts/i)).toBeInTheDocument());
  });
});
