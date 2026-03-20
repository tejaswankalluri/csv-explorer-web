import type { IDatasource, IGetRowsParams } from 'ag-grid-community';
import type { WorkerClient } from './worker-client';
import type { ColumnInfo, QueryResult } from '../types/worker-protocol';
import { buildQuery } from './sql-builder';
import { adaptSortModel, adaptFilterModel } from './ag-grid-adapter';

export function createDuckDBDatasource(
  client: WorkerClient,
  tableName: string,
  columns: ColumnInfo[],
  search: string,
): IDatasource {
  const searchColumns = columns.map((col) => col.name);

  return {
    rowCount: undefined,

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
        search,
        searchColumns,
        offset,
        limit,
      });

      Promise.all([
        client.request<QueryResult>('QUERY_PAGE', { sql: dataSql }),
        client.request<QueryResult>('QUERY_PAGE', { sql: countSql }),
      ])
        .then(([dataResult, countResult]) => {
          const rows = dataResult.payload.rows;
          const totalFilteredCount = Number(
            (countResult.payload.rows[0] as Record<string, unknown>)?.cnt ?? 0
          );

          const lastRow = totalFilteredCount;

          successCallback(rows, lastRow);
        })
        .catch(() => {
          failCallback();
        });
    },
  };
}
