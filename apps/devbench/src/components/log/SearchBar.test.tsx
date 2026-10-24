import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchBar, type SearchQuery } from "./SearchBar";

const EMPTY: SearchQuery = { query: "", level: "", afterMs: null, beforeMs: null };

describe("SearchBar", () => {
  it("reports a typed query", () => {
    const onChange = vi.fn();
    render(<SearchBar value={EMPTY} onChange={onChange} onSubmit={() => {}} busy={false} />);
    fireEvent.change(screen.getByPlaceholderText("Search history…"), {
      target: { value: "refused" },
    });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, query: "refused" });
  });

  it("offers minimum-severity levels, not exact chips", () => {
    render(<SearchBar value={EMPTY} onChange={() => {}} onSubmit={() => {}} busy={false} />);
    const select = screen.getByLabelText("Minimum level");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "WARN and above" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Any level" })).toBeInTheDocument();
  });

  it("reports a chosen minimum level", () => {
    const onChange = vi.fn();
    render(<SearchBar value={EMPTY} onChange={onChange} onSubmit={() => {}} busy={false} />);
    fireEvent.change(screen.getByLabelText("Minimum level"), { target: { value: "ERROR" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, level: "ERROR" });
  });

  it("submits on click", () => {
    const onSubmit = vi.fn();
    render(<SearchBar value={EMPTY} onChange={() => {}} onSubmit={onSubmit} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("submits on Enter in the query field", () => {
    const onSubmit = vi.fn();
    render(<SearchBar value={EMPTY} onChange={() => {}} onSubmit={onSubmit} busy={false} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Search history…"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalled();
  });

  it("disables the button while a search is in flight", () => {
    render(<SearchBar value={EMPTY} onChange={() => {}} onSubmit={() => {}} busy={true} />);
    expect(screen.getByRole("button", { name: "Searching…" })).toBeDisabled();
  });

  it("reports a time bound as epoch milliseconds", () => {
    const onChange = vi.fn();
    render(<SearchBar value={EMPTY} onChange={onChange} onSubmit={() => {}} busy={false} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-02T10:00" } });
    const next = onChange.mock.calls[0][0] as SearchQuery;
    expect(next.afterMs).toBe(new Date("2026-08-02T10:00").getTime());
  });

  it("clears a time bound back to null when emptied", () => {
    const onChange = vi.fn();
    render(
      <SearchBar
        value={{ ...EMPTY, afterMs: 1_000 }}
        onChange={onChange}
        onSubmit={() => {}}
        busy={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });
    expect((onChange.mock.calls[0][0] as SearchQuery).afterMs).toBeNull();
  });
});
