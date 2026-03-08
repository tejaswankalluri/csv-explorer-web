# Phase 4: Table UI with AG Grid Community Edition

## Context

Phase 3 is complete. We have:
- **SQL query builder** (`src/lib/sql-builder.ts`) — pure function `buildQuery(state) → { dataSql, countSql }` with filter/sort/search composition and SQL escaping
- **QUERY_PAGE worker handler** (`src/worker/duckdb.worker.ts`) — executes arbitrary SQL via `query-executor.ts`, returns materialized rows as `Record<string, unknown>[]` with column metadata
- **GET_STATS worker handler** — returns unfiltered table stats (totalRows, columns)
- **useQueryPage hook** (`src/hooks/useQueryPage.ts`) — manages query state with debounced execution, stale query protection (generation counter), parallel data+count queries, and exposes `{ status, rows, columns, totalFilteredRows, params, setFilters, setSort, setSearch, setPage, setPageSize }`
- **App shell** (`src/App.tsx`) — after `ingestState.phase === 'complete'`, mounts `<DataTableView>` with full-width layout
- **Ingest complete state** carries `tableName`, `totalRows`, `columns: ColumnInfo[]`, and `elapsedMs`

Phase 4 replaces the previous TanStack Table + react-window implementation with **AG Grid Community Edition**, which provides virtualization, infinite scrolling, column management, sorting, and filtering in a single integrated library.

---

## Why Replace TanStack Table + react-window with AG Grid?

### Problems with the Previous Implementation

1. **100-row virtual cap.** The react-window implementation capped `rowCount` at `MAX_VIRTUAL_ROWS = 100`, making the scrollbar represent only 100 rows regardless of dataset size. This is a fundamental limitation of the approach — stitching together react-window + a custom page cache + TanStack Table never achieved true infinite scroll over millions of rows.

2. **Browser height limit unresolved.** For 5M rows at 35px each, the total pixel height is 175M px — far exceeding Chrome's ~33M px max element height. The old approach capped at 500K rows as a workaround. AG Grid has built-in row stretching that handles this natively.

3. **Three-library coordination.** TanStack Table (column defs/row model), react-window (DOM virtualization), and a custom page cache (data fetching) had to be wired together with manual glue code — `VirtualTableRow`, `usePageCache`, scroll-to-page mapping, etc. AG Grid handles all of this internally.

4. **Phase 5 re-implementation.** Sorting and filtering would require yet another layer of coordination between AG Grid's sort/filter state, our `useQueryPage` hook, and `sql-builder.ts`. With AG Grid's Infinite Row Model, sort/filter state is passed directly to the datasource — the grid handles the full lifecycle.

### What AG Grid Provides

AG Grid Community Edition (MIT license) includes:

| Feature | Previously Required | AG Grid Provides |
|---------|-------------------|-----------------|
| DOM virtualization (rows + columns) | react-window `List` | Built-in, rows AND columns |
| Infinite scroll over millions of rows | Custom `usePageCache` + page mapping | Infinite Row Model with block cache |
| LRU cache eviction | Custom `evictOldPages()` | `maxBlocksInCache` config |
| Column definitions + rendering | TanStack `createColumnHelper` | `ColDef` with `field`, `headerName`, types |
| Row numbers | Custom row number column in `VirtualTableRow` | Built-in `rowNumbersColumn` |
| Server-side sorting | Not implemented | `sortModel` passed to `getRows()` |
| Server-side filtering | Not implemented | `filterModel` passed to `getRows()` |
| Column resizing, moving, pinning | Not implemented | Built-in community features |
| Keyboard navigation | Not implemented | Built-in |
| Accessibility (ARIA) | Not implemented | Built-in |
| Browser height limit handling | Cap at 500K rows | Row stretching handles natively |

---

## Architectural Decision: AG Grid Row Model

### The Options

AG Grid offers four row models:

1. **Client-Side Row Model** — All data loaded in memory. AG Grid handles sort/filter/group internally. Not suitable for 5M rows.

2. **Infinite Row Model** (Community) — Lazy-loads rows in blocks from a datasource as user scrolls. Grid manages block cache with LRU eviction. Sorting and filtering delegate to the datasource. Ideal for our DuckDB worker architecture.

3. **Server-Side Row Model** (Enterprise only) — More advanced lazy loading with tree data, grouping, and pivoting. Requires paid license.

4. **Viewport Row Model** (Enterprise only) — Real-time data streaming. Requires paid license.

### Decision: Infinite Row Model

**Rationale:**

1. **Available in Community Edition.** No license cost, MIT-compatible.

2. **Perfect fit for our architecture.** The Infinite Row Model's `IDatasource.getRows()` interface maps directly to our DuckDB worker: AG Grid requests a block of rows (startRow, endRow) → we translate to SQL with `LIMIT/OFFSET` → DuckDB executes → we return rows via `successCallback`.

3. **Sort/filter delegation.** When the user sorts or filters, AG Grid passes `sortModel` and `filterModel` to `getRows()`. We translate these to our `sql-builder.ts` format and rebuild the query. AG Grid automatically purges its cache and re-fetches blocks.

4. **Built-in block cache.** AG Grid caches fetched blocks with configurable `maxBlocksInCache` (LRU eviction) and `cacheBlockSize`. This replaces our entire `usePageCache` hook.

5. **Handles massive row counts.** AG Grid natively supports millions of rows through its row stretching algorithm — no need to cap at 500K.

---

## Architectural Decision: Datasource Adapter Pattern

### The Problem

AG Grid's `IDatasource.getRows(params)` receives AG Grid-specific types (`IGetRowsParams` with `sortModel: SortModelItem[]`, `filterModel: Record<string, IFilterModel>`). Our existing `sql-builder.ts` uses its own types (`SortSpec[]`, `ColumnFilter[]`). We need an adapter layer.

### Decision: Thin adapter function, keep sql-builder unchanged

The adapter converts AG Grid's sort/filter models to our sql-builder's format:

```typescript
// src/lib/ag-grid-adapter.ts

import type { SortModelItem } from 'ag-grid-community';
import type { SortSpec, ColumnFilter, FilterOperator } from './sql-builder';

export function adaptSortModel(sortModel: SortModelItem[]): SortSpec[] {
  return sortModel.map((s) => ({
    column: s.colId,
    direction: s.sort as 'asc' | 'desc',
  }));
}

export function adaptFilterModel(
  filterModel: Record<string, unknown>
): ColumnFilter[] {
  const filters: ColumnFilter[] = [];
  for (const [column, model] of Object.entries(filterModel)) {
    const filter = model as { type?: string; filter?: string };
    if (!filter.type || filter.filter === undefined) continue;
    const operator = mapAgGridFilterType(filter.type);
    if (operator) {
      filters.push({ column, operator, value: String(filter.filter) });
    }
  }
  return filters;
}

function mapAgGridFilterType(agType: string): FilterOperator | null {
  const map: Record<string, FilterOperator> = {
    equals: 'eq',
    notEqual: 'neq',
    greaterThan: 'gt',
    greaterThanOrEqual: 'gte',
    lessThan: 'lt',
    lessThanOrEqual: 'lte',
    contains: 'contains',
    startsWith: 'starts_with',
    endsWith: 'ends_with',
  };
  return map[agType] ?? null;
}
```

**Why keep `sql-builder.ts` unchanged:**
- It's tested and stable (Phase 3)
- It has no AG Grid dependency — stays a pure SQL generation function
- Other consumers (e.g., future export, analytics) can use it without AG Grid
- The adapter is thin and easy to test independently

---

## Architectural Decision: What Happens to Existing Hooks

### `usePageCache.ts` — DELETE

AG Grid's Infinite Row Model manages its own block cache with LRU eviction (`maxBlocksInCache`). Our custom cache is redundant.

### `useQueryPage.ts` — DELETE (or KEEP as dormant utility)

This hook managed debounced query execution, stale query protection, and offset/limit state. With AG Grid's datasource pattern:
- **Debouncing** — AG Grid provides `blockLoadDebounceMillis`
- **Stale protection** — AG Grid manages request lifecycle (only `successCallback` for the most recent `getRows()` call matters; older blocks are automatically discarded if the datasource is reset)
- **Offset/limit state** — AG Grid passes `startRow`/`endRow` to `getRows()`

The datasource adapter calls `client.request()` directly. The hook's functionality is absorbed by AG Grid + the datasource.

**Decision:** Delete both hooks. The datasource function handles everything. If we need `useQueryPage` for other purposes later (e.g., a non-AG Grid view), we can restore it from git.

### `query-state.ts` — KEEP but may be unused

The `QueryParams` and `QueryPageState` types may not be directly consumed by AG Grid components, but they document the query model and could be useful for tests or future features. Keep the file; it has no runtime cost.

---

## Architectural Decision: Layout and Styling

### Grid Container

AG Grid requires a container with a **known height**. The grid fills 100% of its container. Our layout:

```
┌──────────────────────────────────────────────────────┐
│ Header bar (file name, row count, "Load Another")    │  ~56px
├──────────────────────────────────────────────────────┤
│                                                      │
│  AG Grid fills remaining viewport height             │  flex-1
│  (infinite scroll, virtual rows + columns)           │
│                                                      │
├──────────────────────────────────────────────────────┤
│ Status bar (viewing rows X–Y, query time, spinner)   │  ~36px
└──────────────────────────────────────────────────────┘
```

The grid container uses `flex-1 overflow-hidden` to fill available height. We measure the available height and set the grid's container accordingly.

### AG Grid Theme

AG Grid v35+ uses a new theming API. For our Tailwind-based project:

```typescript
import { themeQuartz } from 'ag-grid-community';

// Use the built-in Quartz theme (clean, modern)
// Customized with Tailwind-aligned colors via CSS variables
const gridTheme = themeQuartz.withParams({
  headerBackgroundColor: '#f1f5f9',     // slate-100
  headerTextColor: '#334155',           // slate-700
  headerFontSize: 14,
  rowHoverColor: '#eff6ff',             // blue-50
  oddRowBackgroundColor: '#fafafa',     // slight alternating
  borderColor: '#e2e8f0',              // slate-200
  fontSize: 14,
  cellTextColor: '#475569',            // slate-600
  spacing: 6,
  wrapperBorderRadius: 0,
});
```

This gives us a theme that matches our existing Tailwind color palette without writing custom CSS.

---

## Datasource Implementation

The datasource is the bridge between AG Grid and our DuckDB worker.

### Interface

```typescript
import type { IDatasource, IGetRowsParams } from 'ag-grid-community';
import type { WorkerClient } from './worker-client';
import type { ColumnInfo, QueryResult } from '../types/worker-protocol';
import { buildQuery } from './sql-builder';
import { adaptSortModel, adaptFilterModel } from './ag-grid-adapter';

export function createDuckDBDatasource(
  client: WorkerClient,
  tableName: string,
  columns: ColumnInfo[],
  totalRows: number,
): IDatasource {
  // Derive text columns for global search
  const searchColumns = columns
    .filter((col) => {
      const t = col.type.toUpperCase();
      return t === 'VARCHAR' || t === 'TEXT' || t.startsWith('VARCHAR');
    })
    .map((col) => col.name);

  return {
    rowCount: undefined, // Unknown initially; we'll report via lastRow

    getRows(params: IGetRowsParams): void {
      const { startRow, endRow, sortModel, filterModel, successCallback, failCallback } = params;

      const limit = endRow - startRow;
      const offset = startRow;

      const sort = adaptSortModel(sortModel);
      const filters = adaptFilterModel(filterModel);

      const { dataSql, countSql } = buildQuery({
        tableName,
        filters,
        sort,
        search: '', // Global search wired in Phase 5
        searchColumns,
        offset,
        limit,
      });

      // Execute data + count queries in parallel
      Promise.all([
        client.request<QueryResult>('QUERY_PAGE', { sql: dataSql }),
        client.request<QueryResult>('QUERY_PAGE', { sql: countSql }),
      ])
        .then(([dataResult, countResult]) => {
          const rows = dataResult.payload.rows;
          const totalFilteredCount = Number(
            (countResult.payload.rows[0] as Record<string, unknown>)?.cnt ?? 0
          );

          // lastRow tells AG Grid the total row count
          // Pass -1 if unknown, or the actual count when known
          const lastRow = totalFilteredCount;

          successCallback(rows, lastRow);
        })
        .catch(() => {
          failCallback();
        });
    },
  };
}
```

### How It Works

1. AG Grid calls `getRows({ startRow: 0, endRow: 100, sortModel: [], filterModel: {} })`
2. Datasource converts to SQL: `SELECT * FROM "data" LIMIT 100 OFFSET 0`
3. Also runs count query: `SELECT COUNT(*)::INTEGER AS cnt FROM "data"`
4. On success, calls `successCallback(rows, totalCount)`
5. AG Grid caches the block and renders the rows
6. When user scrolls to row 200, AG Grid calls `getRows({ startRow: 200, endRow: 300, ... })`
7. When user sorts by a column, AG Grid purges cache and calls `getRows()` with updated `sortModel`

### Count Query Optimization

The count query runs with every block fetch, which is wasteful for blocks within the same filter state. Optimization options:

- **Option A:** Cache the count separately and only re-run when filterModel changes. Detect filter changes by comparing serialized filterModel.
- **Option B:** Run count only on the first block fetch and when filters change.
- **Option C:** Always run both in parallel (simple, count is fast in DuckDB).

**Decision: Option C for Phase 4.** DuckDB's `COUNT(*)` on an in-memory table is sub-millisecond even for 5M rows. The overhead is negligible. Optimize in Phase 6 if profiling shows otherwise.

---

## Column Definition Generation

AG Grid column definitions are generated from our `ColumnInfo[]`:

```typescript
import type { ColDef } from 'ag-grid-community';
import type { ColumnInfo } from '../types/worker-protocol';

export function buildAgColumnDefs(columns: ColumnInfo[]): ColDef[] {
  return columns.map((col) => {
    const colDef: ColDef = {
      field: col.name,
      headerName: col.name,
      sortable: true,
      resizable: true,
      minWidth: 100,
      // AG Grid auto-sizes based on header, but we set a reasonable floor
    };

    // Set filter type based on DuckDB column type
    const upperType = col.type.toUpperCase();
    if (isNumericType(upperType)) {
      colDef.filter = 'agNumberColumnFilter';
    } else if (isDateType(upperType)) {
      colDef.filter = 'agDateColumnFilter';
    } else {
      colDef.filter = 'agTextColumnFilter';
    }

    return colDef;
  });
}

function isNumericType(type: string): boolean {
  return [
    'INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
    'FLOAT', 'DOUBLE', 'DECIMAL', 'NUMERIC', 'REAL',
    'HUGEINT', 'UBIGINT', 'UINTEGER', 'USMALLINT', 'UTINYINT',
  ].includes(type);
}

function isDateType(type: string): boolean {
  return ['DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ', 'TIME'].includes(type);
}
```

### Column Features (All Community)

- **Sortable:** Click header to sort. AG Grid passes `sortModel` to datasource.
- **Filterable:** Column menu with filter type based on data type. AG Grid passes `filterModel` to datasource.
- **Resizable:** Drag column borders to resize.
- **Movable:** Drag headers to reorder columns.
- **Row numbers:** AG Grid's built-in `rowNumbersColumn` or `selection.displayRowNumbers`.

---

## Grid Component

### `CsvGrid.tsx` — Main Grid Component

```typescript
import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { GridApi, GridReadyEvent, ColDef } from 'ag-grid-community';
import { AllCommunityModule, themeQuartz } from 'ag-grid-community';
import type { WorkerClient } from '../lib/worker-client';
import type { ColumnInfo } from '../types/worker-protocol';
import { createDuckDBDatasource } from '../lib/duckdb-datasource';
import { buildAgColumnDefs } from '../lib/ag-grid-columns';

interface CsvGridProps {
  client: WorkerClient;
  tableName: string;
  columns: ColumnInfo[];
  totalRows: number;
}

const gridTheme = themeQuartz.withParams({
  headerBackgroundColor: '#f1f5f9',
  headerTextColor: '#334155',
  headerFontSize: 14,
  rowHoverColor: '#eff6ff',
  oddRowBackgroundColor: '#fafafa',
  borderColor: '#e2e8f0',
  fontSize: 14,
  cellTextColor: '#475569',
  spacing: 6,
  wrapperBorderRadius: 0,
});

export function CsvGrid({ client, tableName, columns, totalRows }: CsvGridProps) {
  const gridApiRef = useRef<GridApi | null>(null);

  const columnDefs = useMemo(() => buildAgColumnDefs(columns), [columns]);

  const datasource = useMemo(
    () => createDuckDBDatasource(client, tableName, columns, totalRows),
    [client, tableName, columns, totalRows]
  );

  const onGridReady = useCallback(
    (event: GridReadyEvent) => {
      gridApiRef.current = event.api;
      event.api.setGridOption('datasource', datasource);
    },
    [datasource]
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      minWidth: 100,
      flex: 1,
    }),
    []
  );

  return (
    <div className="flex-1 overflow-hidden">
      <AgGridReact
        modules={[AllCommunityModule]}
        theme={gridTheme}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        rowModelType="infinite"
        cacheBlockSize={100}
        maxBlocksInCache={50}
        maxConcurrentDatasourceRequests={2}
        blockLoadDebounceMillis={50}
        infiniteInitialRowCount={Math.min(totalRows, 100)}
        onGridReady={onGridReady}
        rowSelection="multiple"
        suppressCellFocus={false}
        animateRows={false}
        // Row numbers
        rowNumbersColumn={true}
      />
    </div>
  );
}
```

### `CsvGridView.tsx` — Wrapper Component (replaces DataTableView)

```typescript
import type { WorkerClient } from '../lib/worker-client';
import type { ColumnInfo } from '../types/worker-protocol';
import { CsvGrid } from './CsvGrid';

interface CsvGridViewProps {
  client: WorkerClient;
  fileName: string;
  tableName: string;
  columns: ColumnInfo[];
  totalRows: number;
  onReset: () => void;
}

export function CsvGridView({
  client,
  fileName,
  tableName,
  columns,
  totalRows,
  onReset,
}: CsvGridViewProps) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-bold text-slate-800">CSV Explorer</h1>
          <p className="text-sm text-slate-500">
            {fileName} — {totalRows.toLocaleString()} rows
          </p>
        </div>
        <button
          onClick={onReset}
          className="px-4 py-2 bg-slate-100 text-slate-700 rounded hover:bg-slate-200 transition-colors text-sm"
        >
          Load Another File
        </button>
      </header>
      <div className="flex-1 overflow-hidden">
        <CsvGrid
          client={client}
          tableName={tableName}
          columns={columns}
          totalRows={totalRows}
        />
      </div>
    </div>
  );
}
```

---

## Task Breakdown

### TASK-016: Install AG Grid and Remove Old Dependencies

**Goal:** Swap out TanStack Table and react-window for AG Grid packages. Verify clean install.

**Changes:**

```bash
npm uninstall @tanstack/react-table react-window
npm install ag-grid-react ag-grid-community
```

**Acceptance Criteria:**
- [ ] `@tanstack/react-table` removed from `package.json`
- [ ] `react-window` removed from `package.json`
- [ ] `ag-grid-react` installed
- [ ] `ag-grid-community` installed
- [ ] `npm install` completes without errors
- [ ] No import references to removed packages remain (verified by build)

---

### TASK-017: Build AG Grid Datasource Adapter

**Goal:** Create the bridge between AG Grid's Infinite Row Model and our DuckDB worker. This includes the datasource factory, sort/filter model adapters, and column definition generator.

**Files:**
- `src/lib/duckdb-datasource.ts` — NEW: `createDuckDBDatasource()` factory
- `src/lib/ag-grid-adapter.ts` — NEW: `adaptSortModel()`, `adaptFilterModel()` converters
- `src/lib/ag-grid-columns.ts` — NEW: `buildAgColumnDefs()` column definition generator

#### `duckdb-datasource.ts`

Creates an `IDatasource` implementation that:
1. Receives `getRows(params)` calls from AG Grid with `startRow`, `endRow`, `sortModel`, `filterModel`
2. Converts AG Grid models to our sql-builder types via adapter functions
3. Calls `buildQuery()` to generate SQL
4. Executes data + count queries in parallel via `client.request()`
5. Returns results via `successCallback(rows, lastRow)`
6. Handles errors via `failCallback()`

#### `ag-grid-adapter.ts`

Pure functions that convert between AG Grid types and our types:

- `adaptSortModel(sortModel: SortModelItem[]) → SortSpec[]`
  - Maps `colId` → `column`, `sort` → `direction`

- `adaptFilterModel(filterModel: Record<string, unknown>) → ColumnFilter[]`
  - Maps AG Grid filter types (`equals`, `contains`, `greaterThan`, etc.) to our `FilterOperator` type
  - Handles text, number, and date filter models

#### `ag-grid-columns.ts`

Generates AG Grid `ColDef[]` from `ColumnInfo[]`:
- Sets `field`, `headerName` from column name
- Sets `filter` type based on DuckDB type (text → `agTextColumnFilter`, numeric → `agNumberColumnFilter`, date → `agDateColumnFilter`)
- Sets `sortable: true`, `resizable: true`

**Acceptance Criteria:**
- [ ] `createDuckDBDatasource()` returns a valid `IDatasource` object
- [ ] `adaptSortModel()` correctly maps AG Grid sort model to `SortSpec[]`
- [ ] `adaptFilterModel()` correctly maps AG Grid filter models to `ColumnFilter[]`
- [ ] `buildAgColumnDefs()` generates correct column definitions for all DuckDB types
- [ ] Data queries use correct `LIMIT/OFFSET` from `startRow/endRow`
- [ ] Count queries run in parallel with data queries
- [ ] Error handling calls `failCallback()` on query failure
- [ ] TypeScript constraint: no enums (use `as const` objects), `import type` for type-only imports
- [ ] All types compile with `tsc --noEmit`

---

### TASK-018: Build CsvGrid + CsvGridView Components

**Goal:** Create the AG Grid React component and its view wrapper. Wire into App.tsx.

**Files:**
- `src/components/CsvGrid.tsx` — NEW: AG Grid component with infinite row model
- `src/components/CsvGridView.tsx` — NEW: view wrapper with header/layout (replaces DataTableView)
- `src/App.tsx` — UPDATED: import `CsvGridView` instead of `DataTableView`

#### `CsvGrid.tsx`

The main grid component:
- Uses `AgGridReact` with `rowModelType="infinite"`
- Configures `cacheBlockSize: 100`, `maxBlocksInCache: 50`, `maxConcurrentDatasourceRequests: 2`
- Sets datasource via `onGridReady`
- Applies Quartz theme customized with our Tailwind color palette
- Enables row numbers via `rowNumbersColumn` prop
- Enables column sorting and filtering (delegated to datasource)
- Uses `modules={[AllCommunityModule]}` for module registration

Key AG Grid configuration:

| Property | Value | Rationale |
|----------|-------|-----------|
| `rowModelType` | `'infinite'` | Enables infinite scroll with lazy block loading |
| `cacheBlockSize` | `100` | Rows per block — matches our existing page size |
| `maxBlocksInCache` | `50` | LRU eviction after 50 blocks (5,000 rows cached) |
| `maxConcurrentDatasourceRequests` | `2` | Limits parallel fetches to avoid overwhelming worker |
| `blockLoadDebounceMillis` | `50` | Debounces block loads during fast scrolling |
| `infiniteInitialRowCount` | `Math.min(totalRows, 100)` | Initial row count before first block loads |
| `animateRows` | `false` | Disable row animation for performance with large datasets |
| `rowNumbersColumn` | `true` | Built-in row numbers (1-based index) |

#### `CsvGridView.tsx`

Layout wrapper:
- Full-width layout with sticky header bar (file name, row count, "Load Another" button)
- Grid fills remaining viewport height via `flex-1`
- Replaces `DataTableView.tsx` functionally

#### `App.tsx`

Minimal change — swap the import:

```typescript
// Before:
import { DataTableView } from './components/DataTableView';

// After:
import { CsvGridView } from './components/CsvGridView';
```

And update the JSX to render `<CsvGridView>` instead of `<DataTableView>`. The props are the same (client, fileName, tableName, columns, totalRows, onReset).

**Acceptance Criteria:**
- [ ] AG Grid renders with infinite row model
- [ ] First block of rows (0–99) loads and displays on mount
- [ ] Scrolling loads subsequent blocks automatically
- [ ] Row numbers appear in a built-in column
- [ ] Column headers show column names from CSV
- [ ] Columns are sortable (click header → datasource re-fetches with sortModel)
- [ ] Column filters work (filter icon → filter panel → datasource re-fetches with filterModel)
- [ ] Grid fills available viewport height
- [ ] Theme matches our Tailwind color palette (slate headers, blue hover, etc.)
- [ ] "Load Another File" button works from the header
- [ ] All types compile with `tsc --noEmit`
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes

---

### TASK-019: Delete Old Phase 4 Files and Clean Up

**Goal:** Remove all files and imports from the old TanStack/react-window implementation.

**Files to DELETE:**
- `src/components/DataTable.tsx` — old TanStack/react-window table
- `src/components/DataTableView.tsx` — old view wrapper
- `src/components/VirtualTableRow.tsx` — old react-window row component
- `src/hooks/usePageCache.ts` — old page cache (replaced by AG Grid block cache)
- `src/hooks/useQueryPage.ts` — old query page hook (replaced by AG Grid datasource)

**Files to VERIFY (no dangling imports):**
- `src/App.tsx` — should import `CsvGridView`, not `DataTableView`
- No other file should import from deleted modules

**Acceptance Criteria:**
- [ ] All five files listed above are deleted
- [ ] No imports reference deleted files
- [ ] `npm run build` succeeds with no missing module errors
- [ ] `tsc --noEmit` passes
- [ ] `npm run lint` passes

---

## File Structure (Phase 4 Deliverables)

```
src/
├── types/
│   ├── worker-protocol.ts        # (no changes)
│   ├── ingest-state.ts           # (no changes)
│   └── query-state.ts            # (kept, may be unused — documents query model)
├── worker/
│   ├── duckdb.worker.ts          # (no changes)
│   ├── duckdb-init.ts            # (no changes)
│   ├── csv-loader.ts             # (no changes)
│   └── query-executor.ts         # (no changes)
├── lib/
│   ├── worker-client.ts          # (no changes)
│   ├── request-id.ts             # (no changes)
│   ├── sql-builder.ts            # (no changes — adapter layer handles conversion)
│   ├── duckdb-datasource.ts      # NEW: AG Grid IDatasource factory
│   ├── ag-grid-adapter.ts        # NEW: sort/filter model converters
│   └── ag-grid-columns.ts        # NEW: ColDef generator from ColumnInfo[]
├── hooks/
│   └── useWorker.ts              # (no changes) — usePageCache.ts and useQueryPage.ts DELETED
├── components/
│   ├── FileUpload.tsx             # (no changes)
│   ├── ProgressBar.tsx            # (no changes)
│   ├── CsvGrid.tsx                # NEW: AG Grid component (replaces DataTable.tsx)
│   └── CsvGridView.tsx            # NEW: view wrapper (replaces DataTableView.tsx)
├── App.tsx                        # UPDATED: import CsvGridView instead of DataTableView
├── index.css                      # (no changes, or minor AG Grid CSS import)
└── main.tsx                       # (no changes)

DELETED:
├── components/DataTable.tsx       # OLD
├── components/DataTableView.tsx   # OLD
├── components/VirtualTableRow.tsx # OLD
├── hooks/usePageCache.ts          # OLD
└── hooks/useQueryPage.ts          # OLD
```

---

## Implementation Order

```
TASK-016 (Install AG Grid, remove old deps)
         │
         ▼
TASK-017 (Datasource adapter + column defs)
         │
         ▼
TASK-018 (CsvGrid + CsvGridView + App.tsx wiring)
         │
         ▼
TASK-019 (Delete old files, clean up imports)
```

**Recommended execution order:**

1. **TASK-016 first** — Package swap. Quick task. Verify `npm install` succeeds. The app will NOT build at this point because old components still import removed packages. That's fine — TASK-019 handles cleanup after new components are in place.

2. **TASK-017 second** — Build the datasource adapter, sort/filter converters, and column definition generator. These are pure functions with no UI — testable in isolation. Verify types compile.

3. **TASK-018 third** — Build the grid component and view wrapper. Wire into `App.tsx`. This is the core deliverable — after this task, the app should be functional with AG Grid rendering data from DuckDB.

4. **TASK-019 last** — Delete old files, verify no dangling imports, clean build.

**Alternative order (if we want the app to stay buildable throughout):**

Build TASK-017 and TASK-018 first (new components alongside old), then do TASK-016 (package swap) and TASK-019 (cleanup) together. This avoids a broken build state. However, since we're replacing Phase 4 from scratch, a brief broken-build period is acceptable.

**Recommended approach: Build new alongside old, then swap.**

1. TASK-017: Build adapter files (no conflicts — new files)
2. Install AG Grid (keep old deps temporarily): `npm install ag-grid-react ag-grid-community`
3. TASK-018: Build `CsvGrid.tsx` and `CsvGridView.tsx`, update `App.tsx` to use `CsvGridView`
4. Verify the app works with AG Grid
5. TASK-016: Remove old deps: `npm uninstall @tanstack/react-table react-window`
6. TASK-019: Delete old files

This keeps the app in a working state after each step.

---

## Impact on Phase 5 (Filtering, Sorting, Search)

AG Grid's Infinite Row Model absorbs a large portion of what Phase 5 was supposed to deliver:

| Phase 5 Task | Original Scope | AG Grid Impact |
|-------------|---------------|----------------|
| TASK-020: Global search with debounce | Build search input, wire to sql-builder | **Still needed.** AG Grid's Quick Filter may work, or we build a custom search bar that injects search terms into the datasource. |
| TASK-021: Column filter controls | Build per-column filter UI | **Mostly handled by AG Grid.** Built-in `agTextColumnFilter`, `agNumberColumnFilter`, `agDateColumnFilter` with filter menus. Need adapter to convert AG Grid filter models to our SQL builder. (This adapter is built in TASK-017.) |
| TASK-022: Multi-column sorting controls | Build sort UI | **Fully handled by AG Grid.** Click headers for single sort, hold Shift for multi-sort. AG Grid passes `sortModel` to datasource. (Adapter built in TASK-017.) |
| TASK-023: Sync controls with Worker | Wire UI state to query pipeline | **Handled by AG Grid datasource.** When user sorts/filters, AG Grid purges cache and re-calls `getRows()` with updated models. |

**Phase 5 simplifies to:**
1. Global search input (external to AG Grid, updates datasource)
2. Fine-tuning filter type mapping for DuckDB-specific types
3. Custom cell renderers if needed (null handling, long text truncation, etc.)
4. Status bar enhancements (visible row range, query time, filter indicator)

---

## Verification Plan

### After TASK-016 (Package Swap)

```bash
npm ls ag-grid-react ag-grid-community    # both installed
npm ls @tanstack/react-table react-window  # should be empty/missing
```

### After TASK-017 (Datasource + Adapters)

```bash
tsc --noEmit    # type check — adapter files should compile
```

Manual verification (unit-test-like):
- `adaptSortModel([{ colId: 'name', sort: 'asc' }])` → `[{ column: 'name', direction: 'asc' }]`
- `adaptFilterModel({ name: { type: 'contains', filter: 'foo' } })` → `[{ column: 'name', operator: 'contains', value: 'foo' }]`
- `buildAgColumnDefs([{ name: 'id', type: 'INTEGER', nullable: false }])` → `[{ field: 'id', headerName: 'id', filter: 'agNumberColumnFilter', ... }]`

### After TASK-018 (Grid Component + Wiring)

```bash
npm run build    # full production build
tsc --noEmit     # type check
npm run lint     # lint check
```

**Manual smoke test:**
1. Run `npm run dev`, open browser
2. Upload a CSV file (small: 100–1000 rows)
3. Grid appears with correct columns and data
4. Scroll down — new blocks load automatically (no page buttons)
5. Click a column header — data re-sorts via DuckDB
6. Open a column filter — apply a filter — data re-filters via DuckDB
7. Column resize works (drag header border)
8. Row numbers appear and are correct
9. "Load Another File" button works

**Large dataset test:**
1. Upload a CSV with 100K+ rows
2. Scroll rapidly through the dataset — rows load smoothly
3. Scroll to the very end — last rows render correctly
4. Sort a column — grid refreshes with sorted data
5. No browser console errors about max height or missing rows

### After TASK-019 (Cleanup)

```bash
npm run build    # no missing module errors
tsc --noEmit     # no type errors
npm run lint     # no lint warnings
```

Verify deleted files don't exist:
```bash
ls src/components/DataTable.tsx         # should not exist
ls src/components/DataTableView.tsx     # should not exist
ls src/components/VirtualTableRow.tsx   # should not exist
ls src/hooks/usePageCache.ts            # should not exist
ls src/hooks/useQueryPage.ts            # should not exist
```

---

## Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AG Grid v35+ module registration API confusion (AllCommunityModule vs individual modules) | Medium | Medium | Use `AllCommunityModule` for simplicity. Only cherry-pick modules if bundle size is a concern (Phase 6). |
| AG Grid's `themeQuartz.withParams()` API may not support all CSS variables we need | Low | Low | Fall back to CSS overrides in `index.css` with AG Grid CSS variable names. |
| `IDatasource` type may not be directly importable from `ag-grid-community` in v35+ | Medium | Medium | Check actual exports. May need `import type { IDatasource } from 'ag-grid-community'` or it may be exposed differently. Use AG Grid's TypeScript docs as reference. |
| `rowNumbersColumn` prop may not exist in the version we install (API churn in v35) | Medium | Low | Fall back to adding a manual row number column: `{ headerName: '#', valueGetter: 'node.rowIndex + 1', width: 60, sortable: false, filter: false }`. |
| Count query on every block fetch could slow down if DuckDB table has complex WHERE clauses | Low | Medium | COUNT(*) with ILIKE filters on 5M text rows could be slow. Mitigated by DuckDB's columnar engine being fast at scans. Monitor in Phase 6. |
| AG Grid Community Infinite Row Model might not call `getRows()` with `filterModel` when column filters are applied (docs are ambiguous on this for Community) | Medium | High | Test this immediately in TASK-018. If AG Grid Community doesn't pass filterModel to datasource in infinite mode, we'll need to set `filterModel` externally and re-create the datasource on filter change. |
| `verbatimModuleSyntax` may conflict with AG Grid's module exports (some AG Grid imports might need `import type` vs `import`) | Medium | Medium | If AG Grid exports types as runtime values (e.g., `AllCommunityModule` is a value, `ColDef` is a type), use separate import statements. |

---

## Dependencies

**Add:**
- `ag-grid-react` — React wrapper for AG Grid
- `ag-grid-community` — Core AG Grid library (MIT license)

**Remove:**
- `@tanstack/react-table` — no longer needed
- `react-window` — no longer needed

**Keep (unchanged):**
- `@duckdb/duckdb-wasm`
- `papaparse`, `@types/papaparse`
- `react`, `react-dom`
- `tailwindcss` (via `@tailwindcss/vite`)
- All dev dependencies unchanged
