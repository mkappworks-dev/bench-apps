import type { ToolKind } from "../../store/useAppStore";
import type { MenuOption } from "../ui/Menu";

export interface ToolMeta {
  id: ToolKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}

function ApiIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L4.5 13H11l-1 9 8.5-11H12z" />
    </svg>
  );
}

function DbIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7">
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v13c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-13" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </svg>
  );
}

function LogIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h10M4 18h13" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </svg>
  );
}

/**
 * Single source of truth for the tool tabs. Adding a fifth tool is one entry
 * here (see the post-v1 roadmap: outbound HTTP inspector, jobs, cache…).
 */
export const TABS: ToolMeta[] = [
  { id: "api", label: "API", description: "Send requests, watch effects", icon: <ApiIcon /> },
  { id: "db", label: "DB", description: "Browse schema and rows", icon: <DbIcon /> },
  { id: "log", label: "Log", description: "Tail a log source", icon: <LogIcon /> },
  { id: "email", label: "Email", description: "Captured outbound mail", icon: <EmailIcon /> },
];

/** The `+` picker's options — shared by AppStrip and EmptyPane so the two never drift. */
export const TOOL_MENU_OPTIONS: MenuOption[] = TABS.map((t) => ({
  value: t.id,
  label: t.label,
  description: t.description,
  icon: t.icon,
}));
