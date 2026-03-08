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
