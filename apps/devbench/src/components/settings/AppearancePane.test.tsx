import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as tauriLib from "../../lib/tauri";
import { AppearancePane } from "./AppearancePane";
import { useAppStore } from "../../store/useAppStore";

describe("AppearancePane", () => {
  it("shows the current theme and offers all three options", () => {
    useAppStore.setState({ theme: "dark" });
    render(<AppearancePane />);
    const trigger = screen.getByRole("button", { name: /theme/i });
    expect(trigger).toHaveTextContent("Dark");

    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([
      "System", "Dark", "Light",
    ]);
  });

  // Bug class this guards: a theme change that updates the store but never
  // reaches SQLite looks correct until the next launch, then silently reverts.
  it("persists the theme to settings when changed", async () => {
    useAppStore.setState({ theme: "dark" });
    const setSetting = vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);
    render(<AppearancePane />);

    fireEvent.click(screen.getByRole("button", { name: /theme/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));

    expect(useAppStore.getState().theme).toBe("light");
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("theme", "light"));

    useAppStore.setState({ theme: "dark" });
  });
});
