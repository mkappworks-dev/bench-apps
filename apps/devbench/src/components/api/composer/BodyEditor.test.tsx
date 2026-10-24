import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "Body type" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Text" }));
    expect(onBodyTypeChange).toHaveBeenCalledWith("text");
  });

  it("calls onBodyChange as the textarea is edited", () => {
    const onBodyChange = vi.fn();
    render(<BodyEditor bodyType="text" body="" onBodyTypeChange={() => {}} onBodyChange={onBodyChange} />);
    fireEvent.change(screen.getByPlaceholderText("Raw request body"), { target: { value: "hello" } });
    expect(onBodyChange).toHaveBeenCalledWith("hello");
  });
});


it("retains its draft across None and returns focus after dismissing the picker", async () => {
  function Editor() {
    const [bodyType, onBodyTypeChange] = useState<"none" | "json" | "text">("json");
    const [body, onBodyChange] = useState('{"a":1}');
    return <BodyEditor {...{ bodyType, body, onBodyTypeChange, onBodyChange }} />;
  }
  render(<Editor />);
  const picker = screen.getByRole("button", { name: "Body type" });
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "None" }));
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "Request body" })).toBeDisabled();
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Text" }));
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "Request body" })).toHaveValue('{"a":1}');
  fireEvent.click(picker);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(picker).toHaveFocus());
});
