import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StartupErrorScreen } from "./StartupErrorScreen";

describe("StartupErrorScreen", () => {
  it("shows the db path, both remedies, and the sqlx error verbatim", () => {
    render(
      <StartupErrorScreen
        error={{
          db_path: "/tmp/devbench-test/devbench.db",
          error: "migration 5 was previously applied but has been modified",
        }}
      />,
    );

    expect(screen.getByText(/couldn't start/i)).toBeInTheDocument();
    expect(screen.getByText("/tmp/devbench-test/devbench.db")).toBeInTheDocument();
    expect(screen.getByText(/DEVBENCH_DATA_DIR/)).toBeInTheDocument();
    expect(screen.getByText(/move or rename/i)).toBeInTheDocument();
    expect(
      screen.getByText("migration 5 was previously applied but has been modified"),
    ).toBeInTheDocument();
  });
});
