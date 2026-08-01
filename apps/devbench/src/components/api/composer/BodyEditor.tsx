export type BodyType = "none" | "json" | "text";

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
      <select
        value={bodyType}
        onChange={(e) => onBodyTypeChange(e.target.value as BodyType)}
        aria-label="Body type"
        className="mb-2.5 rounded-sm border border-border bg-surface-2 px-2 py-1.5 font-bold text-text"
      >
        <option value="none">None</option>
        <option value="json">JSON</option>
        <option value="text">Text</option>
      </select>
      <textarea
        value={disabled ? "" : body}
        onChange={(e) => onBodyChange(e.target.value)}
        disabled={disabled}
        placeholder={disabled ? "No body for this request" : "Raw request body"}
        className="min-h-35 w-full rounded-lg border border-border bg-surface p-2.5 font-mono text-sm text-text disabled:bg-bg disabled:text-text-faint"
      />
    </div>
  );
}
