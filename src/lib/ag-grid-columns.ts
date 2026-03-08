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
    };

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
