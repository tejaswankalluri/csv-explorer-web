// ──────────────────────────────────────────────
// Request IDs
// ──────────────────────────────────────────────

/** Unique identifier for correlating requests with responses */
export type RequestId = string;

// ──────────────────────────────────────────────
// Shared Types
// ──────────────────────────────────────────────

export interface ColumnInfo {
  name: string;
  type: string;       // DuckDB type name (VARCHAR, INTEGER, etc.)
  nullable: boolean;
}

/**
 * Error codes for structured worker error reporting.
 * Using a const object instead of enum to satisfy `erasableSyntaxOnly`.
 */
export const WorkerErrorCode = {
  INIT_FAILED: 'INIT_FAILED',
  CSV_PARSE_ERROR: 'CSV_PARSE_ERROR',
  QUERY_ERROR: 'QUERY_ERROR',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type WorkerErrorCode = (typeof WorkerErrorCode)[keyof typeof WorkerErrorCode];

// ──────────────────────────────────────────────
// Messages: Main Thread → Worker
// ──────────────────────────────────────────────

export interface InitDuckDBRequest {
  requestId: RequestId;
  type: 'INIT_DUCKDB';
  payload: {
    logLevel?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  };
}

export interface LoadCSVRequest {
  requestId: RequestId;
  type: 'LOAD_CSV';
  payload: {
    fileName: string;
    fileContent: ArrayBuffer;   // binary for Transferable efficiency
    delimiter?: string;          // auto-detect if omitted
    hasHeader?: boolean;         // default true
    batchSize?: number;          // rows per INSERT batch, default 10000
  };
}

export interface QueryPageRequest {
  requestId: RequestId;
  type: 'QUERY_PAGE';
  payload: {
    sql: string;
    params?: unknown[];          // for future parameterized queries
  };
}

export interface GetStatsRequest {
  requestId: RequestId;
  type: 'GET_STATS';
  payload: {
    tableName: string;
  };
}

export interface CancelRequest {
  requestId: RequestId;
  type: 'CANCEL';
  payload: {
    targetRequestId: RequestId; // the requestId to cancel
  };
}

/** Union of all messages the main thread can send */
export type WorkerRequest =
  | InitDuckDBRequest
  | LoadCSVRequest
  | QueryPageRequest
  | GetStatsRequest
  | CancelRequest;

// ──────────────────────────────────────────────
// Messages: Worker → Main Thread
// ──────────────────────────────────────────────

export interface InitDuckDBReady {
  requestId: RequestId;
  type: 'INIT_DUCKDB_READY';
  payload: {
    version: string;            // DuckDB version string
  };
}

export interface LoadCSVProgress {
  requestId: RequestId;
  type: 'LOAD_CSV_PROGRESS';
  payload: {
    rowsLoaded: number;
    bytesProcessed: number;
    totalBytes: number;
    phase: 'parsing' | 'inserting';
  };
}

export interface LoadCSVComplete {
  requestId: RequestId;
  type: 'LOAD_CSV_COMPLETE';
  payload: {
    tableName: string;
    totalRows: number;
    columns: ColumnInfo[];
    elapsedMs: number;
  };
}

export interface QueryResult {
  requestId: RequestId;
  type: 'QUERY_RESULT';
  payload: {
    columns: ColumnInfo[];
    rows: Record<string, unknown>[];  // array of row objects
    rowCount: number;
    elapsedMs: number;
  };
}

export interface StatsResult {
  requestId: RequestId;
  type: 'STATS_RESULT';
  payload: {
    tableName: string;
    totalRows: number;
    columns: ColumnInfo[];
  };
}

export interface WorkerError {
  requestId: RequestId;
  type: 'ERROR';
  payload: {
    code: WorkerErrorCode;
    message: string;
    details?: unknown;
  };
}

/** Union of all messages the worker can send */
export type WorkerResponse =
  | InitDuckDBReady
  | LoadCSVProgress
  | LoadCSVComplete
  | QueryResult
  | StatsResult
  | WorkerError;
