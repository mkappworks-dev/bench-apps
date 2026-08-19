import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { InsertPanel } from "./InsertPanel";
import { useAppStore } from "../../store/useAppStore";
import type { ColumnInfo } from "./grid/columnMeta";

const ORDERS = { schema: "public", name: "orders" };

function column(name: string, over: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    udt: "text",
    nullable: true,
    default_expr: null,
    is_identity: false,
    references: null,
    ...over,
  };
}

function renderPanel(columns: ColumnInfo[]) {
  return render(
    <InsertPanel target={{ connectionId: "c1", table: ORDERS, columns }} onClose={() => {}} />,
  );
}

describe("InsertPanel", () => {
  beforeEach(() => {
    useAppStore.getState().discardAllPending();
  });

  // Spec §9: visible so the shape of the row is honest, but not editable.
  it("renders a database-assigned column read-only and says who assigns it", () => {
    renderPanel([column("id", { is_identity: true, nullable: false })]);
    const field = screen.getByLabelText(/^id/) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(screen.getByText(/assigned by the database/i)).toBeTruthy();
  });

  it("requires a NOT NULL column with no default, and blocks Save until it is filled", () => {
    renderPanel([column("status", { nullable: false })]);
    const save = screen.getByRole("button", { name: /stage insert/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
    expect((screen.getByRole("button", { name: /stage insert/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  // Spec §9: leaving a field blank visibly means "let the database decide".
  it("shows a default expression as the field's placeholder and does not require it", () => {
    renderPanel([column("created_at", { nullable: false, default_expr: "now()", udt: "timestamptz" })]);
    expect((screen.getByLabelText(/^created_at/) as HTMLInputElement).placeholder).toBe("now()");
    expect((screen.getByRole("button", { name: /stage insert/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("picks the input from the column's type", () => {
    renderPanel([
      column("paid", { udt: "bool" }),
      column("amount", { udt: "int4" }),
      column("notes", { udt: "text" }),
    ]);
    expect(screen.getByLabelText(/^paid/).tagName).toBe("SELECT");
    expect((screen.getByLabelText(/^amount/) as HTMLInputElement).type).toBe("number");
    expect((screen.getByLabelText(/^notes/) as HTMLInputElement).type).toBe("text");
  });

  it("stages only the fields that were filled, never the database-assigned ones", () => {
    renderPanel([
      column("id", { is_identity: true, nullable: false }),
      column("status", { nullable: false }),
      column("notes"),
    ]);
    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
    fireEvent.click(screen.getByRole("button", { name: /stage insert/i }));

    expect(useAppStore.getState().pending).toEqual([
      { kind: "insert", table: ORDERS, values: { status: "pending" } },
    ]);
  });

  // Save STAGES. If this ever calls a tauri invoke, the whole model is broken.
  it("shows the staged insert instead of writing it", () => {
    renderPanel([column("status", { nullable: false })]);
    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
    fireEvent.click(screen.getByRole("button", { name: /stage insert/i }));
    expect(useAppStore.getState().dockPanel).toBe("pending");
  });
});
