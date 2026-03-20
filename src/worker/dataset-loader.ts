import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type {
  ColumnInfo,
  LoadDatasetProgress,
  LoadDatasetRequest,
  SupportedFileType,
} from '../types/worker-protocol';

const TABLE_NAME = 'data';

type ProgressCallback = (progress: LoadDatasetProgress) => void;

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

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getFallbackFileName(fileType: SupportedFileType): string {
  switch (fileType) {
    case 'csv':
      return 'upload.csv';
    case 'parquet':
      return 'upload.parquet';
    case 'xlsx':
      return 'upload.xlsx';
  }
}

async function dropRegisteredFile(
  db: AsyncDuckDB,
  registeredName: string,
): Promise<void> {
  try {
    await db.dropFile(registeredName);
  } catch {
    // Best effort cleanup.
  }
}

async function cleanupAfterCancellation(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  registeredName: string,
): Promise<void> {
  try {
    await conn.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
  } catch {
    // Best effort cleanup.
  }

  await dropRegisteredFile(db, registeredName);
}

async function ensureExtensionLoaded(
  conn: AsyncDuckDBConnection,
  fileType: SupportedFileType,
): Promise<void> {
  if (fileType === 'parquet') {
    await conn.query('LOAD parquet');
  }

  if (fileType === 'xlsx') {
    await conn.query('LOAD excel');
  }
}

function buildCreateTableSql(
  registeredName: string,
  fileType: SupportedFileType,
): string {
  switch (fileType) {
    case 'csv':
      return `CREATE TABLE "${TABLE_NAME}" AS SELECT * FROM read_csv_auto('${registeredName}')`;
    case 'parquet':
      return `CREATE TABLE "${TABLE_NAME}" AS SELECT * FROM read_parquet('${registeredName}')`;
    case 'xlsx':
      return `CREATE TABLE "${TABLE_NAME}" AS SELECT * FROM read_xlsx('${registeredName}')`;
  }
}

function throwIfCancelled(signal: { cancelled: boolean }): void {
  if (signal.cancelled) {
    throw new CancelledError();
  }
}

export async function loadDataset(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  request: LoadDatasetRequest,
  onProgress: ProgressCallback,
  signal: { cancelled: boolean },
): Promise<LoadResult> {
  const startTime = performance.now();
  const { fileName, fileContent, fileType } = request.payload;
  const totalBytes = fileContent.byteLength;
  const registeredName =
    sanitizeFileName(fileName) || getFallbackFileName(fileType);

  throwIfCancelled(signal);

  onProgress({
    requestId: request.requestId,
    type: 'LOAD_DATASET_PROGRESS',
    payload: {
      rowsLoaded: 0,
      bytesProcessed: 0,
      totalBytes,
      phase: 'registering',
    },
  });

  await db.registerFileBuffer(registeredName, new Uint8Array(fileContent));

  try {
    throwIfCancelled(signal);
    await ensureExtensionLoaded(conn, fileType);
    await conn.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    throwIfCancelled(signal);

    onProgress({
      requestId: request.requestId,
      type: 'LOAD_DATASET_PROGRESS',
      payload: {
        rowsLoaded: 0,
        bytesProcessed: totalBytes,
        totalBytes,
        phase: 'importing',
      },
    });

    await conn.query(buildCreateTableSql(registeredName, fileType));

    throwIfCancelled(signal);

    const countResult = await conn.query(
      `SELECT COUNT(*)::BIGINT AS cnt FROM "${TABLE_NAME}"`,
    );
    const countRows = countResult.toArray();
    const totalRows = Number(
      (countRows[0] as Record<string, unknown>)?.cnt ?? 0,
    );

    const describeResult = await conn.query(`DESCRIBE "${TABLE_NAME}"`);
    const describeRows = describeResult.toArray() as Record<string, unknown>[];
    const columns: ColumnInfo[] = describeRows.map((row) => ({
      name: row['column_name'] as string,
      type: row['column_type'] as string,
      nullable: row['null'] !== 'NO',
    }));

    const elapsedMs = performance.now() - startTime;

    return { tableName: TABLE_NAME, totalRows, columns, elapsedMs };
  } catch (error) {
    if (error instanceof CancelledError) {
      await cleanupAfterCancellation(db, conn, registeredName);
    }

    throw error;
  } finally {
    await dropRegisteredFile(db, registeredName);
  }
}
