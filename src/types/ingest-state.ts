import type { ColumnInfo } from './worker-protocol';

export type IngestState =
  | { phase: 'idle' }
  | { phase: 'reading'; fileName: string; fileSize: number }
  | {
      phase: 'loading';
      fileName: string;
    fileSize: number;
    rowsLoaded: number;
    bytesProcessed: number;
    totalBytes: number;
      currentPhase: 'registering' | 'importing';
    }
  | {
      phase: 'complete';
      fileName: string;
      tableName: string;
      totalRows: number;
      columns: ColumnInfo[];
      elapsedMs: number;
    }
  | { phase: 'error'; message: string }
  | { phase: 'cancelled' };
