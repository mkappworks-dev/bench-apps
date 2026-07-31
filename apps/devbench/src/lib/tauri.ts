import { invoke } from "@tauri-apps/api/core";

export interface FireRequestInput {
  method: string;
  url: string;
  body?: string;
}

export interface FireRequestOutput {
  status_code: number;
  body: string;
  duration_ms: number;
}

export function invokeFireRequest(input: FireRequestInput): Promise<FireRequestOutput> {
  return invoke("fire_request", { input });
}

export interface HistoryEntry {
  id: string;
  method: string;
  url: string;
  status_code: number;
  response_body: string;
  duration_ms: number;
  fired_at: string;
}

export function invokeListHistory(): Promise<HistoryEntry[]> {
  return invoke("list_history");
}

export interface TableDiff {
  table: string;
  inserted: number;
  updated: number;
  deleted: number;
}

export interface CorrelationResult {
  correlation_id: string;
  response: FireRequestOutput;
  /** `null` means the database could not be verified — never render this as "0 writes". */
  table_diffs: TableDiff[] | null;
  db_error: string | null;
}

export interface DbConnectInput {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export function invokeRunCorrelatedRequest(args: {
  request: FireRequestInput;
  connection: DbConnectInput;
  watchedTables: string[];
}): Promise<CorrelationResult> {
  return invoke("run_correlated_request", {
    request: args.request,
    connection: args.connection,
    watchedTables: args.watchedTables,
  });
}

export interface LogLine {
  id: number;
  source_id: string;
  captured_at_ms: number;
  timestamp: string | null;
  level: string | null;
  message: string;
  raw: string;
}

export interface LogSourceStatus {
  id: string;
  label: string;
  path: string;
  state: string;
  error: string | null;
}

export interface LogPage {
  lines: LogLine[];
  next_id: number;
  dropped: number;
}

export interface CorrelationWindowResult {
  /** `null` means no log source is configured — logs were not observed at all. */
  log_lines: LogLine[] | null;
  log_lines_truncated: boolean;
  /** `null` means the SMTP catcher is not listening — mail was not observed at all. */
  emails: EmailSummary[] | null;
  emails_truncated: boolean;
}

export interface EmailSummary {
  id: number;
  captured_at_ms: number;
  from: string;
  to: string[];
  subject: string;
  size_bytes: number;
}

export interface CapturedEmail extends EmailSummary {
  html_body: string | null;
  text_body: string | null;
  raw: string;
}

export interface SmtpStatus {
  listening: boolean;
  port: number;
  error: string | null;
}

export function invokeListEmails(limit: number): Promise<EmailSummary[]> {
  return invoke("list_emails", { limit });
}

export function invokeGetEmail(id: number): Promise<CapturedEmail> {
  return invoke("get_email", { id });
}

export function invokeClearEmails(): Promise<void> {
  return invoke("clear_emails");
}

export function invokeSmtpStatus(): Promise<SmtpStatus> {
  return invoke("smtp_status");
}

export function invokeAddLogSource(label: string, path: string): Promise<LogSourceStatus> {
  return invoke("add_log_source", { input: { label, path } });
}

export function invokeRemoveLogSource(id: string): Promise<void> {
  return invoke("remove_log_source", { id });
}

export function invokeListLogSources(): Promise<LogSourceStatus[]> {
  return invoke("list_log_sources");
}

export function invokeReadLogLines(args: {
  afterId: number;
  sourceId?: string;
  limit: number;
}): Promise<LogPage> {
  return invoke("read_log_lines", {
    input: { after_id: args.afterId, source_id: args.sourceId ?? null, limit: args.limit },
  });
}

export function invokeCollectCorrelationWindow(correlationId: string): Promise<CorrelationWindowResult> {
  return invoke("collect_correlation_window", { correlationId });
}

export interface TableInfo {
  schema: string;
  name: string;
}

export function invokeDbConnectAndListTables(connection: DbConnectInput): Promise<TableInfo[]> {
  return invoke("db_connect_and_list_tables", { input: connection });
}

export interface TableRows {
  columns: string[];
  rows: (string | null)[][];
}

export function invokeListTableRows(connection: DbConnectInput, table: string): Promise<TableRows> {
  return invoke("list_table_rows", { input: connection, table });
}

export function invokeListWatchedTables(connection: DbConnectInput): Promise<string[]> {
  return invoke("list_watched_tables", { connection });
}

export function invokeSetWatchedTable(
  connection: DbConnectInput,
  table: string,
  watched: boolean,
): Promise<void> {
  return invoke("set_watched_table", { connection, table, watched });
}

export interface Session {
  id: string;
  name: string;
  kind: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function invokeCreateSession(name: string, kind?: string): Promise<Session> {
  return invoke("create_session", { name, kind: kind ?? null });
}
export function invokeListSessions(): Promise<Session[]> {
  return invoke("list_sessions");
}
export function invokeListArchivedSessions(): Promise<Session[]> {
  return invoke("list_archived_sessions");
}
export function invokeRenameSession(id: string, name: string): Promise<Session> {
  return invoke("rename_session", { id, name });
}
export function invokeArchiveSession(id: string): Promise<void> {
  return invoke("archive_session", { id });
}
export function invokeRestoreSession(id: string): Promise<void> {
  return invoke("restore_session", { id });
}
export function invokeDeleteSession(id: string): Promise<void> {
  return invoke("delete_session", { id });
}

export interface AppSettings {
  theme: string;
  correlation_window_ms: number;
  smtp_port: number;
  provider: string;
  model: string;
  /** The session the user was last in. `null` = unscoped. */
  active_session_id: string | null;
}

export function invokeGetSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export function invokeSetSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value });
}

export interface ProviderStatus {
  provider: string;
  model: string;
  /** The key itself is never sent to the frontend — only whether one exists. */
  has_key: boolean;
}

export function invokeGetProviderStatus(): Promise<ProviderStatus> {
  return invoke("get_provider_status");
}
export function invokeSetProviderApiKey(key: string): Promise<void> {
  return invoke("set_provider_api_key", { key });
}
export function invokeClearProviderApiKey(): Promise<void> {
  return invoke("clear_provider_api_key");
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export interface McpServerStatus {
  config: McpServerConfig;
  state: string;
  error: string | null;
  tool_count: number;
}

export function invokeListMcpServers(): Promise<McpServerConfig[]> {
  return invoke("list_mcp_servers");
}
export function invokeAddMcpServer(name: string, command: string, args: string[]): Promise<McpServerConfig> {
  return invoke("add_mcp_server", { name, command, args });
}
export function invokeRemoveMcpServer(id: string): Promise<void> {
  return invoke("remove_mcp_server", { id });
}
export function invokeCheckMcpServer(id: string): Promise<McpServerStatus> {
  return invoke("check_mcp_server", { id });
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatReply {
  content: string;
  tool_calls: string[];
}

export function invokeSendChatMessage(messages: ChatMessage[]): Promise<ChatReply> {
  return invoke("send_chat_message", { messages });
}
