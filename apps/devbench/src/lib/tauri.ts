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
