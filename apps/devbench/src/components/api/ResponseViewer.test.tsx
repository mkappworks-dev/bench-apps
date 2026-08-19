import { render, screen, fireEvent } from "@testing-library/react";
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
