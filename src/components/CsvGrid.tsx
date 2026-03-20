import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridReadyEvent } from 'ag-grid-community';
import {
  AllCommunityModule,
  colorSchemeDark,
  themeQuartz,
} from 'ag-grid-community';
import type { WorkerClient } from '../lib/worker-client';
import type { ThemeMode } from '../lib/theme';
import type { ColumnInfo } from '../types/worker-protocol';
import { createDuckDBDatasource } from '../lib/duckdb-datasource';
import { buildAgColumnDefs } from '../lib/ag-grid-columns';

interface CsvGridProps {
  client: WorkerClient;
  tableName: string;
  columns: ColumnInfo[];
  totalRows: number;
  search: string;
  themeMode: ThemeMode;
}

const lightGridTheme = themeQuartz.withParams({
  backgroundColor: 'var(--panel-elevated)',
  foregroundColor: 'var(--text-primary)',
  headerBackgroundColor: 'var(--panel-hover)',
  headerTextColor: 'var(--text-secondary)',
  borderColor: 'var(--panel-border)',
  accentColor: '#6366f1',
});

const darkGridTheme = themeQuartz
  .withPart(colorSchemeDark)
  .withParams({
    backgroundColor: 'var(--panel-elevated)',
    foregroundColor: 'var(--text-primary)',
    headerBackgroundColor: 'var(--panel-hover)',
    headerTextColor: 'var(--text-secondary)',
    borderColor: 'var(--panel-border)',
    accentColor: '#818cf8',
  });

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

export function CsvGrid({
  client,
  tableName,
  columns,
  totalRows,
  search,
  themeMode,
}: CsvGridProps) {
  const gridRef = useRef<AgGridReact<Record<string, unknown>>>(null);
  const columnDefs = useMemo(() => [rowNumberColumn, ...buildAgColumnDefs(columns)], [columns]);
  const gridTheme = themeMode === 'dark' ? darkGridTheme : lightGridTheme;

  const datasource = useMemo(
    () => createDuckDBDatasource(client, tableName, columns, search),
    [client, tableName, columns, search]
  );

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api) {
      return;
    }

    api.setGridOption('datasource', datasource);
  }, [datasource]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      minWidth: 100,
      flex: 1,
    }),
    []
  );

  const handleGridReady = (event: GridReadyEvent) => {
    event.api.setGridOption('datasource', datasource);
  };

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1 }}>
        <AgGridReact
          ref={gridRef}
          theme={gridTheme}
          modules={[AllCommunityModule]}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          rowModelType="infinite"
          cacheBlockSize={100}
          maxBlocksInCache={50}
          maxConcurrentDatasourceRequests={2}
          blockLoadDebounceMillis={50}
          infiniteInitialRowCount={Math.min(totalRows, 100)}
          alwaysShowHorizontalScroll={true}
          onGridReady={handleGridReady}
          suppressCellFocus={false}
          animateRows={false}
          enableCellTextSelection={true}
          ensureDomOrder={true}
        />
      </div>
    </div>
  );
}
