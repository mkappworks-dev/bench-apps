import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LogTab } from "./LogTab";

vi.mock("../../lib/tauri", () => ({
  invokeListLogSources: vi.fn(async () => []),
  invokeReadLogLines: vi.fn(async () => ({ lines: [], next_id: 0, dropped: 0 })),
  invokeAddLogSource: vi.fn(async () => ({})),
  invokeRemoveLogSource: vi.fn(async () => {}),
  invokeSearchLogLines: vi.fn(async () => []),
}));

import { invokeSearchLogLines, invokeReadLogLines } from "../../lib/tauri";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => {} };
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LogTab", () => {
  it("renders the live tail in live mode", () => {
    render(<LogTab sourceId={null} mode="live" onPatchState={() => {}} />);
    expect(screen.getByPlaceholderText("Filter…")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search history…")).not.toBeInTheDocument();
  });

  it("renders the search UI in search mode", () => {
    render(<LogTab sourceId={null} mode="search" onPatchState={() => {}} />);
    expect(screen.getByPlaceholderText("Search history…")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Filter…")).not.toBeInTheDocument();
  });

  // The mode toggle and SearchBar's submit button both read "Search" on
  // screen, so the toggle is named "<mode> mode" for assistive tech — and
  // that is what disambiguates the two here.
  it("persists the mode to tab state when toggled", () => {
    const onPatchState = vi.fn();
    render(<LogTab sourceId={null} mode="live" onPatchState={onPatchState} />);
    fireEvent.click(screen.getByRole("button", { name: "Search mode" }));
    expect(onPatchState).toHaveBeenCalledWith({ mode: "search" });
  });

  it("does not poll the live tail while in search mode", async () => {
    render(<LogTab sourceId={null} mode="search" onPatchState={() => {}} />);
    await new Promise((r) => setTimeout(r, 60));
    expect(invokeReadLogLines).not.toHaveBeenCalled();
  });

  it("passes the current source and query through to the backend search", async () => {
    render(<LogTab sourceId="src1" mode="search" onPatchState={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Search history…"), {
      target: { value: "refused" },
    });
    fireEvent.change(screen.getByLabelText("Minimum level"), { target: { value: "WARN" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(invokeSearchLogLines).toHaveBeenCalledWith(
        expect.objectContaining({ query: "refused", level: "WARN", sourceId: "src1" }),
      );
    });
  });

  it("searches every source when none is selected", async () => {
    render(<LogTab sourceId={null} mode="search" onPatchState={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(invokeSearchLogLines).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: undefined }),
      );
    });
  });

  it("surfaces a search failure", async () => {
    vi.mocked(invokeSearchLogLines).mockRejectedValueOnce(new Error("disk full"));
    render(<LogTab sourceId={null} mode="search" onPatchState={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(screen.getByText(/disk full/)).toBeInTheDocument();
    });
  });
});
