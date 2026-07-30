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
