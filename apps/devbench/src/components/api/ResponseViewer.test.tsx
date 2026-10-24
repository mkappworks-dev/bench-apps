import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResponseViewer } from "./ResponseViewer";

describe("ResponseViewer", () => {
  it("shows nothing before a request has been sent", () => {
    render(<ResponseViewer result={null} />);
    expect(screen.queryByText(/status/i)).not.toBeInTheDocument();
  });

  it("shows status code, duration, and body after a response", () => {
    render(
      <ResponseViewer
        result={{ status_code: 200, headers: [], body: '{"id":8841}', duration_ms: 142 }}
      />,
    );
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("142ms")).toBeInTheDocument();
    expect(screen.getByText('{"id":8841}')).toBeInTheDocument();
  });

  it("shows response headers on the Headers tab", () => {
    render(
      <ResponseViewer
        result={{
          status_code: 200,
          headers: [{ key: "content-type", value: "application/json" }],
          body: "{}",
          duration_ms: 5,
        }}
      />,
    );
    fireEvent.click(screen.getByText("Headers"));
    expect(screen.getByText("content-type")).toBeInTheDocument();
    expect(screen.getByText("application/json")).toBeInTheDocument();
  });

  it("shows a read-only Sent disclosure only when sentRequest is provided", () => {
    render(
      <ResponseViewer
        result={{ status_code: 201, headers: [], body: "{}", duration_ms: 5 }}
        sentRequest={{
          method: "POST",
          url: "/api/orders",
          headers: [{ key: "Content-Type", value: "application/json" }],
          body: '{"a":1}',
        }}
      />,
    );
    expect(screen.getByText(/Sent: POST \/api\/orders/)).toBeInTheDocument();
  });

  it("shows no Sent disclosure for a live response with no sentRequest", () => {
    render(<ResponseViewer result={{ status_code: 200, headers: [], body: "{}", duration_ms: 5 }} />);
    expect(screen.queryByText(/^Sent:/)).not.toBeInTheDocument();
  });
});


describe("Response inspection", () => {
  const result = { status_code: 201, headers: [{ key: "set-cookie", value: "a=1" }, { key: "set-cookie", value: "b=2" }], body: "", duration_ms: 5 };
  it("exposes keyboard response tabs and preserves repeated headers", async () => {
    render(<ResponseViewer result={result} />);
    expect(screen.getByText("Response")).toBeInTheDocument();
    expect(screen.getByText("Empty response body.")).toBeInTheDocument();
    const list = screen.getByRole("tablist", { name: "Response format" });
    const body = within(list).getByRole("tab", { name: "Body" });
    body.focus();
    fireEvent.keyDown(body, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Headers" })).toBeVisible());
    expect(screen.getAllByText("set-cookie")).toHaveLength(2);
    expect(screen.getByText("a=1")).toBeInTheDocument();
    expect(screen.getByText("b=2")).toBeInTheDocument();
  });
  it("counts a history body's UTF-8 bytes", () => {
    render(<ResponseViewer result={result} sentRequest={{ method: "POST", url: "/orders", headers: [], body: "é🙂" }} />);
    expect(screen.getByText(/6B body/)).toBeInTheDocument();
  });
  it("isolates tab relationships between response viewers", () => {
    render(<><ResponseViewer result={result} /><ResponseViewer result={result} /></>);
    const tabs = screen.getAllByRole("tab", { name: "Body" });
    const panels = screen.getAllByRole("tabpanel", { name: "Body" });
    expect(tabs[0].id).not.toBe(tabs[1].id);
    panels.forEach((panel, i) => expect(panel).toHaveAttribute("aria-labelledby", tabs[i].id));
  });
  it.each([201, 302, 404, 500])("keeps status %i explicit", (status_code) => {
    render(<ResponseViewer result={{ ...result, status_code }} />);
    expect(screen.getByText(String(status_code))).toBeInTheDocument();
  });
});
