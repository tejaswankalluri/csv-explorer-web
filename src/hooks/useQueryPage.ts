import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { WorkerClient } from '../lib/worker-client';
import { WorkerRequestError } from '../lib/worker-client';
import type { QueryResult, ColumnInfo } from '../types/worker-protocol';
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

  const generationRef = useRef(0);
  const dataRequestIdRef = useRef<string | null>(null);
  const countRequestIdRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchColumns = useMemo(
    () =>
      columns
        .filter((col) => {
          const t = col.type.toUpperCase();
          return t === 'VARCHAR' || t === 'TEXT' || t.startsWith('VARCHAR');
        })
        .map((col) => col.name),
    [columns]
  );

  const executeQuery = useCallback(
    async (queryParams: QueryParams) => {
      if (!client) return;

      const generation = ++generationRef.current;

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
        const dataPromise = client.request<QueryResult>('QUERY_PAGE', {
          sql: dataSql,
        });
        dataRequestIdRef.current = client.getLastRequestId();

        const countPromise = client.request<QueryResult>('QUERY_PAGE', {
          sql: countSql,
        });
        countRequestIdRef.current = client.getLastRequestId();

        const [dataResult, countResult] = await Promise.all([
          dataPromise,
          countPromise,
        ]);

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

  useEffect(() => {
    debouncedExecute(params);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [params, debouncedExecute]);

  useEffect(() => {
    setState((prev) => ({
      ...prev,
      totalRows,
      totalFilteredRows: totalRows,
    }));
  }, [totalRows]);

  const setFilters = useCallback(
    (filters: QueryParams['filters']) => {
      setParams((prev) => ({ ...prev, filters, offset: 0 }));
    },
    []
  );

  const setSort = useCallback(
    (sort: QueryParams['sort']) => {
      setParams((prev) => ({ ...prev, sort, offset: 0 }));
    },
    []
  );

  const setSearch = useCallback(
    (search: string) => {
      setParams((prev) => ({ ...prev, search, offset: 0 }));
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
      setParams((prev) => ({ ...prev, limit, offset: 0 }));
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
