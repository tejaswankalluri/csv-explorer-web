# Phase 1: Worker + DuckDB Foundation

## Context

Phase 0 is complete: the Vite + React + TypeScript scaffold is in place with all dependencies installed (`@duckdb/duckdb-wasm`, `papaparse`, `@tanstack/react-table`, `react-window`). The `src/` directory contains only the default Vite template — no application code exists yet.

Phase 1 establishes the foundational data layer: a Web Worker running DuckDB WASM, a typed message protocol for main-thread ↔ worker communication, and robust error handling with request tracking.

---

## Architectural Decision: Worker Topology

### The Problem

DuckDB WASM has its own internal worker architecture. When you call `duckdb.createWorker(bundle.mainWorker)`, it spawns an **internal Web Worker** that runs the actual WASM engine. The `AsyncDuckDB` class on your calling thread acts as a proxy that communicates with this internal worker via `postMessage`.

This creates a design choice:

**Option A — DuckDB on Main Thread (DuckDB manages its own worker)**
```
Main Thread (React + AsyncDuckDB proxy) ──postMessage──▶ DuckDB Internal Worker (WASM)
```
- Simpler setup. React calls `AsyncDuckDB` methods directly.
- Problem: CSV parsing (Papa Parse), file registration, and result serialization all happen on the main thread. For 5M-row files, `registerFileText()` and result processing **will block the UI**.

**Option B — Custom Application Worker hosts DuckDB (nested workers)**
```
Main Thread (React) ──postMessage──▶ App Worker (Papa Parse + AsyncDuckDB proxy) ──postMessage──▶ DuckDB Internal Worker (WASM)
```
- All heavy work (CSV parsing, DuckDB calls, result serialization) runs off the main thread.
- Problem: Nested workers (worker spawning another worker) have limited browser support and add complexity.

**Option C — Custom Application Worker with DuckDB instantiated directly (no nesting)**
```
Main Thread (React) ──postMessage──▶ App Worker (Papa Parse + DuckDB WASM directly instantiated)
```
- DuckDB instantiated directly inside our worker using manual WASM instantiation, bypassing `createWorker()`.
- All heavy work is off the main thread. No nested workers.
- This is the **recommended pattern** from DuckDB docs for custom worker setups.

### Decision: Option C

We will create a single custom Web Worker that:
1. Instantiates DuckDB WASM directly (not via `createWorker`)
2. Runs Papa Parse for CSV chunked parsing
3. Executes all SQL queries
4. Communicates results back to the main thread via `postMessage`

The main thread only handles React rendering and dispatching requests.

**Key implementation detail**: Inside the worker, we use `duckdb.AsyncDuckDB` instantiated with `worker_url: null` (or equivalent) so DuckDB runs in the *same* worker thread, not in a nested child worker. Per the DuckDB WASM docs, when running inside a worker, you instantiate the database directly:

```typescript
// Inside our app worker — DuckDB runs in THIS thread, no nested worker
import * as duckdb from '@duckdb/duckdb-wasm';

const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
const db = new duckdb.AsyncDuckDB(logger);
await db.instantiate(wasmUrl);       // loads WASM in this thread
const conn = await db.connect();
```

---

## Prerequisite: Vite Configuration Update

Before any Phase 1 code works, `vite.config.ts` must be updated. The current config is the default Vite template and does not handle DuckDB WASM or Web Workers correctly.

**Required changes:**
```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],  // prevent Vite from pre-bundling WASM
  },
  build: {
    target: 'esnext',                   // needed for top-level await, WASM
  },
  worker: {
    format: 'es',                       // ES module workers
  },
});
```

**Why each setting matters:**
- `optimizeDeps.exclude` — DuckDB WASM includes `.wasm` files that Vite's dependency optimizer cannot handle. Excluding it lets the browser load WASM directly.
- `build.target: 'esnext'` — Required for top-level `await` and WebAssembly imports.
- `worker.format: 'es'` — Ensures our worker is bundled as an ES module, allowing `import` statements inside it.

---

## Task Breakdown

### TASK-004: Worker Message Protocol Types

**Goal:** Define all TypeScript types for main ↔ worker communication in a single source-of-truth file.

**File:** `src/types/worker-protocol.ts`

**Design Principles:**
- Discriminated union types (tagged by `type` field) — enables exhaustive `switch` handling
- Every request carries a `requestId` for response correlation
- Responses are always paired to the originating `requestId`
- Payloads are specific per message type — no `unknown` catch-alls

#### Type Definitions

```typescript
// ──────────────────────────────────────────────
// Request IDs
// ──────────────────────────────────────────────

/** Unique identifier for correlating requests with responses */
type RequestId = string;

// ──────────────────────────────────────────────
// Messages: Main Thread → Worker
// ──────────────────────────────────────────────

interface InitDuckDBRequest {
  requestId: RequestId;
  type: 'INIT_DUCKDB';
  payload: {
    logLevel?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  };
}

interface LoadCSVRequest {
  requestId: RequestId;
  type: 'LOAD_CSV';
  payload: {
    fileName: string;
    fileContent: ArrayBuffer;     // binary for Transferable efficiency
    delimiter?: string;           // auto-detect if omitted
    hasHeader?: boolean;          // default true
    batchSize?: number;           // rows per INSERT batch, default 10000
  };
}

interface QueryPageRequest {
  requestId: RequestId;
  type: 'QUERY_PAGE';
  payload: {
    sql: string;
    params?: unknown[];           // for future parameterized queries
  };
}

interface GetStatsRequest {
  requestId: RequestId;
  type: 'GET_STATS';
  payload: {
    tableName: string;
  };
}

interface CancelRequest {
  requestId: RequestId;
  type: 'CANCEL';
  payload: {
    targetRequestId: RequestId;   // the requestId to cancel
  };
}

/** Union of all messages the main thread can send */
type WorkerRequest =
  | InitDuckDBRequest
  | LoadCSVRequest
  | QueryPageRequest
  | GetStatsRequest
  | CancelRequest;

// ──────────────────────────────────────────────
// Messages: Worker → Main Thread
// ──────────────────────────────────────────────

interface InitDuckDBReady {
  requestId: RequestId;
  type: 'INIT_DUCKDB_READY';
  payload: {
    version: string;              // DuckDB version string
  };
}

interface LoadCSVProgress {
  requestId: RequestId;
  type: 'LOAD_CSV_PROGRESS';
  payload: {
    rowsLoaded: number;
    bytesProcessed: number;
    totalBytes: number;
    phase: 'parsing' | 'inserting';
  };
}

interface LoadCSVComplete {
  requestId: RequestId;
  type: 'LOAD_CSV_COMPLETE';
  payload: {
    tableName: string;
    totalRows: number;
    columns: ColumnInfo[];
    elapsedMs: number;
  };
}

interface QueryResult {
  requestId: RequestId;
  type: 'QUERY_RESULT';
  payload: {
    columns: ColumnInfo[];
    rows: Record<string, unknown>[];   // array of row objects
    rowCount: number;
    elapsedMs: number;
  };
}

interface StatsResult {
  requestId: RequestId;
  type: 'STATS_RESULT';
  payload: {
    tableName: string;
    totalRows: number;
    columns: ColumnInfo[];
  };
}

interface WorkerError {
  requestId: RequestId;
  type: 'ERROR';
  payload: {
    code: WorkerErrorCode;
    message: string;
    details?: unknown;
  };
}

/** Union of all messages the worker can send */
type WorkerResponse =
  | InitDuckDBReady
  | LoadCSVProgress
  | LoadCSVComplete
  | QueryResult
  | StatsResult
  | WorkerError;

// ──────────────────────────────────────────────
// Shared Types
// ──────────────────────────────────────────────

interface ColumnInfo {
  name: string;
  type: string;          // DuckDB type name (VARCHAR, INTEGER, etc.)
  nullable: boolean;
}

enum WorkerErrorCode {
  INIT_FAILED = 'INIT_FAILED',
  CSV_PARSE_ERROR = 'CSV_PARSE_ERROR',
  QUERY_ERROR = 'QUERY_ERROR',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  INVALID_REQUEST = 'INVALID_REQUEST',
  CANCELLED = 'CANCELLED',
  UNKNOWN = 'UNKNOWN',
}
```

#### Design Notes

1. **`ArrayBuffer` for CSV content** — The `LoadCSVRequest` uses `ArrayBuffer` rather than `string` because:
   - `ArrayBuffer` can be transferred (zero-copy) via `postMessage` using the `transfer` list
   - For a 500MB CSV file, this avoids doubling memory by copying the string
   - The worker decodes it to text using `TextDecoder`

2. **Discriminated unions** — Both `WorkerRequest` and `WorkerResponse` are tagged unions. In the worker's message handler:
   ```typescript
   self.onmessage = (e: MessageEvent<WorkerRequest>) => {
     switch (e.data.type) {
       case 'INIT_DUCKDB':    // TypeScript narrows payload automatically
       case 'LOAD_CSV':       // ...
     }
   };
   ```

3. **`CANCEL` targets another request** — The cancel message specifies `targetRequestId`, not its own. The worker uses this to abort in-progress operations.

4. **Progress messages are streaming** — `LOAD_CSV_PROGRESS` is sent repeatedly during ingestion. It shares the same `requestId` as the original `LOAD_CSV` request, so the main thread can correlate progress to the correct load operation.

**Acceptance Criteria:**
- [ ] All types compile with `tsc --noEmit`
- [ ] `WorkerRequest` and `WorkerResponse` unions are exhaustive (adding a new message type without handling it causes a compile error if we add exhaustiveness checks)
- [ ] Types are importable from both main thread and worker code

---

### TASK-005: DuckDB WASM Initialization in Worker

**Goal:** Create the Web Worker that initializes DuckDB WASM and responds to `INIT_DUCKDB` requests.

**Files:**
- `src/worker/duckdb.worker.ts` — Worker entry point
- `src/worker/duckdb-init.ts` — DuckDB initialization logic (separated for testability)

#### Worker Entry Point

```typescript
// src/worker/duckdb.worker.ts
import * as duckdb from '@duckdb/duckdb-wasm';
import type { WorkerRequest, WorkerResponse } from '../types/worker-protocol';

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

/**
 * Initialize DuckDB WASM inside this worker thread.
 *
 * Strategy: Use JSDelivr bundles for WASM delivery. DuckDB's selectBundle()
 * picks the best bundle (EH if supported, else MVP) for the current browser.
 * We do NOT use createWorker() — DuckDB runs directly in this worker thread.
 */
async function initializeDuckDB(logLevel: string = 'WARNING'): Promise<string> {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

  const logLevelMap: Record<string, duckdb.LogLevel> = {
    DEBUG: duckdb.LogLevel.DEBUG,
    INFO: duckdb.LogLevel.INFO,
    WARNING: duckdb.LogLevel.WARNING,
    ERROR: duckdb.LogLevel.ERROR,
  };

  const logger = new duckdb.ConsoleLogger(
    logLevelMap[logLevel] ?? duckdb.LogLevel.WARNING
  );

  // Instantiate DuckDB directly in this worker — no nested worker
  db = new duckdb.AsyncDuckDB(logger);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();

  // Return DuckDB version for confirmation
  const result = await conn.query('SELECT version() as version');
  const rows = result.toArray();
  return rows[0]?.version ?? 'unknown';
}

/**
 * Main message handler — routes incoming requests by type.
 */
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case 'INIT_DUCKDB': {
        const version = await initializeDuckDB(msg.payload.logLevel);
        respond<InitDuckDBReady>({
          requestId: msg.requestId,
          type: 'INIT_DUCKDB_READY',
          payload: { version },
        });
        break;
      }

      // LOAD_CSV, QUERY_PAGE, GET_STATS, CANCEL
      // will be implemented in Phase 2 and Phase 3

      default: {
        respond<WorkerError>({
          requestId: msg.requestId,
          type: 'ERROR',
          payload: {
            code: 'INVALID_REQUEST',
            message: `Unknown message type: ${(msg as any).type}`,
          },
        });
      }
    }
  } catch (error) {
    respond<WorkerError>({
      requestId: msg.requestId,
      type: 'ERROR',
      payload: {
        code: 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof Error ? error.stack : undefined,
      },
    });
  }
};

/** Type-safe postMessage wrapper */
function respond<T extends WorkerResponse>(msg: T): void {
  self.postMessage(msg);
}
```

#### Initialization Flow

```
Main Thread                           App Worker
    │                                     │
    │  new Worker('./duckdb.worker.ts')   │
    │────────────────────────────────────▶│
    │                                     │  (worker script loaded)
    │                                     │
    │  { type: 'INIT_DUCKDB', ... }       │
    │────────────────────────────────────▶│
    │                                     │  1. Fetch JSDelivr bundle URLs
    │                                     │  2. selectBundle() picks MVP or EH
    │                                     │  3. new AsyncDuckDB(logger)
    │                                     │  4. db.instantiate(wasmUrl, pthreadUrl)
    │                                     │  5. db.connect()
    │                                     │  6. SELECT version()
    │                                     │
    │  { type: 'INIT_DUCKDB_READY',       │
    │    payload: { version: '1.1.0' } }  │
    │◀────────────────────────────────────│
    │                                     │
```

#### WASM Bundle Selection Notes

- `duckdb.getJsDelivrBundles()` returns CDN URLs for both MVP and EH bundles.
- `duckdb.selectBundle()` tests browser capabilities and picks the best one.
- **EH (Exception Handling)** bundle uses WebAssembly exception handling — better error reporting, slightly larger. Available in Chrome 91+, Firefox 100+, Safari 15.2+.
- **MVP** bundle works everywhere WebAssembly is supported — our fallback.
- In production, we could self-host the WASM files instead of relying on JSDelivr. This is a future optimization, not a Phase 1 concern.

#### Main Thread Worker Instantiation

The main thread creates the worker using Vite's built-in worker support:

```typescript
// Somewhere in main thread code (e.g., a React hook or init function)
const worker = new Worker(
  new URL('../worker/duckdb.worker.ts', import.meta.url),
  { type: 'module' }
);
```

Vite handles:
- Bundling the worker as a separate chunk
- Resolving the `import.meta.url` path correctly
- Applying `worker.format: 'es'` from our config

**Acceptance Criteria:**
- [ ] Worker loads without errors in the browser console
- [ ] Sending `INIT_DUCKDB` message results in `INIT_DUCKDB_READY` with a version string
- [ ] Sending an unknown message type results in an `ERROR` response
- [ ] If DuckDB fails to instantiate (e.g., network issue), an `ERROR` response is sent with `code: 'INIT_FAILED'`
- [ ] No main thread jank during initialization (verify via DevTools Performance tab)

---

### TASK-006: Error Handling + RequestId Routing

**Goal:** Build the main-thread client that manages worker communication with request correlation, timeouts, and cancellation.

**Files:**
- `src/lib/worker-client.ts` — The `WorkerClient` class
- `src/lib/request-id.ts` — RequestId generation utility

#### RequestId Generation

```typescript
// src/lib/request-id.ts

let counter = 0;

/**
 * Generates a unique request ID.
 * Format: "req_{incrementing counter}_{timestamp}"
 *
 * The counter ensures uniqueness within a session.
 * The timestamp aids debugging (when was this request sent?).
 */
export function generateRequestId(): string {
  return `req_${++counter}_${Date.now()}`;
}
```

Why not UUID? UUIDs are overkill here — we only need uniqueness within a single page session, not across distributed systems. A counter + timestamp is smaller, faster, and more debuggable.

#### WorkerClient Class

```typescript
// src/lib/worker-client.ts
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerErrorCode,
} from '../types/worker-protocol';
import { generateRequestId } from './request-id';

/** Default timeout for requests in milliseconds */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Callback for streaming messages (e.g., progress updates) */
type StreamCallback = (response: WorkerResponse) => void;

interface PendingRequest {
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onStream?: StreamCallback;        // for progress updates
}

export class WorkerClient {
  private worker: Worker;
  private pending = new Map<string, PendingRequest>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleWorkerError.bind(this);
  }

  /**
   * Send a request to the worker and wait for the terminal response.
   *
   * @param type      - Message type
   * @param payload   - Message payload
   * @param options   - Optional: timeout, stream callback, transferable objects
   * @returns         - The worker's response
   */
  async request<T extends WorkerResponse>(
    type: WorkerRequest['type'],
    payload: unknown,
    options: {
      timeoutMs?: number;
      onStream?: StreamCallback;
      transfer?: Transferable[];
    } = {}
  ): Promise<T> {
    const requestId = generateRequestId();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: resolve as (v: WorkerResponse) => void,
        reject,
        timer,
        onStream: options.onStream,
      });

      const message = { requestId, type, payload } as WorkerRequest;

      if (options.transfer?.length) {
        this.worker.postMessage(message, options.transfer);
      } else {
        this.worker.postMessage(message);
      }
    });
  }

  /**
   * Cancel a pending request.
   * Sends a CANCEL message to the worker and rejects the pending promise.
   */
  cancel(targetRequestId: string): void {
    const pending = this.pending.get(targetRequestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(targetRequestId);
    pending.reject(new Error(`Request ${targetRequestId} was cancelled`));

    // Also tell the worker to stop any in-progress operation
    const cancelId = generateRequestId();
    this.worker.postMessage({
      requestId: cancelId,
      type: 'CANCEL',
      payload: { targetRequestId },
    } satisfies WorkerRequest);
  }

  /**
   * Cancel all pending requests and terminate the worker.
   */
  destroy(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Worker client destroyed'));
      this.pending.delete(id);
    }
    this.worker.terminate();
  }

  // ── Private ───────────────────────────────────────────────

  private handleMessage(event: MessageEvent<WorkerResponse>): void {
    const response = event.data;
    const { requestId, type } = response;

    const pending = this.pending.get(requestId);
    if (!pending) {
      // Stale response — the request was already resolved, timed out,
      // or cancelled. Silently ignore.
      return;
    }

    // Streaming messages (progress) — forward to callback, don't resolve
    if (type === 'LOAD_CSV_PROGRESS') {
      pending.onStream?.(response);
      return;   // keep the request pending — not done yet
    }

    // Terminal message — resolve or reject
    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    if (type === 'ERROR') {
      pending.reject(
        new WorkerRequestError(response.payload.code, response.payload.message)
      );
    } else {
      pending.resolve(response);
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    // Worker-level error (script failed to load, syntax error, etc.)
    // Reject ALL pending requests — the worker is likely dead.
    const error = new Error(`Worker error: ${event.message}`);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Custom error class for worker request failures.
 * Carries the error code from the worker protocol.
 */
export class WorkerRequestError extends Error {
  code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.name = 'WorkerRequestError';
    this.code = code;
  }
}
```

#### Request Lifecycle

```
┌─────────────┐                    ┌───────────┐
│ Main Thread  │                    │  Worker   │
│ (React)     │                    │           │
└──────┬──────┘                    └─────┬─────┘
       │                                 │
       │ 1. request('QUERY_PAGE', ...)   │
       │    → generates requestId        │
       │    → stores in pending map      │
       │    → starts timeout timer       │
       │                                 │
       │ 2. postMessage({requestId, ..}) │
       │────────────────────────────────▶│
       │                                 │
       │                    3. Worker processes request
       │                                 │
       │ 4. postMessage({requestId, ..}) │
       │◀────────────────────────────────│
       │                                 │
       │ 5. handleMessage()              │
       │    → match requestId            │
       │    → clear timeout              │
       │    → resolve/reject promise     │
       │                                 │
```

#### Stale Response Protection

The "latest-wins" pattern for queries works naturally with this design:

1. User types filter → main thread sends `QUERY_PAGE` (requestId: `req_1`)
2. User types more → main thread calls `cancel('req_1')`, sends new `QUERY_PAGE` (requestId: `req_2`)
3. If `req_1` response arrives after cancellation → `pending.get('req_1')` returns `undefined` → silently ignored
4. Only `req_2` response is processed

This is handled entirely by the `WorkerClient` — consuming code doesn't need to track request freshness.

#### Error Categories and Handling

| Scenario | What Happens |
|----------|-------------|
| Worker sends `ERROR` response | Promise rejected with `WorkerRequestError` (includes error code) |
| Request times out | Promise rejected with timeout error; pending entry cleaned up |
| Worker script fails to load | `onerror` fires → all pending requests rejected |
| Worker crashes mid-request | Browser fires `error` event → same as above |
| Stale response arrives | `pending.get()` returns undefined → ignored silently |
| `cancel()` called | Promise rejected immediately; `CANCEL` message sent to worker |
| `destroy()` called | All pending rejected; `worker.terminate()` called |

**Acceptance Criteria:**
- [ ] `request()` returns a promise that resolves with the correct response type
- [ ] If the worker responds with `ERROR`, the promise rejects with a `WorkerRequestError` containing the error code
- [ ] Requests that exceed the timeout reject with a timeout error
- [ ] `cancel()` immediately rejects the pending promise and sends `CANCEL` to the worker
- [ ] Stale responses (for already-resolved/cancelled requests) are silently ignored — no unhandled rejections, no state corruption
- [ ] `destroy()` cleans up all pending requests and terminates the worker
- [ ] Progress messages (`LOAD_CSV_PROGRESS`) are forwarded to the stream callback without resolving the request

---

## File Structure (Phase 1 Deliverables)

```
src/
├── types/
│   └── worker-protocol.ts       # All message types, payload interfaces, error codes
├── worker/
│   └── duckdb.worker.ts         # Worker entry point: DuckDB init + message routing
├── lib/
│   ├── worker-client.ts         # Main-thread WorkerClient class
│   └── request-id.ts            # RequestId generation utility
```

**Note:** We use `src/lib/` instead of `src/utils/` and `src/hooks/` at this stage. The React hook (`useWorker`) will be added in Phase 2 when we have a UI that needs it. Phase 1 focuses on the infrastructure layer — no React code.

---

## Implementation Order

```
TASK-004 (types) ──▶ TASK-005 (worker init) ──▶ TASK-006 (error handling + client)
                          │                              │
                          │                              ▼
                          └──────────── both depend on TASK-004 types
```

TASK-005 and TASK-006 both depend on TASK-004 (the types), but are independent of each other. They can be developed in parallel if needed, though sequential development (005 → 006) provides a natural validation path: once the worker initializes, you can test the client against it.

**Recommended execution order:**
1. Update `vite.config.ts` (prerequisite)
2. TASK-004 — Define all types
3. TASK-005 — Build the worker, verify DuckDB initializes
4. TASK-006 — Build `WorkerClient`, verify round-trip communication

---

## Verification Plan

### Smoke Test (Manual, after all three tasks)

1. Start dev server: `npm run dev`
2. Open browser console
3. Create worker and send init:
   ```javascript
   const worker = new Worker(new URL('./worker/duckdb.worker.ts', import.meta.url), { type: 'module' });
   worker.onmessage = (e) => console.log('Response:', e.data);
   worker.postMessage({ requestId: 'test_1', type: 'INIT_DUCKDB', payload: { logLevel: 'INFO' } });
   // Expected: Response: { requestId: 'test_1', type: 'INIT_DUCKDB_READY', payload: { version: '...' } }
   ```
4. Send unknown message:
   ```javascript
   worker.postMessage({ requestId: 'test_2', type: 'UNKNOWN_THING', payload: {} });
   // Expected: Response: { requestId: 'test_2', type: 'ERROR', payload: { code: 'INVALID_REQUEST', ... } }
   ```
5. Use `WorkerClient`:
   ```javascript
   import { WorkerClient } from './lib/worker-client';
   const client = new WorkerClient(worker);
   const result = await client.request('INIT_DUCKDB', { logLevel: 'WARNING' });
   console.log(result);  // { type: 'INIT_DUCKDB_READY', payload: { version: '...' } }
   ```

### Build Validation

```bash
npm run build    # must compile without errors
npm run lint     # no lint violations in new files
```

### What We Are NOT Testing in Phase 1

- CSV loading (Phase 2)
- SQL queries (Phase 3)
- React integration (Phase 2+)
- Performance under load (Phase 6)

Phase 1 success = DuckDB initializes in a worker, messages route correctly, errors propagate cleanly.

---

## Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| DuckDB WASM fails to instantiate in worker without `createWorker()` | Medium | High | Fall back to Option B (nested workers) if direct instantiation doesn't work. Test early. |
| JSDelivr CDN unreachable | Low | High | Document self-hosting as escape hatch. Consider bundling WASM locally for production. |
| Vite worker bundling issues with DuckDB imports | Medium | Medium | The `optimizeDeps.exclude` should handle this. If not, use `?url` import pattern. |
| `ArrayBuffer` transfer semantics cause confusion | Low | Low | Document that transferred buffers become unusable on the sending side. |

---

## Dependencies

No new npm packages required. All dependencies are already installed from Phase 0:
- `@duckdb/duckdb-wasm` — DuckDB engine
- `typescript` — type definitions compile as part of existing setup

---

## What Comes Next (Phase 2 Preview)

Phase 1 delivers the **communication backbone**. Phase 2 will plug into it:
- `LOAD_CSV` handler in the worker (Papa Parse chunked parsing + DuckDB insertion)
- File upload UI component
- `useWorker()` React hook wrapping `WorkerClient`
- Progress bar driven by `LOAD_CSV_PROGRESS` stream callbacks

The message protocol types defined in TASK-004 already include the Phase 2 message shapes, so Phase 2 won't need to modify the type file — only implement the handlers.
