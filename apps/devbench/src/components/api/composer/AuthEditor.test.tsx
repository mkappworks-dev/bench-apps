import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthEditor, DEFAULT_AUTH, authPreview, resolveAuthHeader, resolveAuthQueryParam } from "./AuthEditor";

describe("authPreview", () => {
  it("says no auth is added for type none", () => {
    expect(authPreview(DEFAULT_AUTH)).toBe("No Authorization added — request goes out with only the headers above.");
  });

  it("masks a bearer token", () => {
    expect(authPreview({ ...DEFAULT_AUTH, type: "bearer", token: "sk_live_9fa27dP" })).toBe(
      "Adds header  Authorization: Bearer sk_••••dP",
    );
  });

  it("describes an api key added to a header", () => {
    expect(
      authPreview({ ...DEFAULT_AUTH, type: "apikey", keyName: "X-Api-Key", keyValue: "ak_test_2201", keyIn: "header" }),
    ).toBe("Adds header  X-Api-Key: ak_••••01");
  });

  it("describes an api key added to a query param", () => {
    expect(authPreview({ ...DEFAULT_AUTH, type: "apikey", keyName: "key", keyValue: "abc123456", keyIn: "query" })).toBe(
      "Adds query param  key: abc••••56",
    );
  });

  it("previews basic auth without exposing the raw password", () => {
    const preview = authPreview({ ...DEFAULT_AUTH, type: "basic", username: "admin", password: "hunter2" });
    expect(preview).toContain("Adds header  Authorization: Basic ");
    expect(preview).not.toContain("hunter2");
  });
});

describe("resolveAuthHeader", () => {
  it("returns null for no auth", () => {
    expect(resolveAuthHeader(DEFAULT_AUTH)).toBeNull();
  });

  it("resolves a bearer token to an Authorization header", () => {
    expect(resolveAuthHeader({ ...DEFAULT_AUTH, type: "bearer", token: "abc" })).toEqual({
      key: "Authorization",
      value: "Bearer abc",
    });
  });

  it("resolves basic auth to a Basic Authorization header", () => {
    const result = resolveAuthHeader({ ...DEFAULT_AUTH, type: "basic", username: "u", password: "p" });
    expect(result?.key).toBe("Authorization");
    expect(result?.value).toMatch(/^Basic /);
  });

  it("resolves an api key configured for a header", () => {
    expect(resolveAuthHeader({ ...DEFAULT_AUTH, type: "apikey", keyName: "X-Key", keyValue: "v", keyIn: "header" })).toEqual({
      key: "X-Key",
      value: "v",
    });
  });

  it("returns null for an api key configured for a query param", () => {
    expect(resolveAuthHeader({ ...DEFAULT_AUTH, type: "apikey", keyValue: "v", keyIn: "query" })).toBeNull();
  });
});

describe("resolveAuthQueryParam", () => {
  it("resolves an api key configured for a query param", () => {
    expect(resolveAuthQueryParam({ ...DEFAULT_AUTH, type: "apikey", keyName: "key", keyValue: "v", keyIn: "query" })).toEqual({
      key: "key",
      value: "v",
    });
  });

  it("returns null for an api key configured for a header", () => {
    expect(resolveAuthQueryParam({ ...DEFAULT_AUTH, type: "apikey", keyValue: "v", keyIn: "header" })).toBeNull();
  });
});

describe("AuthEditor", () => {
  it("shows the token field only for bearer auth", () => {
    render(<AuthEditor auth={{ ...DEFAULT_AUTH, type: "bearer" }} onChange={() => {}} />);
    expect(screen.getByPlaceholderText("Bearer token")).toBeInTheDocument();
  });

  it("calls onChange with the new type when the type select changes", () => {
    const onChange = vi.fn();
    render(<AuthEditor auth={DEFAULT_AUTH} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Auth type"), { target: { value: "bearer" } });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_AUTH, type: "bearer" });
  });
});
