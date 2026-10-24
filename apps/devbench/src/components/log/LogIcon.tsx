export type LogIconName = "file" | "command" | "docker" | "plus" | "close" | "search";

const PATHS: Record<LogIconName, React.ReactNode> = {
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>,
  command: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  docker: <><path d="M3 12h16c0 5-3 8-8 8-4 0-7-2-8-5Zm16 0c0-3 2-4 3-4M6 8h4v4H6Zm4 0h4v4h-4Zm0-4h4v4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
};

export function LogIcon({ name, size = 14 }: { name: LogIconName; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" data-icon={name}>
      {PATHS[name]}
    </svg>
  );
}
