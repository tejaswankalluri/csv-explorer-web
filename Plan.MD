# CSV Explorer (DuckDB WASM) Project Plan

## 1) Project Goal
Build a fully client-side web application that can load and explore CSV files up to 5 million rows in the browser using DuckDB WASM, with fast filtering, sorting, search, and virtualized rendering.

## 2) Core Requirements
- Load CSV files up to 5M rows without freezing the UI.
- Run SQL queries in-browser via DuckDB WASM.
- Keep heavy data operations off the main thread using a Web Worker.
- Render only visible rows using virtualization (never render full dataset).
- Support filtering, sorting, and global search through table controls.
- Keep all processing local in the browser (no backend required).

## 3) Technology Stack
- Frontend: React + TypeScript (Vite)
- Table layer: TanStack Table
- Virtualization: react-window
- Data engine: DuckDB WASM
- CSV parsing/streaming: Papa Parse
- Worker: Dedicated Web Worker for ingest + query execution

## 4) High-Level Architecture
1. User uploads CSV.
2. Main thread sends file to Worker.
3. Worker progressively parses CSV in chunks (Papa Parse).
4. Worker inserts chunks into DuckDB table.
5. UI receives ingest progress updates.
6. UI filter/sort/search state is translated to SQL query descriptors.
7. Worker executes paginated SQL queries and returns only needed rows.
8. React table renders rows through react-window virtualization.

## 5) Performance Strategy
- Keep DuckDB and CSV ingest entirely in Worker.
- Chunked progressive ingest (tunable batch size).
- Debounced filter/search input.
- Request ID based query cancellation/stale response protection.
- Page-level row caching to reduce repeated queries while scrolling.
- Never render more than ~50 rows in viewport at once.

## 6) Data + Query Model
- Single imported table (for example: `data_table`) in DuckDB.
- SQL generation from UI controls:
  - `WHERE` for column filters
  - `ORDER BY` for multi-sort
  - global `ILIKE` search across text columns
  - `LIMIT/OFFSET` pagination
- Separate lightweight count query for total matched rows.

## 7) Message Protocol (UI <-> Worker)
Suggested message types:
- `INIT_DUCKDB`
- `LOAD_CSV_START`
- `LOAD_CSV_PROGRESS`
- `LOAD_CSV_COMPLETE`
- `QUERY_PAGE`
- `QUERY_RESULT`
- `GET_STATS`
- `CANCEL_QUERY`
- `ERROR`

Each request should carry a `requestId` to safely ignore stale responses.

## 8) UX Guidelines
- Clear upload and progress indicators.
- Disable query controls until minimum data is available.
- Show total rows loaded and filtered result count.
- Keep table interactions responsive during ingest.
- Display friendly errors for malformed CSV or type issues.

## 9) Testing and Validation
- Unit tests for SQL query builder and filter translation.
- Worker integration tests for ingest + query flow.
- UI tests for table controls + virtualization behavior.
- Performance smoke tests with large synthetic CSV datasets.
- Manual validation for memory usage and responsiveness.

## 10) Delivery Phases
1. Project scaffolding + dependency setup.
2. Worker + DuckDB bootstrap.
3. Progressive CSV ingest pipeline.
4. Paginated SQL query API.
5. TanStack table integration.
6. react-window virtualization.
7. Filtering/sorting/search controls.
8. Performance tuning + QA.
9. Documentation and handoff.
