# DuckDB WASM Implementation Research

## Overview

DuckDB-WASM is a WebAssembly port of DuckDB, an in-process analytical SQL OLAP database. It enables running full SQL queries directly in the browser without any backend server.

## Key Features

- **Full SQL Support**: Complex joins, window functions, aggregations
- **Multiple File Formats**: CSV, Parquet, JSON
- **Apache Arrow Integration**: Efficient columnar data transfer
- **Web Worker Support**: Offload processing from main thread
- **Remote File Support**: Query Parquet/CSV via HTTP without full download
- **Privacy-First**: Data never leaves the browser

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Main Thread   │────▶│   Web Worker     │────▶│  DuckDB WASM    │
│   (React UI)    │     │  (DuckDB Engine) │     │   (WASM Module) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Installation

```bash
npm install @duckdb/duckdb-wasm
```

## Basic Initialization

### Using JSDelivr CDN (Recommended for Development)

```typescript
import * as duckdb from '@duckdb/duckdb-wasm';

async function initDuckDB() {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
  
  const worker = await duckdb.createWorker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  
  return db;
}
```

### Using Manual Bundles (For Production)

```typescript
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdb_wasm,
    mainWorker: mvp_worker,
  },
  eh: {
    mainModule: duckdb_wasm_eh,
    mainWorker: eh_worker,
  },
};

const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```

## Bundle Types

| Bundle | Description | Use Case |
|--------|-------------|----------|
| mvp | Minimum Viable Product | Basic functionality, smaller size |
| eh | Exception Handling | Better error handling, larger |

## Core Operations

### Creating a Connection

```typescript
const conn = await db.connect();
```

### Query Execution

```typescript
const result = await conn.query('SELECT * FROM table LIMIT 10');
const rows = result.toArray();
```

### Working with CSV Files

```typescript
// Register CSV content
await db.registerFileText('data.csv', csvContent);

// Query using read_csv_auto
const result = await conn.query(`
  SELECT * FROM read_csv_auto('data.csv')
  WHERE column1 > 100
  ORDER BY column2 DESC
  LIMIT 10
`);
```

### Working with Parquet Files

```typescript
// Local file
await db.registerFileText('data.parquet', parquetBuffer);

// Remote file (DuckDB fetches only needed columns/rows)
await db.registerFileURL(
  'sales.parquet',
  'https://example.com/data.parquet',
  duckdb.DuckDBDataProtocol.HTTP,
  false
);

const result = await conn.query(`
  SELECT column, SUM(value) as total
  FROM 'sales.parquet'
  GROUP BY column
`);
```

## Web Worker Setup

For heavy processing, run DuckDB in a Web Worker:

### worker.ts

```typescript
import * as duckdb from '@duckdb/duckdb-wasm';

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
const worker = await duckdb.createWorker(bundle.mainWorker);
const logger = new duckdb.ConsoleLogger();
db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
conn = await db.connect();

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, requestId } = e.data;
  
  try {
    switch (type) {
      case 'QUERY':
        const result = await conn!.query(payload.sql);
        self.postMessage({ type: 'QUERY_RESULT', payload: result.toArray(), requestId });
        break;
      case 'REGISTER_CSV':
        await db!.registerFileText(payload.name, payload.content);
        self.postMessage({ type: 'REGISTER_COMPLETE', requestId });
        break;
    }
  } catch (error) {
    self.postMessage({ type: 'ERROR', payload: error.message, requestId });
  }
};
```

### Main Thread Usage

```typescript
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

worker.postMessage({
  type: 'QUERY',
  payload: { sql: 'SELECT * FROM data.csv LIMIT 10' },
  requestId: '1'
});

worker.onmessage = (e) => {
  console.log(e.data.payload);
};
```

## Data Types

### Supported Types

- INTEGER, BIGINT, SMALLINT, TINYINT
- DOUBLE, FLOAT, REAL
- VARCHAR, CHAR
- BOOLEAN
- DATE, TIME, TIMESTAMP
- BLOB

### TypeScript Mapping

```typescript
// Query with type hints
const result = await conn.query<{ id: number; name: string }>(
  'SELECT id, name FROM users'
);
```

## Performance Optimization

### 1. Use Streaming for Large Results

```typescript
const stream = await conn.send(`
  SELECT * FROM large_table WHERE conditions
`);

for await (const batch of stream) {
  // Process batch
  console.log(batch.toArray());
}
```

### 2. Column Pruning

```typescript
// Good: Select only needed columns
await conn.query('SELECT id, name FROM users');

// Avoid: Select all columns
await conn.query('SELECT * FROM users');
```

### 3. Filter Early

```typescript
// Apply WHERE before aggregations
await conn.query(`
  SELECT category, SUM(amount)
  FROM sales
  WHERE date >= '2024-01-01'
  GROUP BY category
`);
```

### 4. Use Parquet over CSV

Parquet is columnar and compressed, offering better query performance.

## Error Handling

```typescript
try {
  const result = await conn.query(userQuery);
  return result.toArray();
} catch (error) {
  if (error.message.includes('syntax error')) {
    throw new Error('Invalid SQL syntax');
  }
  if (error.message.includes('CSV')) {
    throw new Error('Failed to parse CSV file');
  }
  throw error;
}
```

## Logging Levels

```typescript
import { LogLevel } from '@duckdb/duckdb-wasm';

const logger = new duckdb.ConsoleLogger(LogLevel.DEBUG);
const logger = new duckdb.ConsoleLogger(LogLevel.INFO);
const logger = new duckdb.ConsoleLogger(LogLevel.WARNING);
const logger = new duckdb.ConsoleLogger(LogLevel.ERROR);
```

## Integration with React

```typescript
import { useState, useEffect, useRef } from 'react';
import * as duckdb from '@duckdb/duckdb-wasm';

export function useDuckDB() {
  const [db, setDb] = useState<duckdb.AsyncDuckDB | null>(null);
  const [conn, setConn] = useState<duckdb.AsyncDuckDBConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
        const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
        const worker = await duckdb.createWorker(bundle.mainWorker);
        const logger = new duckdb.ConsoleLogger();
        const database = new duckdb.AsyncDuckDB(logger, worker);
        await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
        const connection = await database.connect();
        
        setDb(database);
        setConn(connection);
        setLoading(false);
      } catch (e) {
        setError(e as Error);
        setLoading(false);
      }
    }
    init();
  }, []);

  return { db, conn, loading, error };
}
```

## Vite Configuration

For Vite projects, add the following to handle WASM files:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  build: {
    target: 'esnext',
  },
});
```

## Limitations

1. **Memory**: Browser memory limits apply (typically 2-4GB)
2. **No Persistent Storage**: Data is lost on page refresh (use IndexedDB for persistence)
3. **HTTP Range**: Remote file fetching requires server support for range requests
4. **Threading**: Pthreads may have limitations in some browsers

## File Size Recommendations

| File Type | Recommended Size | Notes |
|-----------|------------------|-------|
| CSV | Up to 500MB | Parse in chunks for larger files |
| Parquet | Up to 2GB | Only fetches needed columns/rows |
| JSON | Up to 100MB | Columnar formats preferred |

## Common Issues

### CORS Errors

When loading remote files:
```typescript
// Use HTTPS and ensure server supports CORS
await db.registerFileURL(
  'data.parquet',
  'https://example.com/data.parquet',
  duckdb.DuckDBDataProtocol.HTTP,
  false  // not async
);
```

### Worker Initialization Fails

Ensure proper MIME types are set for WASM and worker files when serving statically.

### Memory Issues

- Process data in chunks
- Use LIMIT clauses
- Close connections when done

## Resources

- [Official DuckDB-WASM GitHub](https://github.com/duckdb/duckdb-wasm)
- [DuckDB Documentation](https://duckdb.org/docs/stable/clients/wasm)
- [NPM Package](https://www.npmjs.com/package/@duckdb/duckdb-wasm)
