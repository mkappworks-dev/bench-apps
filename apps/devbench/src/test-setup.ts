import "@testing-library/jest-dom/vitest";
import "./styles/tokens.css";
import { vi } from "vitest";

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
