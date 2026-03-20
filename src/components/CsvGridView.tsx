import { useState } from 'react';
import type { WorkerClient } from '../lib/worker-client';
import type { ThemeMode } from '../lib/theme';
import type { ColumnInfo } from '../types/worker-protocol';
import { CsvGrid } from './CsvGrid';
import { ThemeToggle } from './ThemeToggle';

interface CsvGridViewProps {
  client: WorkerClient;
  fileName: string;
  tableName: string;
  columns: ColumnInfo[];
  totalRows: number;
  onReset: () => void;
  themeMode: ThemeMode;
  onToggleTheme: () => void;
}

export function CsvGridView({
  client,
  fileName,
  tableName,
  columns,
  totalRows,
  onReset,
  themeMode,
  onToggleTheme,
}: CsvGridViewProps) {
  const [search, setSearch] = useState('');

  return (
    <div className="h-screen flex flex-col bg-[var(--app-bg)] text-[var(--text-primary)]">
      <header className="shrink-0 border-b border-[var(--panel-border)] bg-[var(--panel-bg)] px-6 py-4 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/20">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h1 className="bg-gradient-to-r from-[var(--text-primary)] to-[var(--text-muted)] bg-clip-text text-xl font-bold text-transparent">
                Data Explorer
              </h1>
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <span className="max-w-xs truncate font-medium text-[var(--text-secondary)]">{fileName}</span>
                <span className="h-1 w-1 rounded-full bg-[var(--text-faint)]"></span>
                <span>{totalRows.toLocaleString()} rows</span>
                <span className="h-1 w-1 rounded-full bg-[var(--text-faint)]"></span>
                <span>{columns.length} columns</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle themeMode={themeMode} onToggle={onToggleTheme} />
            <div className="flex w-full max-w-md items-center justify-end gap-3">
              <label className="relative flex-1 min-w-[220px]">
                <svg
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-faint)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-4.35-4.35m1.85-5.15a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search across all columns"
                  className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-elevated)] py-2.5 pl-9 pr-9 text-sm text-[var(--text-primary)] shadow-sm outline-none transition placeholder:text-[var(--text-faint)] focus:border-indigo-400 focus:ring-4 focus:ring-[var(--accent-ring)]"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)] hover:text-[var(--text-secondary)]"
                    aria-label="Clear search"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </label>
              <button
                onClick={onReset}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-hover)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-all duration-200 hover:border-[var(--panel-border-strong)] hover:bg-[var(--panel-elevated)]"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Load Another
              </button>
            </div>
          </div>
        </div>
      </header>
      <div className="flex-1 overflow-hidden bg-[var(--panel-elevated)]">
        <CsvGrid
          client={client}
          tableName={tableName}
          columns={columns}
          totalRows={totalRows}
          search={search}
          themeMode={themeMode}
        />
      </div>
    </div>
  );
}
