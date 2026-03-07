import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { ColumnInfo } from '../types/worker-protocol';

export interface QueryExecutionResult {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}

export class CancelledQueryError extends Error {
  constructor() {
    super('Query cancelled');
    this.name = 'CancelledQueryError';
  }
}

function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
}

export async function executeQuery(
  conn: AsyncDuckDBConnection,
  sql: string,
  signal: { cancelled: boolean }
): Promise<QueryExecutionResult> {
  const startTime = performance.now();

  if (signal.cancelled) {
    throw new CancelledQueryError();
  }

  const result = await conn.query(sql);

  if (signal.cancelled) {
    throw new CancelledQueryError();
  }

  const rows = result.toArray().map((row: unknown) => {
    const obj: Record<string, unknown> = {};
    const rowObj = row as Record<string, unknown>;
    for (const key of Object.keys(rowObj)) {
      obj[key] = serializeValue(rowObj[key]);
    }
    return obj;
  });

  const columns: ColumnInfo[] = result.schema.fields.map((field) => ({
    name: field.name,
    type: field.type.toString(),
    nullable: field.nullable,
  }));

  const elapsedMs = performance.now() - startTime;

  return {
    columns,
    rows,
    rowCount: rows.length,
    elapsedMs,
  };
}
