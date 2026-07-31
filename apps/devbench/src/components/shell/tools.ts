import type { ToolKind } from "../../store/useAppStore";

export const TABS: { id: ToolKind; label: string }[] = [
  { id: "api", label: "API" },
  { id: "db", label: "DB" },
  { id: "log", label: "Log" },
  { id: "email", label: "Email" },
];
