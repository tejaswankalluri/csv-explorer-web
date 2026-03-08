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
    <div className="h-screen flex flex-col bg-slate-50">
      <header className="px-6 py-4 border-b border-slate-200/80 bg-white/80 backdrop-blur-sm flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">
              CSV Explorer
            </h1>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="font-medium text-slate-700 truncate max-w-xs">{fileName}</span>
              <span className="w-1 h-1 rounded-full bg-slate-300"></span>
              <span>{totalRows.toLocaleString()} rows</span>
              <span className="w-1 h-1 rounded-full bg-slate-300"></span>
              <span>{columns.length} columns</span>
            </div>
          </div>
        </div>
        <button
          onClick={onReset}
          className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-all duration-200 text-sm font-medium flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Load Another
        </button>
      </header>
      <div className="flex-1 overflow-hidden bg-white">
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
