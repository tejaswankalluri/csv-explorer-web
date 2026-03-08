import { useState, useCallback } from 'react';
import { useWorker } from './hooks/useWorker';
import { FileUpload } from './components/FileUpload';
import { ProgressBar } from './components/ProgressBar';
import { CsvGridView } from './components/CsvGridView';
import type { IngestState } from './types/ingest-state';
import type { LoadCSVComplete, LoadCSVProgress } from './types/worker-protocol';
import { WorkerRequestError } from './lib/worker-client';

function App() {
  const { status, error: workerError, client } = useWorker();
  const [ingestState, setIngestState] = useState<IngestState>({ phase: 'idle' });

  const handleFileSelected = useCallback(
    async (file: File) => {
      if (!client) return;

      setIngestState({
        phase: 'reading',
        fileName: file.name,
        fileSize: file.size,
      });

      try {
        const buffer = await file.arrayBuffer();

        setIngestState({
          phase: 'loading',
          fileName: file.name,
          fileSize: file.size,
          rowsLoaded: 0,
          bytesProcessed: 0,
          totalBytes: buffer.byteLength,
          currentPhase: 'parsing',
        });

        const result = await client.request<LoadCSVComplete>(
          'LOAD_CSV',
          {
            fileName: file.name,
            fileContent: buffer,
          },
          {
            transfer: [buffer],
            timeoutMs: 300_000,
            onStream: (msg) => {
              if (msg.type === 'LOAD_CSV_PROGRESS') {
                const progress = msg as LoadCSVProgress;
                setIngestState({
                  phase: 'loading',
                  fileName: file.name,
                  fileSize: file.size,
                  rowsLoaded: progress.payload.rowsLoaded,
                  bytesProcessed: progress.payload.bytesProcessed,
                  totalBytes: progress.payload.totalBytes,
                  currentPhase: progress.payload.phase,
                });
              }
            },
          }
        );

        setIngestState({
          phase: 'complete',
          fileName: file.name,
          tableName: result.payload.tableName,
          totalRows: result.payload.totalRows,
          columns: result.payload.columns,
          elapsedMs: result.payload.elapsedMs,
        });
      } catch (err) {
        if (err instanceof WorkerRequestError && err.code === 'CANCELLED') {
          setIngestState({ phase: 'cancelled' });
        } else {
          const message =
            err instanceof Error ? err.message : String(err);
          setIngestState({ phase: 'error', message });
        }
      }
    },
    [client]
  );

  const handleCancel = useCallback(() => {
    if (client) {
      const requestId = client.getLastRequestId();
      if (requestId) {
        client.cancel(requestId);
      }
    }
  }, [client]);

  const handleReset = () => {
    setIngestState({ phase: 'idle' });
  };

  return (
    <>
      {ingestState.phase === 'complete' ? (
        <CsvGridView
          client={client!}
          fileName={ingestState.fileName}
          tableName={ingestState.tableName}
          columns={ingestState.columns}
          totalRows={ingestState.totalRows}
          onReset={handleReset}
        />
      ) : (
        <div className="min-h-screen bg-slate-50 p-8">
          <div className="max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold text-slate-800 mb-6">
              CSV Explorer
            </h1>

            {status === 'loading' && (
              <div className="bg-white rounded-lg shadow p-8">
                <div className="flex flex-col items-center justify-center">
                  <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
                  <p className="mt-4 text-slate-600">Loading...</p>
                </div>
              </div>
            )}

            {status === 'initializing' && (
              <div className="bg-white rounded-lg shadow p-6">
                <p className="text-slate-600">Initializing DuckDB...</p>
              </div>
            )}

            {status === 'error' && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-red-700">Failed to initialize: {workerError}</p>
              </div>
            )}

            {status === 'ready' && ingestState.phase === 'idle' && (
              <FileUpload onFileSelected={handleFileSelected} />
            )}

            {ingestState.phase === 'reading' && (
              <div className="bg-white rounded-lg shadow p-6">
                <p className="text-slate-600">
                  Reading {ingestState.fileName}...
                </p>
              </div>
            )}

            {ingestState.phase === 'loading' && (
              <ProgressBar
                fileName={ingestState.fileName}
                fileSize={ingestState.fileSize}
                bytesProcessed={ingestState.bytesProcessed}
                totalBytes={ingestState.totalBytes}
                rowsLoaded={ingestState.rowsLoaded}
                currentPhase={ingestState.currentPhase}
                onCancel={handleCancel}
              />
            )}

            {ingestState.phase === 'cancelled' && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-yellow-700 mb-4">Load cancelled</p>
                <button
                  onClick={handleReset}
                  className="px-4 py-2 bg-slate-800 text-white rounded hover:bg-slate-700 transition-colors"
                >
                  Try Again
                </button>
              </div>
            )}

            {ingestState.phase === 'error' && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-red-700 mb-4">Error: {ingestState.message}</p>
                <button
                  onClick={handleReset}
                  className="px-4 py-2 bg-slate-800 text-white rounded hover:bg-slate-700 transition-colors"
                >
                  Try Again
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default App;
