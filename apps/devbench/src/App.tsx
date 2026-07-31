import { useState } from "react";
import { useAppStore, type TabId } from "./store/useAppStore";
import { ApiTab } from "./components/api/ApiTab";
import { DbTab } from "./components/db/DbTab";
import { LogTab } from "./components/log/LogTab";
import { EmailTab } from "./components/email/EmailTab";

/**
 * Single source of truth for the tool tabs. Plan 3 adds `{ id: "email", label: "Email" }`
 * here and nowhere else in this file.
 */
export const TABS: { id: TabId; label: string }[] = [
  { id: "api", label: "API" },
  { id: "db", label: "DB" },
  { id: "log", label: "Log" },
  { id: "email", label: "Email" },
];

export default function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const watchedTables = useAppStore((s) => s.watchedTables);
  const toggleWatchedTable = useAppStore((s) => s.toggleWatchedTable);
  const [dbFocusTable, setDbFocusTable] = useState<string | null>(null);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-13 items-center gap-4 border-b border-border px-4">
        <span className="font-bold text-text">DevBench</span>
        <nav className="flex gap-1" role="tablist" aria-label="DevBench sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`rounded-sm px-3 py-2 text-sm font-medium ${
                activeTab === tab.id ? "bg-surface-2 text-text" : "text-text-muted"
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        {activeTab === "api" ? <ApiTab onOpenTableInDb={setDbFocusTable} /> : null}
        {activeTab === "db" ? (
          <DbTab watchedTables={watchedTables} onToggleWatch={toggleWatchedTable} focusTable={dbFocusTable} />
        ) : null}
        {activeTab === "log" ? <LogTab /> : null}
        {activeTab === "email" ? <EmailTab /> : null}
      </main>
    </div>
  );
}
