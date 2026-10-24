import { describe, expect, it } from "vitest";
import { splitUrlAndParams, joinUrlAndParams } from "./urlParams";

describe("splitUrlAndParams", () => {
  it("splits a url with no query string", () => {
    expect(splitUrlAndParams("/api/orders")).toEqual({ base: "/api/orders", params: [], fragment: "" });
  });

  it("splits a url with a query string into rows", () => {
    expect(splitUrlAndParams("/api/orders?status=pending&limit=20")).toEqual({
      base: "/api/orders",
      fragment: "",
      params: [
        { key: "status", value: "pending" },
        { key: "limit", value: "20" },
      ],
    });
  });

  it("decodes percent-encoded keys and values", () => {
    expect(splitUrlAndParams("/api/search?q=a%20b")).toEqual({
      base: "/api/search",
      fragment: "",
      params: [{ key: "q", value: "a b" }],
    });
  });
});

describe("joinUrlAndParams", () => {
  it("returns the base url when there are no params", () => {
    expect(joinUrlAndParams("/api/orders", [])).toBe("/api/orders");
  });

  it("appends encoded params as a query string", () => {
    expect(joinUrlAndParams("/api/orders", [{ key: "status", value: "pending" }])).toBe("/api/orders?status=pending");
  });

  it("percent-encodes keys and values", () => {
    expect(joinUrlAndParams("/api/search", [{ key: "q", value: "a b" }])).toBe("/api/search?q=a%20b");
  });

  it("skips rows with an empty key", () => {
    expect(
      joinUrlAndParams("/api/orders", [
        { key: "", value: "x" },
        { key: "limit", value: "20" },
      ]),
    ).toBe("/api/orders?limit=20");
  });
});


describe("query editing edge cases", () => {
  it.each([
    ["/orders?q=a=b?c#frag", { base: "/orders", params: [{ key: "q", value: "a=b?c" }], fragment: "#frag" }],
    ["/orders?a=1&a=2", { base: "/orders", params: [{ key: "a", value: "1" }, { key: "a", value: "2" }], fragment: "" }],
    ["/orders?q=a+b&literal=%2B", { base: "/orders", params: [{ key: "q", value: "a b" }, { key: "literal", value: "+" }], fragment: "" }],
    ["/orders?q=%", { base: "/orders", params: [{ key: "q", value: "%" }], fragment: "" }],
    ["/orders#frag?text", { base: "/orders", params: [], fragment: "#frag?text" }],
  ])("parses %s without losing data", (url, expected) => {
    expect(splitUrlAndParams(url)).toEqual(expected);
  });

  it("keeps the fragment after an edited query", () => {
    expect(joinUrlAndParams("/orders", [{ key: "q", value: "a b+c" }], "#frag")).toBe("/orders?q=a%20b%2Bc#frag");
  });
});
