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
    useAppStore.setState({ pending: [] });
  });

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

  it("keeps Save disabled when the column metadata has not arrived yet", () => {
    renderPanel([]);
    expect((screen.getByRole("button", { name: /stage insert/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps Save disabled on an untouched form where every column is optional", () => {
    renderPanel([
      column("id", { is_identity: true, nullable: false }),
      column("body"),
      column("created_at", { nullable: false, default_expr: "now()", udt: "timestamptz" }),
    ]);
    const save = () => screen.getByRole("button", { name: /stage insert/i }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    // One field is enough — the guard is "nothing filled", not "something required is missing".
    fireEvent.change(screen.getByLabelText(/^body/), { target: { value: "note" } });
    expect(save().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText(/^body/), { target: { value: "   " } });
    expect(save().disabled).toBe(true);
  });

  // Filling the other column isolates the claim: Save going live with created_at still blank proves a default doesn't make it required.
  it("shows a default expression as the field's placeholder and does not require it", () => {
    renderPanel([
      column("status", { nullable: false }),
      column("created_at", { nullable: false, default_expr: "now()", udt: "timestamptz" }),
    ]);
    expect((screen.getByLabelText(/^created_at/) as HTMLInputElement).placeholder).toBe("now()");

    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
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
      { kind: "insert", connection_id: "c1", table: ORDERS, values: { status: "pending" } },
    ]);
  });

  it("stages the insert against the connection the panel was opened for", () => {
    useAppStore.getState().setActiveConnectionId("c-elsewhere");
    render(
      <InsertPanel
        target={{ connectionId: "c-opened-on", table: ORDERS, columns: [column("status", { nullable: false })] }}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
    fireEvent.click(screen.getByRole("button", { name: /stage insert/i }));

    expect(useAppStore.getState().pending[0].connection_id).toBe("c-opened-on");
  });

  // Save STAGES. If this ever calls a tauri invoke, the whole model is broken.
  it("shows the staged insert instead of writing it", () => {
    renderPanel([column("status", { nullable: false })]);
    fireEvent.change(screen.getByLabelText(/^status/), { target: { value: "pending" } });
    fireEvent.click(screen.getByRole("button", { name: /stage insert/i }));
    expect(useAppStore.getState().dockPanel).toBe("pending");
  });
});
