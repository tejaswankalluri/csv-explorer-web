import * as duckdb from '@duckdb/duckdb-wasm';

export let db: duckdb.AsyncDuckDB | null = null;
export let conn: duckdb.AsyncDuckDBConnection | null = null;

type DuckDBLogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

/**
 * Initialize DuckDB WASM inside this worker thread.
 *
 * Strategy: Use JSDelivr bundles for WASM delivery. DuckDB's selectBundle()
 * picks the best bundle (EH if supported, else MVP) for the current browser.
 * We do NOT use createWorker() — DuckDB runs directly in this worker thread.
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

  db = new duckdb.AsyncDuckDB(logger);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();

  const result = await conn.query('SELECT version() AS version');
  const rows = result.toArray();
  const firstRow = rows[0] as Record<string, unknown> | undefined;

  return (firstRow?.version as string | undefined) ?? 'unknown';
}
