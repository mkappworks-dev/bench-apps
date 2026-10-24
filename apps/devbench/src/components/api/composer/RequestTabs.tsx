import { Tabs } from "../../ui/Tabs";
import { KeyValueEditor, type KeyValueRow } from "./KeyValueEditor";
import { BodyEditor, type BodyType } from "./BodyEditor";
import { AuthEditor, type AuthState } from "./AuthEditor";

import type { ReqTab } from "../../../lib/apiComposer";
export type { ReqTab };

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
    <Tabs.Root value={activeTab} onValueChange={(value) => onTabChange(value as ReqTab)}>
      <Tabs.List aria-label="Request" activateOnFocus className="flex gap-4.5 border-b border-border">
        {TABS.map((tab) => (
          <Tabs.Tab key={tab.id} value={tab.id}
            className="border-b-2 border-transparent px-0.5 py-2 text-sm font-semibold text-text-muted transition-colors hover:text-text data-[active]:border-accent data-[active]:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel value="params" className="pt-3">
        <KeyValueEditor rows={params} onChange={onParamsChange} rowKind="param" addLabel="Add param"
          emptyLabel="No query params. Add one, or type them straight into the URL above." />
      </Tabs.Panel>
      <Tabs.Panel value="headers" className="pt-3">
        <KeyValueEditor rows={headers} onChange={onHeadersChange} showEnabled rowKind="header" addLabel="Add header" emptyLabel="No headers set." />
      </Tabs.Panel>
      <Tabs.Panel value="body" className="pt-3">
        <BodyEditor body={body} bodyType={bodyType} onBodyChange={onBodyChange} onBodyTypeChange={onBodyTypeChange} />
      </Tabs.Panel>
      <Tabs.Panel value="auth" className="pt-3">
        <AuthEditor auth={auth} onChange={onAuthChange} />
      </Tabs.Panel>
    </Tabs.Root>
  );
}
