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
  response: FireRequestOutput;
  table_diffs: TableDiff[];
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
