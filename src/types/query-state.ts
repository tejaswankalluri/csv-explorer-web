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
  totalRows: number;
  error: string | null;
  queryElapsedMs: number;
}
