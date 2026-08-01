import { render, screen, fireEvent } from "@testing-library/react";
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
