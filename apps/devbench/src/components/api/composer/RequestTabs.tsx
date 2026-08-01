import { KeyValueEditor, type KeyValueRow } from "./KeyValueEditor";
import { BodyEditor, type BodyType } from "./BodyEditor";
import { AuthEditor, type AuthState } from "./AuthEditor";

export type ReqTab = "params" | "headers" | "body" | "auth";

const TABS: { id: ReqTab; label: string }[] = [
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "auth", label: "Auth" },
];

export function RequestTabs({
  activeTab,
  onTabChange,
  params,
  onParamsChange,
  headers,
  onHeadersChange,
  body,
  bodyType,
  onBodyChange,
  onBodyTypeChange,
  auth,
  onAuthChange,
}: {
  activeTab: ReqTab;
  onTabChange: (tab: ReqTab) => void;
  params: KeyValueRow[];
  onParamsChange: (rows: KeyValueRow[]) => void;
  headers: KeyValueRow[];
  onHeadersChange: (rows: KeyValueRow[]) => void;
  body: string;
  bodyType: BodyType;
  onBodyChange: (body: string) => void;
  onBodyTypeChange: (type: BodyType) => void;
  auth: AuthState;
  onAuthChange: (auth: AuthState) => void;
}) {
  return (
    <div>
      <div className="flex gap-4.5 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            aria-selected={activeTab === tab.id}
            className={`border-b-2 px-0.5 py-2 text-sm font-semibold ${
              activeTab === tab.id ? "border-accent text-text" : "border-transparent text-text-faint"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pt-3">
        {activeTab === "params" ? (
          <KeyValueEditor
            rows={params}
            onChange={onParamsChange}
            addLabel="Add param"
            emptyLabel="No query params. Add one, or type them straight into the URL above."
          />
        ) : null}
        {activeTab === "headers" ? (
          <KeyValueEditor rows={headers} onChange={onHeadersChange} showEnabled addLabel="Add header" emptyLabel="No headers set." />
        ) : null}
        {activeTab === "body" ? (
          <BodyEditor bodyType={bodyType} body={body} onBodyTypeChange={onBodyTypeChange} onBodyChange={onBodyChange} />
        ) : null}
        {activeTab === "auth" ? <AuthEditor auth={auth} onChange={onAuthChange} /> : null}
      </div>
    </div>
  );
}
