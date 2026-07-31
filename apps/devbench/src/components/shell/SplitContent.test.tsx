import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { SplitContent } from "./SplitContent";
import { useAppStore } from "../../store/useAppStore";

function renderSplit() {
  return render(
    <SplitContent
      dbFocusTable={null}
      emailFocusId={null}
      onOpenTableInDb={() => {}}
      onOpenEmail={() => {}}
    />,
  );
}

describe("SplitContent", () => {
  beforeEach(() => {
    useAppStore.getState().setSplitOpen(false);
    useAppStore.getState().setActiveTab("api");
    useAppStore.getState().setSecondaryTab("db");
  });

  // The tab bars moved up into AppStrip so they could align with the panes they
  // control. SplitContent renders panes and nothing else.
  it("renders no tab bar or split control of its own", () => {
    renderSplit();
    expect(screen.queryAllByRole("tablist")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^split$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close split/i })).not.toBeInTheDocument();
  });

  it("renders one pane when not split", () => {
    renderSplit();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("renders two panes when split, one per tool", () => {
    useAppStore.getState().setSplitOpen(true);
    renderSplit();
    expect(screen.getAllByRole("main")).toHaveLength(2);
  });
});
