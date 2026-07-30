import { useState } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import type { FireRequestOutput } from "../../lib/tauri";

export function ApiTab() {
  const [result, setResult] = useState<FireRequestOutput | null>(null);

  return (
    <div className="mx-auto flex max-w-180 flex-col gap-4">
      <RequestBuilder onResult={setResult} />
      <ResponseViewer result={result} />
    </div>
  );
}
