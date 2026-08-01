import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BodyEditor } from "./BodyEditor";

describe("BodyEditor", () => {
  it("disables the textarea when body type is none", () => {
    render(<BodyEditor bodyType="none" body="" onBodyTypeChange={() => {}} onBodyChange={() => {}} />);
    expect(screen.getByPlaceholderText("No body for this request")).toBeDisabled();
  });

  it("enables the textarea and shows the body when type is json", () => {
    render(<BodyEditor bodyType="json" body='{"a":1}' onBodyTypeChange={() => {}} onBodyChange={() => {}} />);
    const textarea = screen.getByPlaceholderText("Raw request body") as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    expect(textarea.value).toBe('{"a":1}');
  });

  it("calls onBodyTypeChange when the select changes", () => {
    const onBodyTypeChange = vi.fn();
    render(<BodyEditor bodyType="none" body="" onBodyTypeChange={onBodyTypeChange} onBodyChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Body type"), { target: { value: "text" } });
    expect(onBodyTypeChange).toHaveBeenCalledWith("text");
  });

  it("calls onBodyChange as the textarea is edited", () => {
    const onBodyChange = vi.fn();
    render(<BodyEditor bodyType="text" body="" onBodyTypeChange={() => {}} onBodyChange={onBodyChange} />);
    fireEvent.change(screen.getByPlaceholderText("Raw request body"), { target: { value: "hello" } });
    expect(onBodyChange).toHaveBeenCalledWith("hello");
  });
});
