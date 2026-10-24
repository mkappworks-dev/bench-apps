import { useState } from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequestTabs } from "./RequestTabs";
import { DEFAULT_AUTH } from "./AuthEditor";

const baseProps = {
  activeTab: "headers" as const,
  onTabChange: vi.fn(),
  params: [],
  onParamsChange: vi.fn(),
  headers: [],
  onHeadersChange: vi.fn(),
  body: "",
  bodyType: "none" as const,
  onBodyChange: vi.fn(),
  onBodyTypeChange: vi.fn(),
  auth: DEFAULT_AUTH,
  onAuthChange: vi.fn(),
};

describe("RequestTabs", () => {
  it("shows the Headers panel when activeTab is headers", () => {
    render(<RequestTabs {...baseProps} />);
    expect(screen.getByText("No headers set.")).toBeInTheDocument();
  });

  it("shows the Params panel when activeTab is params", () => {
    render(<RequestTabs {...baseProps} activeTab="params" />);
    expect(screen.getByText(/No query params/)).toBeInTheDocument();
  });

  it("shows the Body panel when activeTab is body", () => {
    render(<RequestTabs {...baseProps} activeTab="body" />);
    expect(screen.getByLabelText("Body type")).toBeInTheDocument();
  });

  it("shows the Auth panel when activeTab is auth", () => {
    render(<RequestTabs {...baseProps} activeTab="auth" />);
    expect(screen.getByLabelText("Auth type")).toBeInTheDocument();
  });

  it("calls onTabChange when a tab is clicked", () => {
    const onTabChange = vi.fn();
    render(<RequestTabs {...baseProps} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText("Body"));
    expect(onTabChange).toHaveBeenCalledWith("body");
  });
});


describe("Request tabs keyboard contract", () => {
  function ComposerTabs() {
    const [activeTab, onTabChange] = useState<"params" | "headers" | "body" | "auth">("headers");
    return <RequestTabs {...baseProps} activeTab={activeTab} onTabChange={onTabChange} />;
  }
  it("selects panels with keyboard navigation", async () => {
    render(<ComposerTabs />);
    const list = screen.getByRole("tablist", { name: "Request" });
    const headers = within(list).getByRole("tab", { name: "Headers" });
    headers.focus();
    fireEvent.keyDown(headers, { key: "ArrowRight" });
    await waitFor(() => expect(within(list).getByRole("tab", { name: "Body" })).toHaveFocus());
    expect(screen.getByRole("tabpanel", { name: "Body" })).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Params" })).toBeVisible());
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Auth" })).toBeVisible());
  });
  it("gives separate composer instances distinct tab-panel relationships", () => {
    render(<><ComposerTabs /><ComposerTabs /></>);
    const tabs = screen.getAllByRole("tab", { name: "Headers" });
    const panels = screen.getAllByRole("tabpanel", { name: "Headers" });
    expect(tabs[0].id).not.toBe(tabs[1].id);
    panels.forEach((panel, index) => expect(panel).toHaveAttribute("aria-labelledby", tabs[index].id));
  });
});
