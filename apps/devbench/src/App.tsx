import { useAppStore } from "./store/useAppStore";

export default function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-13 items-center gap-4 border-b border-border px-4">
        <span className="font-bold text-text">DevBench</span>
        <nav className="flex gap-1" aria-label="DevBench sections">
          <button
            role="tab"
            aria-selected={activeTab === "api"}
            className={`rounded-sm px-3 py-2 text-sm font-medium ${
              activeTab === "api" ? "bg-surface-2 text-text" : "text-text-muted"
            }`}
            onClick={() => setActiveTab("api")}
          >
            API
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "db"}
            className={`rounded-sm px-3 py-2 text-sm font-medium ${
              activeTab === "db" ? "bg-surface-2 text-text" : "text-text-muted"
            }`}
            onClick={() => setActiveTab("db")}
          >
            DB
          </button>
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        {activeTab === "api" ? <div data-testid="api-panel" /> : <div data-testid="db-panel" />}
      </main>
    </div>
  );
}
