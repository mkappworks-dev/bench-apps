import { describe, expect, it } from "vitest";
import { toCsv, toJson } from "./exportRows";

describe("toCsv", () => {
  it("writes a header row then the values", () => {
    expect(toCsv(["id", "status"], [["1", "paid"]])).toBe("id,status\n1,paid");
  });

  // A comma inside a value would otherwise invent a column.
  it("quotes values containing a comma, quote or newline", () => {
    expect(toCsv(["notes"], [['a,b']])).toBe('notes\n"a,b"');
    expect(toCsv(["notes"], [['say "hi"']])).toBe('notes\n"say ""hi"""');
    expect(toCsv(["notes"], [["line1\nline2"]])).toBe('notes\n"line1\nline2"');
  });

  // NULL and the empty string are different values and must stay different.
  it("writes NULL as an empty field and the empty string as quoted", () => {
    expect(toCsv(["a", "b"], [[null, ""]])).toBe('a,b\n,""');
  });
});

describe("toJson", () => {
  it("emits one object per row keyed by column", () => {
    expect(toJson(["id", "status"], [["1", "paid"]])).toBe(
      JSON.stringify([{ id: "1", status: "paid" }], null, 2),
    );
  });

  it("preserves null rather than turning it into a string", () => {
    expect(JSON.parse(toJson(["notes"], [[null]]))[0].notes).toBeNull();
  });
});
