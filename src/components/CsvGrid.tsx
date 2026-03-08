import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
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

const rowNumberColumn: ColDef = {
  headerName: '#',
  width: 60,
  sortable: false,
  filter: false,
  resizable: false,
  valueGetter: (params) => {
    if (params.node?.rowIndex != null) {
      return params.node.rowIndex + 1;
    }
    return null;
  },
};

export function CsvGrid({ client, tableName, columns, totalRows }: CsvGridProps) {
  const columnDefs = useMemo(() => [rowNumberColumn, ...buildAgColumnDefs(columns)], [columns]);

  const datasource = useMemo(
    () => createDuckDBDatasource(client, tableName, columns),
    [client, tableName, columns]
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
    <div style={{ height: '100vh', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1 }}>
        <AgGridReact
          theme={themeQuartz}
          modules={[AllCommunityModule]}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          rowModelType="infinite"
          cacheBlockSize={100}
          maxBlocksInCache={50}
          maxConcurrentDatasourceRequests={2}
          blockLoadDebounceMillis={50}
          infiniteInitialRowCount={Math.min(totalRows, 100)}
          onGridReady={(event) => {
            event.api.setGridOption('datasource', datasource);
          }}
          suppressCellFocus={false}
          animateRows={false}
          enableCellTextSelection={true}
          ensureDomOrder={true}
        />
      </div>
    </div>
  );
}
