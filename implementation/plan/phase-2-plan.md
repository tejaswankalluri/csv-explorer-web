# Phase 2: CSV Ingestion Pipeline

## Context

Phase 1 is complete. We have:
- **Worker protocol types** (`src/types/worker-protocol.ts`) — discriminated unions for all messages including `LOAD_CSV`, `LOAD_CSV_PROGRESS`, `LOAD_CSV_COMPLETE`
- **DuckDB worker** (`src/worker/duckdb.worker.ts` + `duckdb-init.ts`) — initializes DuckDB WASM, routes messages, but `LOAD_CSV` case returns "not yet implemented"
- **WorkerClient** (`src/lib/worker-client.ts`) — main-thread client with request correlation, streaming `onStream` callback for progress, cancel support, and Transferable-aware `postMessage`
- **App shell** — `src/App.tsx` is still the default Vite counter demo. No application UI exists.

Phase 2 builds the CSV ingestion pipeline: the user selects a file, it gets transferred to the worker, parsed, loaded into DuckDB, and the UI reflects progress throughout.

---

## Architectural Decision: CSV Parsing Strategy

### The Problem

There are two fundamentally different ways to load CSV data into DuckDB WASM:

**Approach A — DuckDB-native parsing (registerFileText + read_csv_auto)**
```
ArrayBuffer → TextDecoder → string → db.registerFileText('data.csv', csvString)
→ conn.query("CREATE TABLE data AS SELECT * FROM read_csv_auto('data.csv')")
```
- DuckDB's C++ CSV parser handles everything: type inference, header detection, delimiter detection, quoting, escaping.
- Single SQL call. DuckDB optimizes internally.
- **Problem**: No progress reporting. `registerFileText` requires the *entire* CSV as a string in memory. For a 500MB file, this means ~500MB string + DuckDB's internal copy = ~1GB peak memory. And the `CREATE TABLE` call is a single blocking await with no intermediate progress callbacks.

**Approach B — Papa Parse chunks → batched INSERT**
```
ArrayBuffer → TextDecoder → Papa Parse stream → chunk callback (N rows)
→ conn.query("INSERT INTO data VALUES (...), (...), ...")
→ repeat per chunk → emit progress after each batch
```
- Papa Parse streams the CSV in chunks, giving us a callback every N rows.
- We INSERT each batch into DuckDB, sending a `LOAD_CSV_PROGRESS` message after each.
- **Problem**: We have to create the table schema ourselves (from the first chunk), handle type coercion, and lose DuckDB's superior type inference. Batched INSERT is slower than DuckDB's native bulk loader. We also add Papa Parse as a runtime dependency in the worker.

**Approach C — Hybrid: DuckDB-native parsing with synthetic progress (CHOSEN)**
```
ArrayBuffer → TextDecoder → string → db.registerFileText('data.csv', csvString)
→ progress: { phase: 'parsing', bytesProcessed: totalBytes, totalBytes }
→ conn.query("CREATE TABLE data AS SELECT * FROM read_csv_auto('data.csv')")
→ progress: { phase: 'inserting', bytesProcessed: totalBytes, totalBytes }
→ conn.query("SELECT COUNT(*) FROM data") → totalRows
→ conn.query("DESCRIBE data") → columns
→ LOAD_CSV_COMPLETE
```

### Decision: Approach C — DuckDB-native with synthetic progress

**Rationale:**

1. **DuckDB's CSV parser is better than Papa Parse for this use case.** It handles type inference (integers, doubles, dates, timestamps, booleans — not just strings), handles edge cases (quoted delimiters, multi-line fields, BOM detection), and is written in optimized C++. Re-implementing this with Papa Parse would be error-prone and slower.

2. **Progress granularity is acceptable.** For a 5M-row CSV (~200-500MB), the `registerFileText` call (string copy) takes 1-3 seconds and the `CREATE TABLE` takes 3-10 seconds. We report two progress milestones: "file registered" and "table created". The total ingest time is under 15 seconds for most files — fine without per-row progress.

3. **Memory is the real concern, not progress.** For very large files, we need to be honest: `registerFileText` requires the whole file in memory as a string. This is a known DuckDB WASM limitation. Our `LOAD_CSV_PROGRESS` messages will report the `phase` ('parsing' or 'inserting') so the UI shows what's happening, even if it can't show a smooth percentage bar.

4. **Papa Parse becomes unnecessary for Phase 2.** We still have it installed for potential future use (preview mode, schema inspection before full load), but the core ingest path uses DuckDB natively.

**Tradeoff acknowledged:** If we later need per-row progress for very large files, we can add an optional Papa Parse chunked path as an alternative strategy. But for the MVP, DuckDB-native is simpler, faster, and more correct.

### Memory Budget

| File Size | `ArrayBuffer` | `TextDecoder` string | `registerFileText` copy | DuckDB table | Peak |
|-----------|--------------|---------------------|------------------------|-------------|------|
| 100MB | 100MB | 100MB | ~100MB (internal) | ~80MB | ~380MB |
| 500MB | 500MB | 500MB | ~500MB (internal) | ~400MB | ~1.9GB |

The browser typically allows 2-4GB per tab. For files over ~500MB, we'll hit limits. The plan:
- Files under 500MB: proceed normally.
- Files over 500MB: warn the user before loading (future enhancement, not Phase 2).
- After `registerFileText` completes, the original `ArrayBuffer` is no longer needed (it was transferred from the main thread and the string was passed to DuckDB), so memory should stabilize to DuckDB's table size.

---

## Task Breakdown

### TASK-007: File Upload UI and File Handoff to Worker

**Goal:** Build the file selection UI and the React hook that manages the worker lifecycle and hands files to it.

**Files:**
- `src/components/FileUpload.tsx` — File selection UI component
- `src/hooks/useWorker.ts` — React hook managing Worker + WorkerClient lifecycle
- `src/App.tsx` — Replace Vite demo with application shell

#### Architectural Note: Why a Hook

The `WorkerClient` from Phase 1 is a plain class. React needs a bridge:
- Create the Worker and WorkerClient once (not on every render)
- Clean up on unmount (`destroy()`)
- Expose `request()` and `cancel()` to components
- Track worker readiness state (not initialized → initializing → ready → error)

The `useWorker` hook encapsulates this lifecycle.

#### useWorker Hook

```typescript
// src/hooks/useWorker.ts
import { useEffect, useRef, useState, useCallback } from 'react';
import { WorkerClient } from '../lib/worker-client';
import type {
  WorkerResponse,
  InitDuckDBReady,
} from '../types/worker-protocol';

type WorkerStatus = 'idle' | 'initializing' | 'ready' | 'error';

interface UseWorkerReturn {
  status: WorkerStatus;
  error: string | null;
  client: WorkerClient | null;
}

export function useWorker(): UseWorkerReturn {
  const [status, setStatus] = useState<WorkerStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<WorkerClient | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL('../worker/duckdb.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const client = new WorkerClient(worker);
    clientRef.current = client;

    setStatus('initializing');

    client
      .request<InitDuckDBReady>('INIT_DUCKDB', { logLevel: 'WARNING' })
      .then(() => {
        setStatus('ready');
      })
      .catch((err) => {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      client.destroy();
      clientRef.current = null;
    };
  }, []);

  return { status, error, client: clientRef.current };
}
```

**Design decisions:**
- `useRef` for `client` — avoids re-renders when the client object itself doesn't change
- Worker created in `useEffect` — one-time initialization
- Cleanup calls `destroy()` — terminates worker, rejects pending requests
- DuckDB initialization happens automatically — the hook returns `status: 'ready'` only after DuckDB is confirmed initialized

#### FileUpload Component

```typescript
// src/components/FileUpload.tsx

interface FileUploadProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

export function FileUpload({ onFileSelected, disabled }: FileUploadProps) {
  // Accepts .csv files
  // Drag-and-drop zone + click-to-browse
  // Shows selected file name and size
  // Calls onFileSelected(file) when user picks a file
}
```

The component is intentionally simple — a file input with drag-and-drop. It does **not** read the file or send it to the worker. That responsibility belongs to the orchestrating parent (App), keeping the component reusable and testable.

#### File Handoff Flow

```
User selects file
       │
       ▼
FileUpload calls onFileSelected(file: File)
       │
       ▼
App reads file as ArrayBuffer:  file.arrayBuffer()
       │
       ▼
App calls client.request('LOAD_CSV', {
  fileName: file.name,
  fileContent: arrayBuffer,
  ...
}, {
  transfer: [arrayBuffer],          // zero-copy transfer
  onStream: handleProgress,         // LOAD_CSV_PROGRESS callback
  timeoutMs: 300_000,               // 5 min timeout for large files
})
       │
       ▼
ArrayBuffer is transferred (not copied) to the worker.
Main thread's ArrayBuffer becomes detached (zero bytes).
```

**Key detail: `file.arrayBuffer()` vs `FileReader`.**
`File.arrayBuffer()` returns a Promise and is the modern API. It reads the entire file into memory. For a 500MB file, this uses 500MB on the main thread *temporarily* until the transfer. After `postMessage` with the transfer list, the main thread releases the memory.

#### App Shell

Replace `src/App.tsx` with the application layout:

```typescript
// src/App.tsx — conceptual structure
function App() {
  const { status, error, client } = useWorker();

  // Ingest state
  const [ingestState, setIngestState] = useState<IngestState>({ phase: 'idle' });

  async function handleFileSelected(file: File) {
    const buffer = await file.arrayBuffer();
    setIngestState({ phase: 'loading', progress: { ... } });

    try {
      const result = await client.request('LOAD_CSV', {
        fileName: file.name,
        fileContent: buffer,
      }, {
        transfer: [buffer],
        onStream: (msg) => {
          // Update progress state from LOAD_CSV_PROGRESS
        },
        timeoutMs: 300_000,
      });
      setIngestState({ phase: 'complete', ... });
    } catch (err) {
      setIngestState({ phase: 'error', message: err.message });
    }
  }

  return (
    <div>
      {status !== 'ready' && <InitializingScreen status={status} error={error} />}
      {status === 'ready' && ingestState.phase === 'idle' && (
        <FileUpload onFileSelected={handleFileSelected} />
      )}
      {ingestState.phase === 'loading' && <ProgressBar ... />}
      {ingestState.phase === 'complete' && <div>Table placeholder</div>}
      {ingestState.phase === 'error' && <ErrorDisplay ... />}
    </div>
  );
}
```

**Acceptance Criteria:**
- [ ] User can select a CSV file via click or drag-and-drop
- [ ] File selection is disabled while DuckDB is initializing (status !== 'ready')
- [ ] Selected file is read as `ArrayBuffer` and sent to the worker via `LOAD_CSV`
- [ ] The `ArrayBuffer` is transferred (not copied) — verify via `buffer.byteLength === 0` after `postMessage`
- [ ] The `useWorker` hook initializes DuckDB automatically and reports status
- [ ] Worker cleanup happens on component unmount

---

### TASK-008: Progressive CSV Parsing with Papa Parse... or Not

**Goal:** Implement the `LOAD_CSV` handler in the worker that takes an `ArrayBuffer`, registers it with DuckDB, and creates a queryable table.

**File:** `src/worker/csv-loader.ts` (new) — CSV loading logic, separated from the worker entry point for testability.

#### Why Not Papa Parse (For Now)

As decided in the architectural section above, Phase 2 uses DuckDB's native `read_csv_auto` rather than Papa Parse chunked parsing. The `LOAD_CSV` handler:

1. Decodes `ArrayBuffer` to string via `TextDecoder`
2. Registers the string with DuckDB via `db.registerFileText()`
3. Creates a table via `CREATE TABLE data AS SELECT * FROM read_csv_auto('data.csv')`
4. Queries metadata: `SELECT COUNT(*)` and `DESCRIBE`
5. Sends progress messages at key milestones

Papa Parse remains installed but unused in the critical path. It may be used later for:
- CSV preview (showing first N rows before committing to full load)
- Schema inspection / delimiter detection before DuckDB ingestion
- A fallback chunked path for per-row progress on very large files

#### CSV Loader Implementation

```typescript
// src/worker/csv-loader.ts
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type {
  LoadCSVRequest,
  LoadCSVProgress,
  LoadCSVComplete,
  ColumnInfo,
} from '../types/worker-protocol';

const TABLE_NAME = 'data';

type ProgressCallback = (progress: LoadCSVProgress) => void;

interface LoadResult {
  tableName: string;
  totalRows: number;
  columns: ColumnInfo[];
  elapsedMs: number;
}

export async function loadCSV(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  request: LoadCSVRequest,
  onProgress: ProgressCallback
): Promise<LoadResult> {
  const startTime = performance.now();
  const { fileName, fileContent } = request.payload;
  const totalBytes = fileContent.byteLength;

  // Step 1: Decode ArrayBuffer → string
  const decoder = new TextDecoder('utf-8');
  const csvString = decoder.decode(fileContent);

  // Step 2: Register the CSV string with DuckDB's virtual filesystem
  await db.registerFileText(fileName, csvString);

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

  // Step 3: Drop existing table if any (support re-loading)
  await conn.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);

  // Step 4: Create table from CSV using DuckDB's native parser
  //   read_csv_auto handles: delimiter detection, header detection,
  //   type inference, quoting, escaping, NULL detection
  await conn.query(`
    CREATE TABLE "${TABLE_NAME}" AS
    SELECT * FROM read_csv_auto('${fileName}')
  `);

  onProgress({
    requestId: request.requestId,
    type: 'LOAD_CSV_PROGRESS',
    payload: {
      rowsLoaded: 0,    // will be filled in after count query
      bytesProcessed: totalBytes,
      totalBytes,
      phase: 'inserting',
    },
  });

  // Step 5: Get row count
  const countResult = await conn.query(
    `SELECT COUNT(*)::INTEGER AS cnt FROM "${TABLE_NAME}"`
  );
  const countRows = countResult.toArray();
  const totalRows = (countRows[0] as Record<string, unknown>)?.cnt as number ?? 0;

  // Step 6: Get column metadata
  const describeResult = await conn.query(`DESCRIBE "${TABLE_NAME}"`);
  const describeRows = describeResult.toArray() as Record<string, unknown>[];
  const columns: ColumnInfo[] = describeRows.map((row) => ({
    name: row.column_name as string,
    type: row.column_type as string,
    nullable: row.null !== 'NO',
  }));

  const elapsedMs = performance.now() - startTime;

  return { tableName: TABLE_NAME, totalRows, columns, elapsedMs };
}
```

#### Worker Integration

The `LOAD_CSV` case in `duckdb.worker.ts` needs to call `loadCSV`:

```typescript
// In duckdb.worker.ts, replace the LOAD_CSV stub:

case 'LOAD_CSV': {
  if (!db || !conn) {
    respond<WorkerError>({
      requestId: msg.requestId,
      type: 'ERROR',
      payload: {
        code: WorkerErrorCode.INIT_FAILED,
        message: 'DuckDB not initialized. Send INIT_DUCKDB first.',
      },
    });
    break;
  }

  try {
    const result = await loadCSV(db, conn, msg, (progress) => {
      respond<LoadCSVProgress>(progress);
    });

    respond<LoadCSVComplete>({
      requestId: msg.requestId,
      type: 'LOAD_CSV_COMPLETE',
      payload: result,
    });
  } catch (loadError) {
    respond<WorkerError>({
      requestId: msg.requestId,
      type: 'ERROR',
      payload: {
        code: WorkerErrorCode.CSV_PARSE_ERROR,
        message: loadError instanceof Error
          ? loadError.message
          : String(loadError),
        details: loadError instanceof Error ? loadError.stack : undefined,
      },
    });
  }
  break;
}
```

#### Design Notes

1. **Table name is fixed: `data`**. We support one loaded CSV at a time. If the user loads a new file, `DROP TABLE IF EXISTS` clears the previous one. Multi-table support is out of scope.

2. **`read_csv_auto` vs explicit options.** DuckDB's `read_csv_auto` auto-detects delimiter, header, and types. The `LoadCSVRequest` protocol includes `delimiter` and `hasHeader` options — these can be passed to `read_csv_auto` as overrides in a future enhancement:
   ```sql
   SELECT * FROM read_csv_auto('file.csv', header=true, delim=',')
   ```
   For now, we trust auto-detection.

3. **SQL injection via filename.** The `fileName` is user-provided. Since it's used as a registered virtual filename (not a filesystem path), and DuckDB's `registerFileText` treats it as an opaque key, this is safe. However, we still single-quote it in the SQL string. If the filename contains a single quote, it would break. Mitigation: sanitize the filename before use (replace `'` with `_`), or use a fixed name like `upload.csv`.

4. **`DESCRIBE` output format.** DuckDB's `DESCRIBE` returns columns: `column_name`, `column_type`, `null`, `key`, `default`, `extra`. We extract `column_name`, `column_type`, and `null` to build `ColumnInfo[]`.

**Acceptance Criteria:**
- [ ] Worker handles `LOAD_CSV` messages without errors
- [ ] A valid CSV file results in a `LOAD_CSV_COMPLETE` response with correct `totalRows` and `columns`
- [ ] A malformed CSV results in an `ERROR` response with `code: 'CSV_PARSE_ERROR'`
- [ ] Re-loading a file replaces the previous table (no duplicate table errors)
- [ ] At least one `LOAD_CSV_PROGRESS` message is sent before `LOAD_CSV_COMPLETE`
- [ ] `DuckDB not initialized` error is returned if `LOAD_CSV` is sent before `INIT_DUCKDB`

---

### TASK-009: Chunk Insertion Into DuckDB Table

**Scope Revision:** With Approach C (DuckDB-native parsing), there is no separate "chunk insertion" step. DuckDB's `CREATE TABLE ... AS SELECT * FROM read_csv_auto(...)` handles parsing and table creation atomically. 

**TASK-009's deliverable changes to:** Verify that the DuckDB-native ingestion creates a correctly typed, queryable table — and handle edge cases.

**File:** Same as TASK-008 (`src/worker/csv-loader.ts`) — the logic is unified.

#### Edge Cases to Handle

1. **Empty CSV (headers only, no data rows)**
   ```sql
   CREATE TABLE "data" AS SELECT * FROM read_csv_auto('file.csv')
   -- Result: table with columns but 0 rows. This is valid.
   ```
   `totalRows` will be 0. The UI should show "0 rows loaded" rather than an error.

2. **CSV with no headers**
   DuckDB's `read_csv_auto` will try to infer if the first row is a header. If it guesses wrong, columns get generic names (`column0`, `column1`, ...). The `hasHeader` option from the protocol can override this:
   ```sql
   SELECT * FROM read_csv_auto('file.csv', header=false)
   ```

3. **Very wide CSV (100+ columns)**
   No special handling needed — DuckDB handles this natively. Performance impact is on query time, not ingestion.

4. **Mixed types in a column**
   DuckDB's type inference reads a sample of rows. If early rows look numeric but later rows have text, `read_csv_auto` may fail. DuckDB will throw an error like `"Conversion Error"`. This should be caught and returned as `CSV_PARSE_ERROR`.

5. **File encoding**
   `TextDecoder('utf-8')` handles UTF-8 and ASCII. For other encodings (Latin-1, Windows-1252), the text will be garbled. This is a known limitation — we don't detect encoding. Future enhancement: use a library like `jschardet` for encoding detection.

6. **Filename sanitization**
   Replace problematic characters in the filename before using it in SQL:
   ```typescript
   function sanitizeFileName(name: string): string {
     return name.replace(/[^a-zA-Z0-9._-]/g, '_');
   }
   ```

**Acceptance Criteria:**
- [ ] Empty CSV (headers only) results in `LOAD_CSV_COMPLETE` with `totalRows: 0` and correct columns
- [ ] CSV with numeric, string, date, and boolean columns produces correct DuckDB types
- [ ] Malformed CSV (e.g., inconsistent column counts) returns `CSV_PARSE_ERROR`
- [ ] After loading, `SELECT * FROM "data" LIMIT 10` returns correct rows
- [ ] Re-loading drops the previous table cleanly

---

### TASK-010: Ingest Progress Events to UI

**Goal:** Connect the `LOAD_CSV_PROGRESS` stream to a visible progress indicator in the React UI.

**Files:**
- `src/components/ProgressBar.tsx` — Progress display component
- `src/App.tsx` — Wire progress state

#### Ingest State Machine

The UI tracks ingestion through a state machine:

```
    ┌───────┐     file selected      ┌──────────┐
    │  idle  │──────────────────────▶│ reading   │
    └───────┘                        │ (file.arrayBuffer) │
                                     └─────┬────┘
                                           │ arrayBuffer ready
                                           ▼
                                     ┌──────────┐     LOAD_CSV_PROGRESS
                                     │ loading   │◀──────────────────┐
                                     │           │───────────────────┘
                                     └─────┬────┘
                                           │ LOAD_CSV_COMPLETE
                                           ▼
                                     ┌──────────┐
                                     │ complete  │
                                     └──────────┘

    Any state ───(error)──▶ ┌─────────┐
                            │  error   │
                            └─────────┘
```

```typescript
// src/types/ingest-state.ts

type IngestState =
  | { phase: 'idle' }
  | { phase: 'reading'; fileName: string; fileSize: number }
  | {
      phase: 'loading';
      fileName: string;
      fileSize: number;
      rowsLoaded: number;
      bytesProcessed: number;
      totalBytes: number;
      currentPhase: 'parsing' | 'inserting';
    }
  | {
      phase: 'complete';
      fileName: string;
      tableName: string;
      totalRows: number;
      columns: ColumnInfo[];
      elapsedMs: number;
    }
  | { phase: 'error'; message: string };
```

#### ProgressBar Component

```typescript
// src/components/ProgressBar.tsx

interface ProgressBarProps {
  fileName: string;
  fileSize: number;
  bytesProcessed: number;
  totalBytes: number;
  rowsLoaded: number;
  currentPhase: 'parsing' | 'inserting';
  onCancel?: () => void;
}

export function ProgressBar(props: ProgressBarProps) {
  // Displays:
  // - File name
  // - Phase label: "Registering file..." or "Creating table..."
  // - Progress bar (bytesProcessed / totalBytes percentage)
  // - Cancel button (if onCancel provided)
  //
  // With Approach C (DuckDB-native), progress is coarse:
  //   - 'parsing' phase → bar jumps to ~50%
  //   - 'inserting' phase → bar jumps to ~90%
  //   - complete → bar fills to 100%
  //
  // This is honest — we don't fake smooth progress for operations
  // we can't observe internally.
}
```

#### Progress Callback Wiring

In the App component, the `onStream` callback from `WorkerClient.request()` updates React state:

```typescript
const result = await client.request<LoadCSVComplete>('LOAD_CSV', {
  fileName: file.name,
  fileContent: buffer,
}, {
  transfer: [buffer],
  timeoutMs: 300_000,
  onStream: (msg) => {
    if (msg.type === 'LOAD_CSV_PROGRESS') {
      setIngestState({
        phase: 'loading',
        fileName: file.name,
        fileSize: file.size,
        rowsLoaded: msg.payload.rowsLoaded,
        bytesProcessed: msg.payload.bytesProcessed,
        totalBytes: msg.payload.totalBytes,
        currentPhase: msg.payload.phase,
      });
    }
  },
});
```

**Acceptance Criteria:**
- [ ] Progress indicator appears immediately after file selection
- [ ] Phase label changes between "Registering file..." and "Creating table..."
- [ ] Progress bar shows non-zero state during loading (not stuck at 0%)
- [ ] Cancel button is visible during loading
- [ ] On success, progress is replaced with a completion summary (rows loaded, columns, time taken)
- [ ] On error, progress is replaced with an error message

---

### TASK-011: Ingest Cancel Support

**Goal:** Allow the user to cancel an ongoing CSV load operation.

#### The Challenge

DuckDB WASM operations (`registerFileText`, `conn.query`) are async but **not natively cancellable**. Once `CREATE TABLE ... FROM read_csv_auto(...)` starts executing, there is no way to abort it from JavaScript. The WASM engine is running synchronously inside the async wrapper.

#### Cancellation Strategy

We implement **cooperative cancellation** with a check between steps:

```typescript
// In csv-loader.ts

export async function loadCSV(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  request: LoadCSVRequest,
  onProgress: ProgressCallback,
  signal: { cancelled: boolean }    // <-- abort signal
): Promise<LoadResult> {
  // Step 1: Decode
  const csvString = decoder.decode(fileContent);

  if (signal.cancelled) throw new CancelledError();

  // Step 2: Register file
  await db.registerFileText(fileName, csvString);

  if (signal.cancelled) {
    // Clean up: deregister the file
    await db.dropFile(fileName);
    throw new CancelledError();
  }

  onProgress(/* ... */);

  // Step 3: Create table — THIS IS THE LONG STEP
  // Once started, we cannot cancel it.
  await conn.query(`CREATE TABLE "${TABLE_NAME}" AS ...`);

  if (signal.cancelled) {
    await conn.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    throw new CancelledError();
  }

  // ... rest of the steps
}
```

**Cancellation points:**
1. Before `registerFileText` — clean cancel, no side effects
2. After `registerFileText`, before `CREATE TABLE` — deregister the file
3. After `CREATE TABLE` — drop the table
4. During `CREATE TABLE` — **cannot cancel**. User must wait for it to finish, then we discard the result.

#### Worker-Side Cancel Handler

The `CANCEL` case in `duckdb.worker.ts` sets a flag:

```typescript
// Worker maintains a map of active operations
const activeOperations = new Map<string, { cancelled: boolean }>();

case 'CANCEL': {
  const signal = activeOperations.get(msg.payload.targetRequestId);
  if (signal) {
    signal.cancelled = true;
  }
  // No response needed — the WorkerClient already rejected the promise
  break;
}

case 'LOAD_CSV': {
  const signal = { cancelled: false };
  activeOperations.set(msg.requestId, signal);

  try {
    const result = await loadCSV(db, conn, msg, onProgress, signal);
    if (!signal.cancelled) {
      respond<LoadCSVComplete>({ ... });
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      respond<WorkerError>({
        requestId: msg.requestId,
        type: 'ERROR',
        payload: { code: WorkerErrorCode.CANCELLED, message: 'Load cancelled' },
      });
    } else { /* ... */ }
  } finally {
    activeOperations.delete(msg.requestId);
  }
  break;
}
```

#### Main Thread Cancel Flow

```
User clicks Cancel
       │
       ▼
App calls client.cancel(loadRequestId)
       │
       ├──▶ WorkerClient rejects the pending promise immediately
       │    (UI gets the error, shows "Cancelled")
       │
       └──▶ WorkerClient sends CANCEL message to worker
            Worker sets signal.cancelled = true
            Worker checks flag at next cancellation point
            Worker cleans up (drop file/table)
```

**Note:** The `WorkerClient.cancel()` method already handles the main-thread side (rejects promise, sends CANCEL message). TASK-011 is about implementing the *worker-side* handling of the CANCEL message and the cooperative check in `loadCSV`.

**Acceptance Criteria:**
- [ ] Cancel button during loading triggers cancellation
- [ ] UI immediately shows "Cancelled" state (doesn't wait for worker)
- [ ] Worker cleans up partial state (no orphaned files or tables)
- [ ] Cancelling before `CREATE TABLE` is instant
- [ ] Cancelling during `CREATE TABLE` waits for it to finish, then drops the table
- [ ] After cancellation, user can load a new file

---

## File Structure (Phase 2 Deliverables)

```
src/
├── types/
│   ├── worker-protocol.ts        # (Phase 1 — no changes needed)
│   └── ingest-state.ts           # Ingest state machine types
├── worker/
│   ├── duckdb.worker.ts          # Updated: LOAD_CSV + CANCEL handlers
│   ├── duckdb-init.ts            # (Phase 1 — no changes)
│   └── csv-loader.ts             # NEW: CSV loading logic
├── lib/
│   ├── worker-client.ts          # (Phase 1 — no changes needed)
│   └── request-id.ts             # (Phase 1 — no changes)
├── hooks/
│   └── useWorker.ts              # NEW: Worker lifecycle React hook
├── components/
│   ├── FileUpload.tsx             # NEW: File selection UI
│   └── ProgressBar.tsx            # NEW: Loading progress display
├── App.tsx                        # REPLACED: Application shell
├── App.css                        # UPDATED: Application styles
├── index.css                      # May update for base styles
└── main.tsx                       # (no changes)
```

---

## Implementation Order

```
TASK-007 (UI + hook) ──┐
                       ├──▶ TASK-010 (progress UI) ──▶ TASK-011 (cancel)
TASK-008 (CSV loader) ─┤
                       │
TASK-009 (edge cases) ─┘
```

**Recommended execution order:**

1. **TASK-008 first** — Implement `csv-loader.ts` and wire it into `duckdb.worker.ts`. This is the core logic and can be tested by sending raw `postMessage` calls from the browser console.

2. **TASK-009 second** — Handle edge cases in the csv-loader (empty files, malformed CSVs, filename sanitization). Extends TASK-008 naturally.

3. **TASK-007 third** — Build the `useWorker` hook, `FileUpload` component, and replace `App.tsx`. This connects the UI to the worker.

4. **TASK-010 fourth** — Add `ProgressBar` component and ingest state machine. Requires both the worker (008/009) and the UI (007) to be in place.

5. **TASK-011 last** — Implement cancel. Requires the full pipeline (load + progress) to be working so we can test interruption.

---

## Verification Plan

### Manual Smoke Test

1. Start dev server: `npm run dev`
2. Open the app in browser
3. Verify DuckDB initializes (status indicator shows "Ready")
4. Select a small CSV file (e.g., 100 rows)
   - Verify `LOAD_CSV_COMPLETE` response with correct row count
   - Verify columns match CSV headers
5. Select a larger CSV file (~100K rows)
   - Verify progress indicator appears
   - Verify completion summary shows correct count
6. Select a malformed CSV
   - Verify error message is shown
7. Select a file, then click Cancel before it finishes
   - Verify UI shows "Cancelled"
   - Verify loading a new file works after cancellation

### Console Verification (Worker-Only Test)

Before building the UI, verify the worker in isolation:

```javascript
// In browser console, after dev server starts
const worker = new Worker(
  new URL('./src/worker/duckdb.worker.ts', import.meta.url),
  { type: 'module' }
);
worker.onmessage = (e) => console.log('MSG:', e.data);

// Init DuckDB
worker.postMessage({
  requestId: 'init',
  type: 'INIT_DUCKDB',
  payload: { logLevel: 'WARNING' }
});

// After INIT_DUCKDB_READY, load a CSV
const csv = 'id,name,value\n1,Alice,100\n2,Bob,200\n3,Carol,300';
const buffer = new TextEncoder().encode(csv).buffer;
worker.postMessage({
  requestId: 'load_1',
  type: 'LOAD_CSV',
  payload: { fileName: 'test.csv', fileContent: buffer }
}, [buffer]);

// Expected: LOAD_CSV_PROGRESS messages, then LOAD_CSV_COMPLETE with totalRows: 3
```

### Build Validation

```bash
npm run build    # must compile without errors
npm run lint     # no lint violations
```

---

## Dependencies

No new npm packages required. All needed packages are already installed:
- `@duckdb/duckdb-wasm` — CSV parsing via `read_csv_auto`, table creation
- `papaparse` — installed but **not used** in Phase 2 critical path
- `react` — UI components

---

## Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `registerFileText` fails for large files (>500MB) | Medium | High | Add file size check before loading. Warn user. Document the limit. |
| `read_csv_auto` type inference fails on mixed-type columns | Medium | Medium | Catch the error, return `CSV_PARSE_ERROR` with DuckDB's error message. User can clean CSV. |
| `TextDecoder` fails on non-UTF-8 files | Low | Medium | Most CSVs are UTF-8/ASCII. Add encoding detection as future enhancement. |
| Worker hangs on very large `CREATE TABLE` | Low | High | 5-minute timeout. Cancel will wait for completion then discard. |
| `ArrayBuffer` transfer causes confusion | Low | Low | Document that buffer is unusable after transfer. UI reads file size before transfer. |

---

## What Comes Next (Phase 3 Preview)

Phase 2 delivers a **loadable, explorable dataset in DuckDB**. Phase 3 will:
- Build a SQL query builder from table state (`TASK-012`)
- Implement the `QUERY_PAGE` handler in the worker (`TASK-013`)
- Add `GET_STATS` for total/filtered row counts (`TASK-014`)
- Wire stale query protection (`TASK-015`) — already partially implemented via `WorkerClient.cancel()`

The `QUERY_PAGE` and `GET_STATS` message types are already defined in the protocol. Phase 3 implements the worker-side handlers and the UI hooks to consume them.
