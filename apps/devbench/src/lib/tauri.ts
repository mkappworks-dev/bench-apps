import { invoke } from "@tauri-apps/api/core";

export interface DbInitError {
  db_path: string;
  error: string;
}

export interface StartupStatus {
  db_error: DbInitError | null;
}

export function invokeGetStartupStatus(): Promise<StartupStatus> {
  return invoke("get_startup_status");
}

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
  /** `null` = unattributed: fired with no active session, or predating session scoping. */
  session_id: string | null;
}

/** `sessionId` omitted or null lists every request ever fired (the unscoped view). */
export function invokeListHistory(sessionId?: string | null): Promise<HistoryEntry[]> {
  return invoke("list_history", { sessionId: sessionId ?? null });
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
  /** The saved request_history row's id, once known — null only if that save itself failed. */
  history_id: string | null;
}

export function invokeRunCorrelatedRequest(args: {
  request: FireRequestInput;
  connectionId: string;
  watchedTables: string[];
  sessionId?: string | null;
}): Promise<CorrelationResult> {
  return invoke("run_correlated_request", {
    request: args.request,
    connectionId: args.connectionId,
    watchedTables: args.watchedTables,
    sessionId: args.sessionId ?? null,
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
  /** Set once a correlated request's window observes this email. */
  request_id: string | null;
  request_method: string | null;
  request_url: string | null;
}

export interface ListEmailsResult {
  emails: EmailSummary[];
  /** Highest id ever evicted by the 5,000-message cap. 0 = nothing evicted yet. */
  evicted_through_id: number;
}

export interface SmtpStatus {
  listening: boolean;
  port: number;
  error: string | null;
}

/** `sessionId` null lists every captured email regardless of session (the unscoped view) — same convention as `invokeListHistory`. */
export function invokeListEmails(sessionId: string | null, limit: number): Promise<ListEmailsResult> {
  return invoke("list_emails", { sessionId, limit });
}

export function invokeGetEmail(id: number): Promise<CapturedEmail> {
  return invoke("get_email", { id });
}

export function invokeClearEmails(sessionId: string | null): Promise<void> {
  return invoke("clear_emails", { sessionId });
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

export function invokeCollectCorrelationWindow(
  correlationId: string,
  historyId: string | null,
): Promise<CorrelationWindowResult> {
  return invoke("collect_correlation_window", { correlationId, historyId });
}

export interface TableInfo {
  schema: string;
  name: string;
}

export function invokeDbConnectAndListTables(connectionId: string): Promise<TableInfo[]> {
  return invoke("db_connect_and_list_tables", { connectionId });
}

export interface TableRows {
  columns: string[];
  rows: (string | null)[][];
  pk_column: string | null;
}

export type { FilterCondition, FilterOp, SortTerm } from "../components/db/grid/types";
import type { FilterCondition, SortTerm } from "../components/db/grid/types";

export function invokeListTableRows(
  connectionId: string,
  table: string,
  options?: { filter?: FilterCondition[]; orderBy?: SortTerm[]; limit?: number; offset?: number },
): Promise<TableRows> {
  return invoke("list_table_rows", {
    connectionId,
    table,
    filter: options?.filter ?? [],
    orderBy: options?.orderBy ?? [],
    limit: options?.limit ?? 100,
    offset: options?.offset ?? 0,
  });
}

export function invokeCountTableRows(
  connectionId: string,
  table: string,
  filter: FilterCondition[] = [],
): Promise<number> {
  return invoke("count_table_rows", { connectionId, table, filter });
}

export function invokeListWatchedTables(connectionId: string): Promise<string[]> {
  return invoke("list_watched_tables", { connectionId });
}

export function invokeSetWatchedTable(connectionId: string, table: string, watched: boolean): Promise<void> {
  return invoke("set_watched_table", { connectionId, table, watched });
}

export interface QueryPreview {
  preview_id: string;
  columns: string[];
  rows: (string | null)[][];
  rows_affected: number | null;
}

export function invokePreviewQuery(connectionId: string, sql: string): Promise<QueryPreview> {
  return invoke("preview_query", { connectionId, sql });
}

export function invokePreviewCellEdit(
  connectionId: string,
  table: string,
  pkColumn: string,
  pkValue: string,
  column: string,
  value: string | null,
): Promise<QueryPreview> {
  return invoke("preview_cell_edit", { connectionId, table, pkColumn, pkValue, column, value });
}

export function invokeCommitPreview(previewId: string): Promise<void> {
  return invoke("commit_preview", { previewId });
}

export function invokeRollbackPreview(previewId: string): Promise<void> {
  return invoke("rollback_preview", { previewId });
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

export interface TabRow {
  id: string;
  session_id: string | null;
  kind: string;
  pane: string;
  ordinal: number;
  state: string | null;
}

export function invokeListTabs(sessionId: string | null): Promise<TabRow[]> {
  return invoke("list_tabs", { sessionId });
}

export function invokeCreateTab(input: {
  id: string;
  sessionId: string | null;
  kind: string;
  pane: string;
  ordinal: number;
  state: string;
}): Promise<void> {
  return invoke("create_tab", input);
}

export function invokeCloseTab(id: string): Promise<void> {
  return invoke("close_tab", { id });
}

export function invokeSetTabState(id: string, state: string): Promise<void> {
  return invoke("set_tab_state", { id, state });
}

export function invokeMoveTab(id: string, pane: string, ordinal: number): Promise<void> {
  return invoke("move_tab", { id, pane, ordinal });
}

export interface ConnectionSummary {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
  /** The password itself is never sent to the frontend — only whether one is stored. */
  has_password: boolean;
}

export interface ConnectionInput {
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
  password?: string | null;
}

export function invokeListConnections(): Promise<ConnectionSummary[]> {
  return invoke("list_connections");
}

export function invokeCreateConnection(input: ConnectionInput): Promise<ConnectionSummary> {
  return invoke("create_connection", { input });
}

export function invokeUpdateConnection(id: string, input: ConnectionInput): Promise<ConnectionSummary> {
  return invoke("update_connection", { id, input });
}

export function invokeDeleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

export function invokeSetConnectionPassword(id: string, password: string): Promise<void> {
  return invoke("set_connection_password", { id, password });
}

export function invokeClearConnectionPassword(id: string): Promise<void> {
  return invoke("clear_connection_password", { id });
}

export function invokeTestConnection(input: ConnectionInput): Promise<void> {
  return invoke("test_connection", { input });
}

export function invokeTestSavedConnection(id: string): Promise<void> {
  return invoke("test_saved_connection", { id });
}
