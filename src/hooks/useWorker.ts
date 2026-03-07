import { useEffect, useRef, useState } from 'react';
import { WorkerClient } from '../lib/worker-client';
import type { InitDuckDBReady } from '../types/worker-protocol';

export type WorkerStatus = 'loading' | 'initializing' | 'ready' | 'error';

export interface UseWorkerReturn {
  status: WorkerStatus;
  error: string | null;
  client: WorkerClient | null;
}

export function useWorker(): UseWorkerReturn {
  const [status, setStatus] = useState<WorkerStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<WorkerClient | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL('../worker/duckdb.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const client = new WorkerClient(worker);
    clientRef.current = client;

    setStatus('initializing');

    client
      .request<InitDuckDBReady>('INIT_DUCKDB', { logLevel: 'WARNING' })
      .then(() => {
        setStatus('ready');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });

    return () => {
      client.destroy();
    };
  }, []);

  // eslint-disable-next-line react-hooks/refs
  return { status, error, client: clientRef.current };
}
