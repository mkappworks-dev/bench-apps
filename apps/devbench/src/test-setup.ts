import "@testing-library/jest-dom/vitest";
import "./styles/tokens.css";
import { vi } from "vitest";

// This runner exposes no `localStorage` (jsdom's is not wired up here, and
// Node's needs --localstorage-file), so anything that persists user
// preferences would silently take its "storage unavailable" fallback in every
// test — passing while proving nothing. A minimal in-memory Storage makes that
// behaviour testable; tests clear it themselves in `beforeEach`.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: memoryStorage, configurable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", { value: memoryStorage, configurable: true });
  }
}

// Mock Tauri invoke globally to prevent unhandled errors in tests
// Uses vi.importActual to preserve other module exports (Channel, Resource, etc.)
// while only overriding invoke. Resolves to empty array by default to allow
// components without explicit error handling (like HistorySidebar) to mount cleanly.
// Individual tests can override this via vi.spyOn as demonstrated in HistorySidebar.test.tsx.
vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual<typeof import("@tauri-apps/api/core")>("@tauri-apps/api/core");
  return {
    ...actual,
    invoke: vi.fn(() => Promise.resolve([])),
  };
});
