import { Menu, ChevronIcon } from "../../ui/Menu";

import type { BodyType } from "../../../lib/apiComposer";
export type { BodyType };

export function BodyEditor({
  bodyType,
  body,
  onBodyTypeChange,
  onBodyChange,
}: {
  bodyType: BodyType;
  body: string;
  onBodyTypeChange: (type: BodyType) => void;
  onBodyChange: (body: string) => void;
}) {
  const disabled = bodyType === "none";
  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        <Menu closeOnSelect label="Body type" options={[{ value: "none", label: "None" }, { value: "json", label: "JSON" }, { value: "text", label: "Text" }]}
          value={bodyType} onSelect={(value) => onBodyTypeChange(value as BodyType)}
          trigger={<>{bodyType === "json" ? "JSON" : bodyType === "text" ? "Text" : "None"}<ChevronIcon /></>}
          triggerClassName="api-picker flex h-8.5 w-35 items-center justify-between gap-2 rounded-sm border border-border bg-surface px-2.5 text-sm font-semibold text-text hover:border-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
        {disabled ? <span className="text-xs text-text-muted">This request sends no body.</span> : null}
      </div>
      <textarea
        aria-label="Request body"
        value={disabled ? "" : body}
        onChange={(e) => onBodyChange(e.target.value)}
        disabled={disabled}
        placeholder={disabled ? "No body for this request" : "Raw request body"}
        className="api-body min-h-35 w-full rounded-lg border border-border bg-surface p-2.5 font-mono text-sm text-text disabled:bg-bg disabled:text-text-muted placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
    </div>
  );
}
