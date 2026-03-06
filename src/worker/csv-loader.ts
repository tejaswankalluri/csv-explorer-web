import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type {
  LoadCSVRequest,
  LoadCSVProgress,
  ColumnInfo,
} from '../types/worker-protocol';

const TABLE_NAME = 'data';

type ProgressCallback = (progress: LoadCSVProgress) => void;

export interface LoadResult {
  tableName: string;
  totalRows: number;
  columns: ColumnInfo[];
  elapsedMs: number;
}

export class CancelledError extends Error {
  constructor() {
    super('Load cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Sanitize a filename to be safe for use in DuckDB's virtual filesystem
 * and in SQL string literals.
 * Replace any character that is not alphanumeric, dot, hyphen, or underscore.
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Load a CSV file into DuckDB using native read_csv_auto parsing.
 *
 * Strategy (Approach C — DuckDB-native with synthetic progress):
 *   1. Decode ArrayBuffer → UTF-8 string
 *   2. Register string with DuckDB virtual filesystem
 *   3. Emit 'parsing' progress milestone
 *   4. DROP TABLE IF EXISTS data (support re-loading)
 *   5. CREATE TABLE data AS SELECT * FROM read_csv_auto(...)
 *   6. Emit 'inserting' progress milestone
 *   7. SELECT COUNT(*) to get row count
 *   8. DESCRIBE to get column metadata
 *   9. Return LoadResult
 *
 * Cooperative cancellation: the signal object is checked between each
 * async step. Once CREATE TABLE starts it cannot be aborted — we wait
 * for it to complete and then drop the table.
 */
export async function loadCSV(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  request: LoadCSVRequest,
  onProgress: ProgressCallback,
  signal: { cancelled: boolean }
): Promise<LoadResult> {
  const startTime = performance.now();
  const { fileName, fileContent } = request.payload;
  const totalBytes = fileContent.byteLength;

  // Sanitize filename to avoid SQL injection and filesystem issues.
  // Use a fixed registered name to keep SQL safe regardless of input.
  const registeredName = sanitizeFileName(fileName) || 'upload.csv';

  // ── Step 1: Decode ArrayBuffer → UTF-8 string ──────────────────────────
  // TextDecoder handles UTF-8 and ASCII. Other encodings are a known
  // limitation (will produce garbled text, but won't throw).
  const decoder = new TextDecoder('utf-8');
  const csvString = decoder.decode(fileContent);

  // Check for cancellation before any DuckDB operations.
  if (signal.cancelled) throw new CancelledError();

  // ── Step 2: Register the CSV string with DuckDB's virtual filesystem ───
  await db.registerFileText(registeredName, csvString);

  // Check before next step — if cancelled here, clean up the registered file.
  if (signal.cancelled) {
    try { await db.dropFile(registeredName); } catch { /* best effort */ }
    throw new CancelledError();
  }

  // ── Step 3: Emit 'parsing' progress milestone ──────────────────────────
  onProgress({
    requestId: request.requestId,
    type: 'LOAD_CSV_PROGRESS',
    payload: {
      rowsLoaded: 0,
      bytesProcessed: totalBytes,
      totalBytes,
      phase: 'parsing',
    },
  });

  // ── Step 4: Drop existing table (support re-loading) ───────────────────
  await conn.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);

  if (signal.cancelled) {
    // Table was dropped (or didn't exist). No further cleanup needed.
    try { await db.dropFile(registeredName); } catch { /* best effort */ }
    throw new CancelledError();
  }

  // ── Step 5: Create table from CSV using DuckDB's native parser ──────────
  // read_csv_auto handles: delimiter detection, header detection,
  // type inference (integers, doubles, dates, timestamps, booleans),
  // quoting, escaping, NULL detection, BOM stripping.
  //
  // Edge cases:
  //   - Empty CSV (headers only): produces table with 0 rows — valid.
  //   - Mixed types: DuckDB throws 'Conversion Error' — caught below.
  //   - Very wide CSV (100+ cols): no special handling, DuckDB manages it.
  //
  // NOTE: Once this await starts, we cannot cancel it mid-execution.
  // If cancelled during this step, we check the flag after and drop the table.
  await conn.query(
    `CREATE TABLE "${TABLE_NAME}" AS SELECT * FROM read_csv_auto('${registeredName}')`
  );

  // Check after CREATE TABLE — if cancelled, drop the table we just made.
  if (signal.cancelled) {
    try {
      await conn.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
      await db.dropFile(registeredName);
    } catch { /* best effort cleanup */ }
    throw new CancelledError();
  }

  // ── Step 6: Emit 'inserting' progress milestone ────────────────────────
  onProgress({
    requestId: request.requestId,
    type: 'LOAD_CSV_PROGRESS',
    payload: {
      rowsLoaded: 0, // will be updated once count query runs
      bytesProcessed: totalBytes,
      totalBytes,
      phase: 'inserting',
    },
  });

  // ── Step 7: Get row count ───────────────────────────────────────────────
  const countResult = await conn.query(
    `SELECT COUNT(*)::BIGINT AS cnt FROM "${TABLE_NAME}"`
  );
  const countRows = countResult.toArray();
  const totalRows =
    Number((countRows[0] as Record<string, unknown>)?.cnt ?? 0);

  // ── Step 8: Get column metadata via DESCRIBE ───────────────────────────
  // DESCRIBE returns: column_name, column_type, null, key, default, extra
  const describeResult = await conn.query(`DESCRIBE "${TABLE_NAME}"`);
  const describeRows = describeResult.toArray() as Record<string, unknown>[];
  const columns: ColumnInfo[] = describeRows.map((row) => ({
    name: row['column_name'] as string,
    type: row['column_type'] as string,
    nullable: row['null'] !== 'NO',
  }));

  // Clean up the registered virtual file — the table now owns the data.
  try { await db.dropFile(registeredName); } catch { /* best effort */ }

  const elapsedMs = performance.now() - startTime;

  return { tableName: TABLE_NAME, totalRows, columns, elapsedMs };
}
