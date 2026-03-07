# Phase 3: Query Engine + Pagination

## Context

Phase 2 is complete. We have:
- **Worker protocol types** (`src/types/worker-protocol.ts`) — all message types including `QueryPageRequest`, `QueryResult`, `GetStatsRequest`, `StatsResult` are fully defined
- **DuckDB worker** (`src/worker/duckdb.worker.ts`) — initializes DuckDB, handles `LOAD_CSV` and `CANCEL`, but `QUERY_PAGE` and `GET_STATS` return a "not yet implemented" error stub (lines 167–178)
- **CSV loader** (`src/worker/csv-loader.ts`) — loads CSV into a fixed table named `"data"` via DuckDB-native `read_csv_auto`, with cooperative cancellation
- **WorkerClient** (`src/lib/worker-client.ts`) — main-thread client with request correlation, timeout, cancel, streaming support, and `getLastRequestId()` tracking
- **useWorker hook** (`src/hooks/useWorker.ts`) — manages Worker + WorkerClient lifecycle, exposes `{ status, error, client }`
- **App shell** (`src/App.tsx`) — file upload, progress bar, load complete summary card. After `ingestState.phase === 'complete'`, the UI is a dead end — no table display, no queries
- **Ingest state** (`src/types/ingest-state.ts`) — the `complete` phase carries `tableName`, `totalRows`, `columns: ColumnInfo[]`, and `elapsedMs`

Phase 3 builds the query engine: a SQL query builder that translates UI state into safe SQL, worker handlers for `QUERY_PAGE` and `GET_STATS`, a total-count query for filtered results, and stale query protection so rapid filter changes don't corrupt the UI.

---

## Architectural Decision: Query Builder Design

### The Problem

The UI needs to translate user interactions (filter a column, sort by multiple columns, type in a search box, scroll to a new page) into SQL queries executed by DuckDB in the worker. There are several design choices:

**Option A — Build SQL strings directly in components**
```typescript
// In a React component
const sql = `SELECT * FROM "data" WHERE name ILIKE '%${search}%' ORDER BY age DESC LIMIT 100 OFFSET 200`;
client.request('QUERY_PAGE', { sql });
```
- Simple. No abstraction layer.
- Problem: SQL injection via user input. Duplicated logic across components. Hard to test. Filter/sort composition becomes messy with multiple columns.

**Option B — Parameterized query builder function**
```typescript
// Pure function: state → { dataSql, countSql }
const { dataSql, countSql } = buildQuery({
  tableName: 'data',
  filters: [{ column: 'name', operator: 'contains', value: 'Alice' }],
  sort: [{ column: 'age', direction: 'desc' }],
  search: 'Alice',
  searchColumns: ['name', 'email'],
  offset: 200,
  limit: 100,
});
```
- Centralized SQL generation. Testable in isolation. Handles escaping and composition.
- Problem: Slightly more code upfront. Not parameterized at the DuckDB level (DuckDB WASM's prepared statement support is limited for dynamic WHERE clauses).

**Option C — ORM-style query builder class with method chaining**
```typescript
new QueryBuilder('data').where('name', 'contains', 'Alice').orderBy('age', 'desc').limit(100).offset(200).build();
```
- Elegant API. Familiar pattern.
- Problem: Over-engineered for our needs. We have a single table, a fixed set of operations, and the consumer is one hook, not dozens of callers.

### Decision: Option B — Pure function query builder

**Rationale:**

1. **Single consumer.** The query builder is called from one place: the query hook (or the App component). A class with method chaining adds ceremony for no benefit.

2. **Testability.** A pure function `(state) → { dataSql, countSql }` is trivially unit-testable. Pass in state, assert the SQL output. No mocking required.

3. **SQL safety.** The builder escapes string values (replacing `'` with `''`), double-quotes column names (protecting against reserved words and special characters), and uses `ILIKE` for case-insensitive search. This is not parameterized SQL in the database sense, but it is safe against the input vectors we face (user-typed filter values, column names from CSV headers).

4. **Two queries per state change.** Every filter/sort/search change produces two SQL strings: the *data query* (`SELECT ... LIMIT/OFFSET`) for the visible rows, and the *count query* (`SELECT COUNT(*) ... `) for total matched rows. Generating both from the same state ensures consistency.

---

## Architectural Decision: Count Query Strategy

### The Problem

The UI needs to show "Showing rows 201–300 of 4,523 matching rows" (filtered count) vs "50,000 total rows" (unfiltered count). This requires knowing the total number of rows matching the current filters *without* fetching all the data.

**Option A — Separate COUNT query for every state change**
```sql
SELECT COUNT(*) FROM "data" WHERE name ILIKE '%Alice%'
```
- Accurate. Simple.
- Problem: An extra query per state change. For rapid filter typing, this doubles the query load.

**Option B — DuckDB window function (COUNT(*) OVER())**
```sql
SELECT *, COUNT(*) OVER() AS _total_count FROM "data" WHERE name ILIKE '%Alice%' LIMIT 100 OFFSET 200
```
- Single query returns both data rows and total count. No extra round trip.
- Problem: DuckDB must compute the full filtered result to calculate the window function count, even though we only materialize `LIMIT` rows. For large filtered result sets this may be slow. Also, the `_total_count` column pollutes every row.

**Option C — Parallel data + count queries**
- Send both `dataSql` and `countSql` to the worker in a single `QUERY_PAGE` message.
- Worker executes both, returns rows + totalFilteredCount.
- Problem: Requires protocol change — `QueryPageRequest` currently takes a single `sql` string.

### Decision: Option A with debouncing — separate COUNT query via GET_STATS

**Rationale:**

1. **Protocol is already designed for it.** `GetStatsRequest` exists in the protocol and returns `StatsResult` with `totalRows` and `columns`. We extend it slightly: the worker runs a COUNT query with the same WHERE clause as the data query.

2. **Debouncing eliminates the "double query" concern.** Filter input is debounced (300ms). By the time the query fires, we send one data query and one count query. Two lightweight DuckDB queries per debounce cycle is negligible.

3. **Decoupled timing.** The data query is latency-sensitive (user is waiting for rows). The count query is informational (updates a counter). If the count query takes slightly longer, the UI still shows rows immediately and updates the count when it arrives. This is better UX than waiting for both.

4. **Simplicity.** No protocol changes needed. No window function complexity. The SQL builder generates `countSql` as a simple `SELECT COUNT(*)` with the same `WHERE` clause.

**Implementation note:** Rather than using `GET_STATS` (which is designed for table-level stats without filters), we will send the count query as a regular `QUERY_PAGE` request with the count SQL. The response is a `QueryResult` with a single row `{ cnt: number }`. This avoids needing to extend the protocol.

---

## Architectural Decision: Stale Query Protection

### The Problem

When the user types a search term, each keystroke (after debounce) triggers a new query. If the user types "Alice" → "Ali" → "Al" (correcting), three queries fire. Responses may arrive out of order: "Ali" result might arrive after "Al" result. Without protection, the UI shows stale data.

### Strategy: Request-generation counter (latest-wins)

The `WorkerClient` already handles request correlation via `requestId`, and `cancel()` rejects pending promises + sends `CANCEL` to the worker. However, automatic "latest-wins" is not built in — the consuming code must track which response is current.

**Implementation:**

```typescript
// In the query hook
const queryGenerationRef = useRef(0);

async function executeQuery(state: QueryState) {
  const generation = ++queryGenerationRef.current;
  
  // Cancel the previous in-flight query (if any)
  if (lastQueryRequestIdRef.current) {
    client.cancel(lastQueryRequestIdRef.current);
  }
  
  try {
    const result = await client.request<QueryResult>('QUERY_PAGE', { sql: dataSql });
    
    // Only apply if this is still the latest generation
    if (generation !== queryGenerationRef.current) return;
    
    setRows(result.payload.rows);
  } catch (err) {
    // Ignore cancellation errors from superseded queries
    if (err instanceof WorkerRequestError && err.code === 'CANCELLED') return;
    if (generation !== queryGenerationRef.current) return;
    // Handle real errors
  }
}
```

**Why this works:**
1. **`cancel()`** immediately rejects the old promise client-side (no UI update from it).
2. **Generation counter** is a safety net: if a response arrives after cancellation (race condition), the generation check discards it.
3. **Worker-side cancellation** via the existing `activeOperations` map + `CANCEL` handler stops the worker from doing unnecessary work. This requires wiring `QUERY_PAGE` into the `activeOperations` pattern (same as `LOAD_CSV`).

---

## Task Breakdown

### TASK-012: SQL Query Builder from Table State

**Goal:** Create a pure function that translates UI state (filters, sort, search, pagination) into safe SQL strings for DuckDB.

**File:** `src/lib/sql-builder.ts`

#### Input Types

```typescript
// src/lib/sql-builder.ts

export type FilterOperator =
  | 'eq'            // =
  | 'neq'           // !=
  | 'gt'            // >
  | 'gte'           // >=
  | 'lt'            // <
  | 'lte'           // <=
  | 'contains'      // ILIKE '%value%'
  | 'starts_with'   // ILIKE 'value%'
  | 'ends_with'     // ILIKE '%value'
  | 'is_null'       // IS NULL
  | 'is_not_null';  // IS NOT NULL

export interface ColumnFilter {
  column: string;
  operator: FilterOperator;
  value: string;           // always string — DuckDB casts as needed
}

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export interface QueryState {
  tableName: string;
  filters: ColumnFilter[];
  sort: SortSpec[];
  search: string;              // global search text
  searchColumns: string[];     // which columns to ILIKE search (text/varchar columns)
  offset: number;
  limit: number;
}

export interface BuiltQuery {
  dataSql: string;             // SELECT ... LIMIT/OFFSET
  countSql: string;            // SELECT COUNT(*) ...
}
```

#### Builder Implementation

```typescript
export function buildQuery(state: QueryState): BuiltQuery {
  const { tableName, filters, sort, search, searchColumns, offset, limit } = state;

  const table = quoteIdentifier(tableName);
  const whereClauses: string[] = [];

  // Column filters
  for (const filter of filters) {
    const clause = buildFilterClause(filter);
    if (clause) whereClauses.push(clause);
  }

  // Global search — OR across text columns
  if (search.trim() && searchColumns.length > 0) {
    const escapedSearch = escapeString(search.trim());
    const searchClauses = searchColumns.map(
      (col) => `${quoteIdentifier(col)} ILIKE '%${escapedSearch}%'`
    );
    whereClauses.push(`(${searchClauses.join(' OR ')})`);
  }

  // WHERE composition
  const whereStr = whereClauses.length > 0
    ? `WHERE ${whereClauses.join(' AND ')}`
    : '';

  // ORDER BY
  const orderStr = sort.length > 0
    ? `ORDER BY ${sort.map(s => `${quoteIdentifier(s.column)} ${s.direction.toUpperCase()}`).join(', ')}`
    : '';

  // Data query
  const dataSql = [
    `SELECT * FROM ${table}`,
    whereStr,
    orderStr,
    `LIMIT ${limit} OFFSET ${offset}`,
  ].filter(Boolean).join(' ');

  // Count query (same WHERE, no ORDER BY, no LIMIT)
  const countSql = [
    `SELECT COUNT(*)::INTEGER AS cnt FROM ${table}`,
    whereStr,
  ].filter(Boolean).join(' ');

  return { dataSql, countSql };
}
```

#### Escaping Functions

```typescript
/**
 * Double-quote a column or table name to handle reserved words
 * and special characters. Escape internal double quotes.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Escape a string value for safe inclusion in SQL string literals.
 * Replaces single quotes with doubled single quotes.
 * Also escapes LIKE/ILIKE wildcards to prevent pattern injection.
 */
function escapeString(value: string): string {
  return value
    .replace(/'/g, "''")      // escape single quotes
    .replace(/%/g, '\\%')     // escape LIKE wildcard %
    .replace(/_/g, '\\_');    // escape LIKE wildcard _
}
```

#### Filter Clause Builder

```typescript
function buildFilterClause(filter: ColumnFilter): string | null {
  const col = quoteIdentifier(filter.column);
  const val = escapeString(filter.value);

  switch (filter.operator) {
    case 'eq':           return `${col} = '${val}'`;
    case 'neq':          return `${col} != '${val}'`;
    case 'gt':           return `${col} > '${val}'`;
    case 'gte':          return `${col} >= '${val}'`;
    case 'lt':           return `${col} < '${val}'`;
    case 'lte':          return `${col} <= '${val}'`;
    case 'contains':     return `${col} ILIKE '%${val}%'`;
    case 'starts_with':  return `${col} ILIKE '${val}%'`;
    case 'ends_with':    return `${col} ILIKE '%${val}'`;
    case 'is_null':      return `${col} IS NULL`;
    case 'is_not_null':  return `${col} IS NOT NULL`;
    default:             return null;
  }
}
```

#### Design Notes

1. **All values are strings in the SQL literal.** DuckDB's type coercion handles `'42' > '30'` correctly for INTEGER columns because the comparison auto-casts. This avoids us needing to know column types at build time. For edge cases (dates, timestamps), the user types a value and DuckDB attempts to parse it. If it fails, the query returns a `QUERY_ERROR`.

2. **`is_null` and `is_not_null` ignore the `value` field.** They produce `IS NULL` / `IS NOT NULL` directly.

3. **LIKE wildcard escaping.** User input might contain `%` or `_` which are LIKE pattern characters. We escape them with backslash, which is DuckDB's default escape character for ILIKE. This means searching for a literal `%` in a column works correctly.

4. **Multiple filters on the same column.** The builder supports this naturally — each filter produces a separate AND clause. Example: `age > 18 AND age < 65`.

5. **Empty state.** If `filters` is empty, `sort` is empty, and `search` is empty, the query is `SELECT * FROM "data" LIMIT 100 OFFSET 0` — returns the first page with no filtering.

6. **The `searchColumns` parameter.** Global search only applies to text-like columns (VARCHAR, TEXT). The caller determines which columns are searchable based on `ColumnInfo.type` from the ingest metadata. Searching numeric columns with ILIKE would error or return no results.

**Acceptance Criteria:**
- [ ] `buildQuery` with empty filters/sort/search returns a valid `SELECT * FROM "data" LIMIT N OFFSET M`
- [ ] Column names with special characters (spaces, quotes, reserved words) are correctly double-quoted
- [ ] String values with single quotes are escaped (`O'Brien` → `O''Brien`)
- [ ] `ILIKE` search input with `%` or `_` characters is escaped to match literally
- [ ] Multiple filters produce correct `WHERE ... AND ...` composition
- [ ] Global search produces `WHERE (col1 ILIKE ... OR col2 ILIKE ...)` across specified columns
- [ ] Filters + search compose correctly: column filters AND global search
- [ ] Sort produces correct `ORDER BY col1 ASC, col2 DESC` syntax
- [ ] `countSql` has the same `WHERE` clause but no `ORDER BY` or `LIMIT/OFFSET`
- [ ] All types compile with `tsc --noEmit`
- [ ] Function is unit-testable (pure function, no side effects)

---

### TASK-013: Paginated Query Endpoint in Worker

**Goal:** Implement the `QUERY_PAGE` handler in the worker that executes SQL and returns rows to the main thread.

**File:** `src/worker/duckdb.worker.ts` — replace the stub, `src/worker/query-executor.ts` — new file for query execution logic (separated for testability, following the pattern of `csv-loader.ts`).

#### Query Executor

```typescript
// src/worker/query-executor.ts
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { ColumnInfo } from '../types/worker-protocol';

export interface QueryExecutionResult {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}

/**
 * Execute a SQL query and return materialized rows.
 *
 * Design notes:
 * - DuckDB WASM returns Apache Arrow batches. We convert to plain objects
 *   for postMessage serialization (Arrow IPC over postMessage is possible
 *   but adds complexity for Phase 3).
 * - The caller provides the full SQL string. This function does not build
 *   SQL — that responsibility belongs to sql-builder.ts.
 * - Column metadata is extracted from the Arrow schema of the result.
 */
export async function executeQuery(
  conn: AsyncDuckDBConnection,
  sql: string,
  signal: { cancelled: boolean }
): Promise<QueryExecutionResult> {
  const startTime = performance.now();

  if (signal.cancelled) {
    throw new CancelledQueryError();
  }

  // Execute the query — this is the potentially long step
  const result = await conn.query(sql);

  if (signal.cancelled) {
    throw new CancelledQueryError();
  }

  // Materialize Arrow result to plain JS objects
  const rows = result.toArray().map((row: unknown) => {
    // DuckDB WASM returns Arrow row proxies. Convert to plain objects.
    const obj: Record<string, unknown> = {};
    const rowObj = row as Record<string, unknown>;
    for (const key of Object.keys(rowObj)) {
      obj[key] = rowObj[key];
    }
    return obj;
  });

  // Extract column metadata from Arrow schema
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

export class CancelledQueryError extends Error {
  constructor() {
    super('Query cancelled');
    this.name = 'CancelledQueryError';
  }
}
```

#### Worker Handler

Replace the `QUERY_PAGE` stub in `duckdb.worker.ts`:

```typescript
case 'QUERY_PAGE': {
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

  const signal = { cancelled: false };
  activeOperations.set(msg.requestId, signal);

  try {
    const result = await executeQuery(
      conn,
      (msg as QueryPageRequest).payload.sql,
      signal
    );

    if (!signal.cancelled) {
      respond<QueryResult>({
        requestId: msg.requestId,
        type: 'QUERY_RESULT',
        payload: result,
      });
    }
  } catch (queryError) {
    if (queryError instanceof CancelledQueryError) {
      respond<WorkerError>({
        requestId: msg.requestId,
        type: 'ERROR',
        payload: {
          code: WorkerErrorCode.CANCELLED,
          message: 'Query cancelled',
        },
      });
    } else {
      respond<WorkerError>({
        requestId: msg.requestId,
        type: 'ERROR',
        payload: {
          code: WorkerErrorCode.QUERY_ERROR,
          message: queryError instanceof Error
            ? queryError.message
            : String(queryError),
          details: queryError instanceof Error ? queryError.stack : undefined,
        },
      });
    }
  } finally {
    activeOperations.delete(msg.requestId);
  }
  break;
}
```

#### Arrow-to-Object Materialization Notes

DuckDB WASM's `conn.query()` returns an Apache Arrow `Table`. The `toArray()` method yields Arrow row proxies — these are JavaScript `Proxy` objects that lazily read from the Arrow columnar buffer. They look like plain objects but:

- They are not structurally cloneable (cannot pass through `postMessage` directly)
- They hold references to the underlying Arrow buffer

We must materialize each row to a plain `Record<string, unknown>` before sending via `postMessage`. This creates a JS object copy for each row. For a 100-row page, this is negligible. For larger result sets (which we avoid via `LIMIT`), this could matter.

**Alternative (future optimization):** Use Arrow IPC serialization to transfer the Arrow buffer directly to the main thread via `postMessage` with a `Transferable`. The main thread would then deserialize the Arrow buffer. This avoids the row-by-row object creation. This is a Phase 6 optimization, not a Phase 3 concern.

#### Type Serialization Considerations

DuckDB returns typed values through Arrow. When materialized to JS objects:

| DuckDB Type | JS Value | Notes |
|---|---|---|
| INTEGER, BIGINT | `number` or `bigint` | BIGINT > 2^53 becomes BigInt — may need `toString()` for JSON |
| DOUBLE, FLOAT | `number` | Standard JS float |
| VARCHAR | `string` | |
| BOOLEAN | `boolean` | |
| DATE | `number` (epoch days) | Needs formatting on the UI side |
| TIMESTAMP | `number` (microseconds) | Needs formatting on the UI side |
| NULL | `null` | |

**Important:** BigInt values cannot be serialized by `postMessage` (they're not structurally cloneable in all browsers) or by `JSON.stringify()`. For BIGINT columns, we should convert to `number` (with precision loss for > 2^53) or `string`. This conversion happens during row materialization:

```typescript
function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number(value); // precision loss for very large integers
  }
  return value;
}
```

**Acceptance Criteria:**
- [ ] `QUERY_PAGE` with a valid `SELECT` SQL returns `QUERY_RESULT` with correct rows and columns
- [ ] `QUERY_PAGE` with invalid SQL returns `ERROR` with `code: 'QUERY_ERROR'` and DuckDB's error message
- [ ] `QUERY_PAGE` before `INIT_DUCKDB` returns `ERROR` with `code: 'INIT_FAILED'`
- [ ] Query cancellation via `CANCEL` message produces `ERROR` with `code: 'CANCELLED'`
- [ ] Rows are plain objects (not Arrow proxies) — serializable via `postMessage`
- [ ] BigInt values are converted to numbers for safe serialization
- [ ] Column metadata (`columns`) is extracted from the Arrow schema, not hardcoded
- [ ] `elapsedMs` accurately reflects query execution time
- [ ] `activeOperations` map tracks QUERY_PAGE requests for cancellation support

---

### TASK-014: Total-Count Query for Current Filter

**Goal:** Implement the filtered row count mechanism so the UI can display "Showing rows X–Y of Z matching rows".

**File:** `src/worker/duckdb.worker.ts` — implement the `GET_STATS` handler.

#### GET_STATS Handler

The `GET_STATS` handler serves two purposes:
1. **Unfiltered count** — total rows in the table (available right after `LOAD_CSV_COMPLETE`, but useful for re-fetching)
2. **Table metadata refresh** — column information if needed after schema changes

For filtered counts, we use `QUERY_PAGE` with the `countSql` from the query builder (as discussed in the architectural decision). This means:

- **`GET_STATS`** = unfiltered table stats (total rows, all columns)
- **`QUERY_PAGE` with countSql** = filtered count for current filters

```typescript
case 'GET_STATS': {
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
    const tableName = (msg as GetStatsRequest).payload.tableName;
    const quotedTable = `"${tableName.replace(/"/g, '""')}"`;

    // Get total row count
    const countResult = await conn.query(
      `SELECT COUNT(*)::INTEGER AS cnt FROM ${quotedTable}`
    );
    const countRows = countResult.toArray();
    const totalRows = Number(
      (countRows[0] as Record<string, unknown>)?.cnt ?? 0
    );

    // Get column metadata
    const describeResult = await conn.query(`DESCRIBE ${quotedTable}`);
    const describeRows = describeResult.toArray() as Record<string, unknown>[];
    const columns: ColumnInfo[] = describeRows.map((row) => ({
      name: row['column_name'] as string,
      type: row['column_type'] as string,
      nullable: row['null'] !== 'NO',
    }));

    respond<StatsResult>({
      requestId: msg.requestId,
      type: 'STATS_RESULT',
      payload: { tableName, totalRows, columns },
    });
  } catch (statsError) {
    respond<WorkerError>({
      requestId: msg.requestId,
      type: 'ERROR',
      payload: {
        code: WorkerErrorCode.QUERY_ERROR,
        message: statsError instanceof Error
          ? statsError.message
          : String(statsError),
        details: statsError instanceof Error ? statsError.stack : undefined,
      },
    });
  }
  break;
}
```

#### Filtered Count Flow

The UI requests filtered counts by sending the `countSql` from the query builder as a regular `QUERY_PAGE`:

```
User types search "Alice"
       │
       ▼
Query builder generates:
  dataSql:  SELECT * FROM "data" WHERE ("name" ILIKE '%Alice%') LIMIT 100 OFFSET 0
  countSql: SELECT COUNT(*)::INTEGER AS cnt FROM "data" WHERE ("name" ILIKE '%Alice%')
       │
       ├──▶ client.request('QUERY_PAGE', { sql: dataSql })  → rows for display
       │
       └──▶ client.request('QUERY_PAGE', { sql: countSql }) → { cnt: 4523 } for total
```

Both queries run through the same `QUERY_PAGE` handler. The count query returns a `QueryResult` with a single row `{ cnt: number }`. The calling code extracts `result.payload.rows[0].cnt`.

**Why not a dedicated `COUNT_QUERY` message type?** The protocol already supports arbitrary SQL via `QUERY_PAGE`. Adding another message type for count queries adds protocol complexity without functional benefit. The calling code knows it sent a count query and extracts the result accordingly.

#### Parallel vs Sequential Execution

The data query and count query are independent — they can be sent in parallel from the main thread:

```typescript
const [dataResult, countResult] = await Promise.all([
  client.request<QueryResult>('QUERY_PAGE', { sql: dataSql }),
  client.request<QueryResult>('QUERY_PAGE', { sql: countSql }),
]);
```

However, inside the worker, DuckDB WASM uses a single connection (`conn`). DuckDB WASM's `AsyncDuckDB` serializes queries internally — the second query waits for the first to complete. This means:
- From the main thread: both promises are in flight simultaneously (**good** — no sequential await)
- In the worker: queries execute one after another (**fine** — DuckDB handles this)
- Total time: data query time + count query time (**acceptable** — both are fast for LIMIT/OFFSET queries)

**Future optimization (Phase 6):** Open a second DuckDB connection for count queries, enabling true parallel execution. DuckDB supports multiple read connections.

**Acceptance Criteria:**
- [ ] `GET_STATS` returns `STATS_RESULT` with correct `totalRows` and `columns` for the loaded table
- [ ] `GET_STATS` for a non-existent table returns `ERROR` with `code: 'QUERY_ERROR'`
- [ ] `GET_STATS` before `INIT_DUCKDB` returns `ERROR` with `code: 'INIT_FAILED'`
- [ ] Filtered count via `QUERY_PAGE` with count SQL returns a single row with `cnt`
- [ ] Count query and data query can be sent in parallel from the main thread

---

### TASK-015: Stale Query Protection (Latest-Wins)

**Goal:** Ensure that when the user rapidly changes filters/sort/search, only the most recent query result is applied to the UI. Older, stale responses are discarded.

**Files:**
- `src/hooks/useQueryPage.ts` — new hook managing query state, debouncing, and stale protection
- `src/types/query-state.ts` — new types for query state

#### Query State Types

```typescript
// src/types/query-state.ts
import type { ColumnInfo } from './worker-protocol';
import type { ColumnFilter, SortSpec } from '../lib/sql-builder';

export interface QueryParams {
  filters: ColumnFilter[];
  sort: SortSpec[];
  search: string;
  offset: number;
  limit: number;
}

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

export interface QueryPageState {
  status: QueryStatus;
  rows: Record<string, unknown>[];
  columns: ColumnInfo[];
  totalFilteredRows: number;
  totalRows: number;          // unfiltered count (from ingest)
  error: string | null;
  queryElapsedMs: number;
}
```

#### useQueryPage Hook

```typescript
// src/hooks/useQueryPage.ts
import { useState, useRef, useCallback, useEffect } from 'react';
import type { WorkerClient } from '../lib/worker-client';
import type { QueryResult, ColumnInfo } from '../types/worker-protocol';
import { WorkerRequestError } from '../lib/worker-client';
import { buildQuery } from '../lib/sql-builder';
import type { QueryParams, QueryPageState } from '../types/query-state';

const DEFAULT_PAGE_SIZE = 100;
const DEBOUNCE_MS = 300;

export function useQueryPage(
  client: WorkerClient | null,
  tableName: string,
  columns: ColumnInfo[],
  totalRows: number,
) {
  const [params, setParams] = useState<QueryParams>({
    filters: [],
    sort: [],
    search: '',
    offset: 0,
    limit: DEFAULT_PAGE_SIZE,
  });

  const [state, setState] = useState<QueryPageState>({
    status: 'idle',
    rows: [],
    columns: [],
    totalFilteredRows: totalRows,
    totalRows,
    error: null,
    queryElapsedMs: 0,
  });

  // Generation counter for stale response protection
  const generationRef = useRef(0);
  // Track in-flight request IDs for cancellation
  const dataRequestIdRef = useRef<string | null>(null);
  const countRequestIdRef = useRef<string | null>(null);
  // Debounce timer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Determine which columns are searchable (text-like types).
   * Only VARCHAR and TEXT columns support ILIKE search.
   */
  const searchColumns = columns
    .filter((col) => {
      const t = col.type.toUpperCase();
      return t === 'VARCHAR' || t === 'TEXT' || t.startsWith('VARCHAR');
    })
    .map((col) => col.name);

  /**
   * Execute the query for the current params.
   * Handles stale response protection and cancellation.
   */
  const executeQuery = useCallback(
    async (queryParams: QueryParams) => {
      if (!client) return;

      const generation = ++generationRef.current;

      // Cancel previous in-flight queries
      if (dataRequestIdRef.current) {
        client.cancel(dataRequestIdRef.current);
        dataRequestIdRef.current = null;
      }
      if (countRequestIdRef.current) {
        client.cancel(countRequestIdRef.current);
        countRequestIdRef.current = null;
      }

      const { dataSql, countSql } = buildQuery({
        tableName,
        filters: queryParams.filters,
        sort: queryParams.sort,
        search: queryParams.search,
        searchColumns,
        offset: queryParams.offset,
        limit: queryParams.limit,
      });

      setState((prev) => ({ ...prev, status: 'loading', error: null }));

      try {
        // Fire data query and count query in parallel
        const dataPromise = client.request<QueryResult>('QUERY_PAGE', {
          sql: dataSql,
        });
        const countPromise = client.request<QueryResult>('QUERY_PAGE', {
          sql: countSql,
        });

        // Track request IDs for potential cancellation
        dataRequestIdRef.current = client.getLastRequestId();

        const [dataResult, countResult] = await Promise.all([
          dataPromise,
          countPromise,
        ]);

        // Stale check — only apply if this is still the latest generation
        if (generation !== generationRef.current) return;

        const filteredCount =
          Number((countResult.payload.rows[0] as Record<string, unknown>)?.cnt ?? 0);

        setState({
          status: 'success',
          rows: dataResult.payload.rows,
          columns: dataResult.payload.columns,
          totalFilteredRows: filteredCount,
          totalRows,
          error: null,
          queryElapsedMs: dataResult.payload.elapsedMs,
        });
      } catch (err) {
        // Ignore errors from cancelled/superseded queries
        if (generation !== generationRef.current) return;
        if (err instanceof WorkerRequestError && err.code === 'CANCELLED') return;

        setState((prev) => ({
          ...prev,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        if (generation === generationRef.current) {
          dataRequestIdRef.current = null;
          countRequestIdRef.current = null;
        }
      }
    },
    [client, tableName, totalRows, searchColumns]
  );

  /**
   * Debounced query execution — filters, sort, and search changes
   * are debounced to avoid excessive queries during rapid input.
   * Offset/limit changes (pagination) execute immediately.
   */
  const debouncedExecute = useCallback(
    (queryParams: QueryParams, immediate: boolean = false) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      if (immediate) {
        executeQuery(queryParams);
      } else {
        debounceTimerRef.current = setTimeout(() => {
          executeQuery(queryParams);
        }, DEBOUNCE_MS);
      }
    },
    [executeQuery]
  );

  // Execute query when params change
  useEffect(() => {
    debouncedExecute(params);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [params, debouncedExecute]);

  // Initial query on mount
  useEffect(() => {
    if (client && tableName) {
      executeQuery(params);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tableName]);

  // ── Public API ──────────────────────────────────────────────

  const setFilters = useCallback(
    (filters: QueryParams['filters']) => {
      setParams((prev) => ({ ...prev, filters, offset: 0 })); // reset to page 1
    },
    []
  );

  const setSort = useCallback(
    (sort: QueryParams['sort']) => {
      setParams((prev) => ({ ...prev, sort, offset: 0 })); // reset to page 1
    },
    []
  );

  const setSearch = useCallback(
    (search: string) => {
      setParams((prev) => ({ ...prev, search, offset: 0 })); // reset to page 1
    },
    []
  );

  const setPage = useCallback(
    (offset: number) => {
      setParams((prev) => ({ ...prev, offset }));
    },
    []
  );

  const setPageSize = useCallback(
    (limit: number) => {
      setParams((prev) => ({ ...prev, limit, offset: 0 })); // reset to page 1
    },
    []
  );

  return {
    ...state,
    params,
    setFilters,
    setSort,
    setSearch,
    setPage,
    setPageSize,
  };
}
```

#### Stale Protection Sequence Diagram

```
User types "A"        User types "Al"       User types "Ali"
     │                      │                      │
     ▼                      ▼                      ▼
 gen=1                  gen=2                  gen=3
 cancel(-)              cancel(req_1)          cancel(req_2)
 send req_1             send req_2             send req_3
     │                      │                      │
     ▼                      ▼                      ▼
 (worker busy)          (worker busy)          (worker busy)
     │                      │                      │
     │  req_1 response      │                      │
     │◀─────────────────────│                      │
     │  gen=1 ≠ current(3)  │                      │
     │  → DISCARDED         │                      │
     │                      │  req_2 rejected      │
     │                      │  (was cancelled)     │
     │                      │  → ignored           │
     │                      │                      │
     │                      │                      │  req_3 response
     │                      │                      │◀────────────────
     │                      │                      │  gen=3 = current(3)
     │                      │                      │  → APPLIED ✓
```

**Key behaviors:**
1. Each new query increments the generation counter
2. Previous in-flight queries are cancelled via `client.cancel()`
3. If a response arrives for a stale generation (race condition), the generation check discards it
4. Cancellation errors are silently ignored (expected behavior, not an error state)
5. Only the response matching the current generation updates the UI state

#### Debounce Strategy

Not all state changes are debounced equally:

| Change | Debounced? | Reason |
|--------|-----------|--------|
| Filter value change | Yes (300ms) | User is typing — wait for pause |
| Search text change | Yes (300ms) | Same — rapid keystrokes |
| Sort change | Yes (300ms) | Click-based, but debounce prevents double-click races |
| Page change (offset) | No (immediate) | User clicked "Next Page" — expects instant response |
| Page size change | No (immediate) | User selected from dropdown — expects instant response |

**Acceptance Criteria:**
- [ ] Rapid filter changes (e.g., typing a search term) only result in one query being applied to the UI
- [ ] Previous in-flight queries are cancelled when a new query is dispatched
- [ ] Stale responses arriving after cancellation are silently discarded (no UI corruption)
- [ ] Cancellation errors from superseded queries do not trigger error states
- [ ] Filter/search changes reset the offset to 0 (back to first page)
- [ ] Page navigation changes execute immediately (no debounce delay)
- [ ] The hook exposes `status`, `rows`, `columns`, `totalFilteredRows`, `error`, and query params setters
- [ ] Count query runs in parallel with data query
- [ ] Generation counter increments monotonically and is never reset during a session

---

## File Structure (Phase 3 Deliverables)

```
src/
├── types/
│   ├── worker-protocol.ts        # (Phase 1 — no changes needed)
│   ├── ingest-state.ts           # (Phase 2 — no changes)
│   └── query-state.ts            # NEW: QueryParams, QueryPageState types
├── worker/
│   ├── duckdb.worker.ts          # UPDATED: QUERY_PAGE + GET_STATS handlers
│   ├── duckdb-init.ts            # (Phase 1 — no changes)
│   ├── csv-loader.ts             # (Phase 2 — no changes)
│   └── query-executor.ts         # NEW: SQL execution + Arrow materialization
├── lib/
│   ├── worker-client.ts          # (Phase 1 — no changes needed)
│   ├── request-id.ts             # (Phase 1 — no changes)
│   └── sql-builder.ts            # NEW: Pure function query builder
├── hooks/
│   ├── useWorker.ts              # (Phase 2 — no changes)
│   └── useQueryPage.ts           # NEW: Query state management + stale protection
├── components/
│   ├── FileUpload.tsx             # (Phase 2 — no changes)
│   └── ProgressBar.tsx            # (Phase 2 — no changes)
├── App.tsx                        # (Phase 2 — no changes in Phase 3)
├── App.css                        # (no changes)
├── index.css                      # (no changes)
└── main.tsx                       # (no changes)
```

**Note on App.tsx:** Phase 3 does **not** update the App component or add any new UI components. The query engine is a headless layer. Phase 4 (Table UI + Virtualization) will integrate `useQueryPage` into the UI, adding the table component, connecting it to the query hook, and replacing the dead-end "Load Complete" card with a data grid.

This separation is deliberate: Phase 3 is testable in isolation via browser console and unit tests, without needing table UI in place.

---

## Implementation Order

```
TASK-012 (SQL builder) ──▶ TASK-013 (QUERY_PAGE handler) ──▶ TASK-014 (GET_STATS handler)
                                      │                              │
                                      └──────────────────────────────┘
                                                    │
                                                    ▼
                                          TASK-015 (stale protection hook)
```

**Recommended execution order:**

1. **TASK-012 first** — The SQL builder is a pure function with no dependencies on the worker or React. It can be implemented and unit-tested entirely in isolation. This is the foundation for all query operations.

2. **TASK-013 second** — Implement `QUERY_PAGE` handler and `query-executor.ts`. Once complete, you can test end-to-end by sending raw `postMessage` calls from the browser console:
   ```javascript
   worker.postMessage({
     requestId: 'q1',
     type: 'QUERY_PAGE',
     payload: { sql: 'SELECT * FROM "data" LIMIT 10 OFFSET 0' }
   });
   ```

3. **TASK-014 third** — Implement `GET_STATS` handler. Similar to TASK-013 but simpler (no pagination, no SQL builder interaction). Test via console:
   ```javascript
   worker.postMessage({
     requestId: 's1',
     type: 'GET_STATS',
     payload: { tableName: 'data' }
   });
   ```

4. **TASK-015 last** — Build the `useQueryPage` hook. This requires both the worker handlers (013, 014) and the SQL builder (012) to be in place. It can be tested by temporarily wiring it into `App.tsx` and calling its methods from a `useEffect` or by logging state to the console.

---

## Verification Plan

### Unit Tests (TASK-012)

The SQL builder is pure function — ideal for unit testing:

```typescript
// Example test cases for sql-builder
describe('buildQuery', () => {
  it('generates basic SELECT with LIMIT/OFFSET', () => {
    const { dataSql, countSql } = buildQuery({
      tableName: 'data',
      filters: [],
      sort: [],
      search: '',
      searchColumns: [],
      offset: 0,
      limit: 100,
    });
    expect(dataSql).toBe('SELECT * FROM "data" LIMIT 100 OFFSET 0');
    expect(countSql).toBe('SELECT COUNT(*)::INTEGER AS cnt FROM "data"');
  });

  it('escapes single quotes in filter values', () => {
    const { dataSql } = buildQuery({
      tableName: 'data',
      filters: [{ column: 'name', operator: 'eq', value: "O'Brien" }],
      sort: [],
      search: '',
      searchColumns: [],
      offset: 0,
      limit: 100,
    });
    expect(dataSql).toContain("'O''Brien'");
  });

  it('double-quotes column names with spaces', () => {
    const { dataSql } = buildQuery({
      tableName: 'data',
      filters: [{ column: 'first name', operator: 'eq', value: 'Alice' }],
      sort: [],
      search: '',
      searchColumns: [],
      offset: 0,
      limit: 100,
    });
    expect(dataSql).toContain('"first name"');
  });

  it('generates ILIKE search across multiple columns', () => {
    const { dataSql } = buildQuery({
      tableName: 'data',
      filters: [],
      sort: [],
      search: 'test',
      searchColumns: ['name', 'email'],
      offset: 0,
      limit: 100,
    });
    expect(dataSql).toContain(
      '("name" ILIKE \'%test%\' OR "email" ILIKE \'%test%\')'
    );
  });

  it('composes filters AND search correctly', () => {
    const { dataSql } = buildQuery({
      tableName: 'data',
      filters: [{ column: 'age', operator: 'gt', value: '18' }],
      sort: [{ column: 'name', direction: 'asc' }],
      search: 'alice',
      searchColumns: ['name'],
      offset: 200,
      limit: 50,
    });
    expect(dataSql).toContain('WHERE');
    expect(dataSql).toContain('"age" > \'18\'');
    expect(dataSql).toContain('"name" ILIKE \'%alice%\'');
    expect(dataSql).toContain('ORDER BY "name" ASC');
    expect(dataSql).toContain('LIMIT 50 OFFSET 200');
  });

  it('escapes LIKE wildcards in search input', () => {
    const { dataSql } = buildQuery({
      tableName: 'data',
      filters: [],
      sort: [],
      search: '100%',
      searchColumns: ['value'],
      offset: 0,
      limit: 100,
    });
    // % should be escaped to \%
    expect(dataSql).toContain('100\\%');
  });
});
```

### Console Smoke Test (TASK-013 + TASK-014)

After implementing the worker handlers, test end-to-end from the browser console:

```javascript
// 1. Load a CSV first (using the existing UI)
// 2. Open browser console
// 3. Access the WorkerClient (exposed via React DevTools or a debug global)

// Test QUERY_PAGE — basic select
worker.postMessage({
  requestId: 'test_q1',
  type: 'QUERY_PAGE',
  payload: { sql: 'SELECT * FROM "data" LIMIT 5 OFFSET 0' }
});
// Expected: QUERY_RESULT with 5 rows and correct columns

// Test QUERY_PAGE — filtered
worker.postMessage({
  requestId: 'test_q2',
  type: 'QUERY_PAGE',
  payload: { sql: "SELECT * FROM \"data\" WHERE \"name\" ILIKE '%Alice%' LIMIT 10 OFFSET 0" }
});

// Test QUERY_PAGE — count
worker.postMessage({
  requestId: 'test_q3',
  type: 'QUERY_PAGE',
  payload: { sql: 'SELECT COUNT(*)::INTEGER AS cnt FROM "data"' }
});
// Expected: QUERY_RESULT with single row { cnt: <number> }

// Test QUERY_PAGE — invalid SQL
worker.postMessage({
  requestId: 'test_q4',
  type: 'QUERY_PAGE',
  payload: { sql: 'SELECT * FROM nonexistent_table' }
});
// Expected: ERROR with code QUERY_ERROR

// Test GET_STATS
worker.postMessage({
  requestId: 'test_s1',
  type: 'GET_STATS',
  payload: { tableName: 'data' }
});
// Expected: STATS_RESULT with totalRows and columns
```

### Build Validation

```bash
npm run build    # must compile without errors
npm run lint     # no lint violations in new files
tsc --noEmit     # type check all files
```

### What We Are NOT Testing in Phase 3

- Table UI rendering (Phase 4)
- Filter/sort/search UI controls (Phase 5)
- Virtualized scrolling performance (Phase 4)
- Query performance under load (Phase 6)
- Large dataset behavior (Phase 6)

Phase 3 success = SQL builder generates correct SQL, worker executes queries and returns rows, stale query protection discards outdated responses.

---

## Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Arrow-to-object materialization loses type fidelity (dates, BigInt) | Medium | Medium | Add explicit type conversion in `query-executor.ts`. Convert BigInt to Number, format dates as ISO strings. Document edge cases. |
| `ILIKE` search on large tables (5M rows) is slow without indexes | Medium | Medium | DuckDB is columnar and optimized for scans. For 5M rows, ILIKE on a VARCHAR column takes 100-500ms — acceptable. Phase 6 can add column sampling or indexed search if needed. |
| Concurrent QUERY_PAGE + count query serialization in single connection | Low | Low | DuckDB handles internal serialization. If perf is a concern, Phase 6 opens a second connection. |
| Debounce timing (300ms) feels sluggish or too aggressive | Low | Low | Make debounce interval configurable in the hook. Tune in Phase 6. |
| SQL injection via column names from CSV headers | Low | High | Column names are double-quoted via `quoteIdentifier()`. Internal double quotes are escaped. DuckDB's quoted identifier syntax prevents injection. |

---

## Dependencies

No new npm packages required. All needed packages are already installed:
- `@duckdb/duckdb-wasm` — query execution
- `react` — hooks for state management

---

## What Comes Next (Phase 4 Preview)

Phase 3 delivers the **query backbone** — a headless layer that can build SQL, execute paginated queries, and manage stale responses. Phase 4 will plug into it:

- **TASK-016:** Build TanStack Table shell with typed columns, wired to `useQueryPage` rows
- **TASK-017:** Integrate react-window for row virtualization (render only visible rows)
- **TASK-018:** Implement page cache — prefetch adjacent pages for smooth scrolling
- **TASK-019:** Add loading/empty/error states in the table area

The `useQueryPage` hook from TASK-015 is the primary API that Phase 4 components consume. Its return value (`rows`, `columns`, `status`, `totalFilteredRows`, `setPage`, etc.) maps directly to TanStack Table's data model and pagination controls.

The key integration point: after `ingestState.phase === 'complete'` in `App.tsx`, instead of showing the dead-end summary card, mount a `<DataTable>` component that internally uses `useQueryPage(client, tableName, columns, totalRows)` and renders the result through TanStack Table + react-window.
