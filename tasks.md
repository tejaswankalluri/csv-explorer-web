# CSV Explorer Task Board (AI-Agent Ready)

This file tracks all implementation tasks for the CSV Explorer project.

## Agent Execution Rules
- When an AI agent picks a task, it must update the owner field to its agent name/id.
- While working, set task status to `IN_PROGRESS`.
- **When the job is completed, the AI agent must mark that task as `DONE`.**
- If blocked, set status to `BLOCKED` and add a short blocker note.
- Do not edit unrelated tasks.

## Status Legend
- `TODO`
- `IN_PROGRESS`
- `BLOCKED`
- `DONE`

## Task Template
Use this structure for each task:

```
- [ ] TASK-ID: Short title
  - Status: TODO
  - Owner: unassigned
  - Depends on: none | TASK-XXX
  - Deliverable: brief expected outcome
  - Notes: optional
```

---

## Phase 0 - Project Setup

- [x] TASK-001: Initialize Vite React TypeScript app
  - Status: DONE
  - Owner: agent
  - Depends on: none
  - Deliverable: Base project scaffolded and runnable.

- [x] TASK-002: Install core dependencies
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-001
  - Deliverable: `@duckdb/duckdb-wasm`, `@tanstack/react-table`, `react-window`, `papaparse` installed.

- [x] TASK-003: Configure TypeScript and linting baseline
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-001
  - Deliverable: TS config and lint scripts aligned for project.

## Phase 1 - Worker + DuckDB Foundation

- [x] TASK-004: Create Worker message protocol types
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-002
  - Deliverable: Strongly typed request/response interfaces.

- [x] TASK-005: Implement DuckDB WASM initialization in Worker
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-004
  - Deliverable: Worker can initialize DuckDB and report readiness.

- [x] TASK-006: Implement Worker error handling + requestId routing
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-004
  - Deliverable: Stable request-response mapping and structured errors.

## Phase 2 - CSV Ingestion Pipeline

- [x] TASK-007: Build file upload UI and file handoff to Worker
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-001
  - Deliverable: User can select CSV and trigger load.

- [x] TASK-008: Implement progressive CSV parsing with Papa Parse
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-005
  - Deliverable: CSV processed in chunks in Worker.

- [x] TASK-009: Implement chunk insertion into DuckDB table
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-008
  - Deliverable: Parsed rows inserted in batches into DuckDB.

- [x] TASK-010: Add ingest progress events to UI
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-007, TASK-008, TASK-009
  - Deliverable: Progress bar and row counters update during load.

- [x] TASK-011: Add ingest cancel support
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-006, TASK-008
  - Deliverable: User can cancel ongoing ingest cleanly.

## Phase 3 - Query Engine + Pagination

- [x] TASK-012: Implement SQL query builder from table state
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-004
  - Deliverable: Safe WHERE/ORDER BY/LIMIT/OFFSET generation.

- [x] TASK-013: Implement paginated query endpoint in Worker
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-005, TASK-012
  - Deliverable: Worker returns page rows for requested range.

- [x] TASK-014: Implement total-count query for current filter
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-013
  - Deliverable: UI can show total matched rows.

- [x] TASK-015: Add stale query protection (latest-wins)
  - Status: DONE
  - Owner: agent
  - Depends on: TASK-006, TASK-013
  - Deliverable: Older query responses are ignored.

## Phase 4 - Table UI + Virtualization

- [ ] TASK-016: Build TanStack table shell with typed columns
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-007, TASK-013
  - Deliverable: Table structure wired to remote row data.

- [ ] TASK-017: Integrate react-window row virtualization
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-016
  - Deliverable: Only visible rows are rendered.

- [ ] TASK-018: Implement page cache for smooth scrolling
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-013, TASK-017
  - Deliverable: Reduced repeated page fetches.

- [ ] TASK-019: Add loading/empty/error states in table area
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-016
  - Deliverable: UX handles async and failure states clearly.

## Phase 5 - Filtering, Sorting, Search

- [ ] TASK-020: Add global search control with debounce
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-012, TASK-016
  - Deliverable: Search input updates query state efficiently.

- [ ] TASK-021: Add column filter controls
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-012, TASK-016
  - Deliverable: Per-column filters mapped to SQL predicates.

- [ ] TASK-022: Add multi-column sorting controls
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-012, TASK-016
  - Deliverable: Sort state maps to SQL ORDER BY.

- [ ] TASK-023: Sync table controls with Worker query requests
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-020, TASK-021, TASK-022
  - Deliverable: UI state changes trigger correct paged queries.

## Phase 6 - Performance Hardening

- [ ] TASK-024: Tune chunk sizes and query page size defaults
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-009, TASK-013
  - Deliverable: Stable defaults for large-file responsiveness.

- [ ] TASK-025: Add basic telemetry panel (rows loaded, query ms)
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-010, TASK-013
  - Deliverable: Lightweight performance visibility in UI.

- [ ] TASK-026: Memory profiling pass for large CSV handling
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-024
  - Deliverable: Documented improvements and constraints.

## Phase 7 - Testing + QA

- [ ] TASK-027: Unit tests for query builder
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-012
  - Deliverable: Test coverage for SQL generation cases.

- [ ] TASK-028: Worker integration tests (ingest + query)
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-013
  - Deliverable: End-to-end worker flow validated.

- [ ] TASK-029: UI behavior tests for table controls
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-023
  - Deliverable: Filtering/sorting/search interactions tested.

- [ ] TASK-030: Large dataset manual test script (up to 5M rows)
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-024, TASK-026
  - Deliverable: Reproducible manual test checklist and outcomes.

## Phase 8 - Documentation + Handoff

- [ ] TASK-031: Write README setup and run instructions
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-001, TASK-002
  - Deliverable: New developers can run app locally quickly.

- [ ] TASK-032: Document architecture and Worker protocol
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-004, TASK-013
  - Deliverable: Clear architecture reference for contributors.

- [ ] TASK-033: Document known limits and troubleshooting
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-030
  - Deliverable: Practical guidance for large-file edge cases.

- [ ] TASK-034: Final acceptance checklist
  - Status: TODO
  - Owner: unassigned
  - Depends on: TASK-027, TASK-028, TASK-029, TASK-030
  - Deliverable: Project completion checklist aligned to requirements.
