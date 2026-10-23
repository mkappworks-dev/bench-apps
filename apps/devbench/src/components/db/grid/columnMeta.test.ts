import { describe, expect, it } from "vitest";
import {
  canFollow,
  columnInfoOf,
  describeTarget,
  familyOfColumn,
  familyOfUdt,
  fkTargetOf,
  isNumericUdt,
  type ColumnInfo,
} from "./columnMeta";

function col(name: string, udt: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    udt,
    nullable: true,
    default_expr: null,
    is_identity: false,
    references: null,
    ...extra,
  };
}

const META: ColumnInfo[] = [
  col("id", "int4", { nullable: false, is_identity: true, default_expr: "nextval('o_id_seq'::regclass)" }),
  col("user_id", "text", {
    nullable: false,
    references: { schema: "public", table: "users", column: "id" },
  }),
  col("amount", "numeric"),
  col("paid", "bool", { default_expr: "false" }),
  col("created_at", "timestamptz", { nullable: false, default_expr: "now()" }),
  col("notes", "text"),
];

describe("familyOfUdt", () => {
  it("maps a boolean column to the boolean operator set", () => {
    expect(familyOfUdt("bool")).toBe("boolean");
  });

  // Spec §4 gives numerics and dates one operator set, because > and < mean
  // something for both. The family names the operator set, not a JS type.
  it("maps numerics and dates alike to the ordered operator set", () => {
    for (const udt of ["int2", "int4", "int8", "float8", "numeric", "money"]) {
      expect(familyOfUdt(udt)).toBe("number");
    }
    for (const udt of ["date", "timestamp", "timestamptz", "time", "timetz"]) {
      expect(familyOfUdt(udt)).toBe("number");
    }
  });

  it("falls back to text for anything it does not recognise", () => {
    expect(familyOfUdt("text")).toBe("text");
    expect(familyOfUdt("uuid")).toBe("text");
    expect(familyOfUdt("jsonb")).toBe("text");
  });

  // Narrower than the "number" FILTER family, which also covers dates because
  // `>` and `<` answer something for both. An insert field is a real input,
  // and a date in a number input is unusable.
  it("counts only true numerics as numeric, not the dates the number family covers", () => {
    expect(isNumericUdt("int4")).toBe(true);
    expect(isNumericUdt("numeric")).toBe(true);
    expect(isNumericUdt("timestamptz")).toBe(false);
    expect(isNumericUdt("text")).toBe(false);
    expect(familyOfUdt("timestamptz")).toBe("number");
  });
});

describe("familyOfColumn", () => {
  // This is the whole point of the slice's type work: Slice 1 sniffed the
  // family out of a sample value, so a text column holding "42" offered
  // numeric operators and a text column holding "true" offered boolean ones.
  it("reads the real type rather than sniffing a value", () => {
    expect(familyOfColumn(META, "amount")).toBe("number");
    expect(familyOfColumn(META, "paid")).toBe("boolean");
    // Its VALUES are digits, but the column is text — `contains` belongs here,
    // `>` does not.
    expect(familyOfColumn(META, "user_id")).toBe("text");
  });

  // Metadata can be missing: an older server, a permissions error, or the
  // first render before the fetch lands. Text is the safe default — its
  // operator set is the one that works on any column.
  it("defaults to text when the column has no metadata", () => {
    expect(familyOfColumn(META, "not_a_column")).toBe("text");
    expect(familyOfColumn([], "amount")).toBe("text");
  });
});

describe("fkTargetOf and canFollow", () => {
  it("reports a target only for a column that has one", () => {
    expect(fkTargetOf(META, "user_id")).toEqual({ schema: "public", table: "users", column: "id" });
    expect(fkTargetOf(META, "notes")).toBeNull();
    expect(fkTargetOf(META, "id")).toBeNull();
  });

  it("follows a real value on a keyed column", () => {
    expect(canFollow(META, "user_id", "usr_88")).toBe(true);
  });

  // Spec §8: the icon describes data you can follow. These two follow nowhere.
  it("does not follow NULL or an undecodable value", () => {
    expect(canFollow(META, "user_id", null)).toBe(false);
    expect(canFollow(META, "user_id", "<unsupported type>")).toBe(false);
  });

  it("does not follow a column with no key", () => {
    expect(canFollow(META, "notes", "anything")).toBe(false);
  });
});

describe("columnInfoOf and describeTarget", () => {
  it("finds a column by name", () => {
    expect(columnInfoOf(META, "paid")?.udt).toBe("bool");
    expect(columnInfoOf(META, "missing")).toBeNull();
  });

  it("renders a target as schema.table.column", () => {
    expect(describeTarget({ schema: "public", table: "users", column: "id" })).toBe("public.users.id");
  });
});
