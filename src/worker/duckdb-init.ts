import * as duckdb from '@duckdb/duckdb-wasm';

export let db: duckdb.AsyncDuckDB | null = null;
export let conn: duckdb.AsyncDuckDBConnection | null = null;

type DuckDBLogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

/**
 * Initialize DuckDB WASM using CDN bundles.
 * Creates a separate worker for DuckDB to run in.
 */
export async function initializeDuckDB(
  logLevel: DuckDBLogLevel = 'WARNING'
): Promise<string> {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

  const logLevelMap: Record<DuckDBLogLevel, duckdb.LogLevel> = {
    DEBUG: duckdb.LogLevel.DEBUG,
    INFO: duckdb.LogLevel.INFO,
    WARNING: duckdb.LogLevel.WARNING,
    ERROR: duckdb.LogLevel.ERROR,
  };

  const logger = new duckdb.ConsoleLogger(logLevelMap[logLevel]);

  // Create a worker from the bundle's mainWorker URL
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], {
      type: 'text/javascript',
    })
  );
  const worker = new Worker(workerUrl);

  // Pass the worker to AsyncDuckDB
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  
  URL.revokeObjectURL(workerUrl);
  
  conn = await db.connect();

  const result = await conn.query('SELECT version() AS version');
  const rows = result.toArray();
  const firstRow = rows[0] as Record<string, unknown> | undefined;

  return (firstRow?.version as string | undefined) ?? 'unknown';
}
