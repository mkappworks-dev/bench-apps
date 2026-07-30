import { render, screen } from "@testing-library/react";
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
        result={{ status_code: 200, body: '{"id":8841}', duration_ms: 142 }}
      />,
    );
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("142ms")).toBeInTheDocument();
    expect(screen.getByText('{"id":8841}')).toBeInTheDocument();
  });
});
