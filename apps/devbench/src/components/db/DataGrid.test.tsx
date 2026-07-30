import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataGrid } from "./DataGrid";

describe("DataGrid", () => {
  it("renders column headers and row cells", () => {
    render(
      <DataGrid
        columns={["id", "status"]}
        rows={[["8841", "pending"], ["8840", "shipped"]]}
      />,
    );
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("8841")).toBeInTheDocument();
    expect(screen.getByText("shipped")).toBeInTheDocument();
  });
});
