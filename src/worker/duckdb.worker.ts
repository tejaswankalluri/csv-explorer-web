import type {
  WorkerRequest,
  WorkerResponse,
  WorkerError,
  InitDuckDBReady,
  LoadCSVRequest,
  LoadCSVProgress,
  LoadCSVComplete,
} from '../types/worker-protocol';
import { WorkerErrorCode } from '../types/worker-protocol';
import { initializeDuckDB, db, conn } from './duckdb-init';
import { loadCSV, CancelledError } from './csv-loader';

interface RuntimeWorkerMessage {
  requestId?: unknown;
  type?: unknown;
  payload?: unknown;
}

const activeOperations = new Map<string, { cancelled: boolean }>();

function isWorkerRequestType(type: unknown): type is WorkerRequest['type'] {
  return (
    type === 'INIT_DUCKDB' ||
    type === 'LOAD_CSV' ||
    type === 'QUERY_PAGE' ||
    type === 'GET_STATS' ||
    type === 'CANCEL'
  );
}

/** Type-safe postMessage wrapper */
function respond<T extends WorkerResponse>(msg: T): void {
  self.postMessage(msg);
}

/**
 * Main message handler — routes incoming requests by type.
 */
self.onmessage = async (event: MessageEvent<RuntimeWorkerMessage>) => {
  const raw = event.data;

  const requestId =
    typeof raw?.requestId === 'string' ? raw.requestId : 'unknown_request';

  if (!isWorkerRequestType(raw?.type)) {
    respond<WorkerError>({
      requestId,
      type: 'ERROR',
      payload: {
        code: WorkerErrorCode.INVALID_REQUEST,
        message: `Unknown message type: ${String(raw?.type)}`,
      },
    });
    return;
  }

  const msg = {
    requestId,
    type: raw.type,
    payload: raw.payload,
  } as WorkerRequest;

  try {
    switch (msg.type) {
      case 'INIT_DUCKDB': {
        let version: string;
        try {
          version = await initializeDuckDB(msg.payload.logLevel);
        } catch (initError) {
          respond<WorkerError>({
            requestId: msg.requestId,
            type: 'ERROR',
            payload: {
              code: WorkerErrorCode.INIT_FAILED,
              message:
                initError instanceof Error
                  ? initError.message
                  : String(initError),
              details:
                initError instanceof Error ? initError.stack : undefined,
            },
          });
          return;
        }
        respond<InitDuckDBReady>({
          requestId: msg.requestId,
          type: 'INIT_DUCKDB_READY',
          payload: { version },
        });
        break;
      }

      case 'CANCEL': {
        const signal = activeOperations.get(msg.payload.targetRequestId);
        if (signal) {
          signal.cancelled = true;
        }
        break;
      }

      case 'LOAD_CSV': {
        if (!db || !conn) {
          respond<WorkerError>({
            requestId: msg.requestId,
            type: 'ERROR',
            payload: {
              code: WorkerErrorCode.INIT_FAILED,
              message: 'DuckDB not initialized. Send INIT_DUCKDB first.',
            },
          });
          break;
        }

        const signal = { cancelled: false };
        activeOperations.set(msg.requestId, signal);

        try {
          const result = await loadCSV(
            db,
            conn,
            msg as LoadCSVRequest,
            (progress: LoadCSVProgress) => {
              respond<LoadCSVProgress>(progress);
            },
            signal
          );

          if (!signal.cancelled) {
            respond<LoadCSVComplete>({
              requestId: msg.requestId,
              type: 'LOAD_CSV_COMPLETE',
              payload: result,
            });
          }
        } catch (loadError) {
          if (loadError instanceof CancelledError) {
            respond<WorkerError>({
              requestId: msg.requestId,
              type: 'ERROR',
              payload: {
                code: WorkerErrorCode.CANCELLED,
                message: 'Load cancelled',
              },
            });
          } else {
            respond<WorkerError>({
              requestId: msg.requestId,
              type: 'ERROR',
              payload: {
                code: WorkerErrorCode.CSV_PARSE_ERROR,
                message:
                  loadError instanceof Error
                    ? loadError.message
                    : String(loadError),
                details:
                  loadError instanceof Error ? loadError.stack : undefined,
              },
            });
          }
        } finally {
          activeOperations.delete(msg.requestId);
        }
        break;
      }

      case 'QUERY_PAGE':
      case 'GET_STATS': {
        respond<WorkerError>({
          requestId: msg.requestId,
          type: 'ERROR',
          payload: {
            code: WorkerErrorCode.INVALID_REQUEST,
            message: `Message type '${msg.type}' is not yet implemented.`,
          },
        });
        break;
      }
    }
  } catch (error) {
    respond<WorkerError>({
      requestId: msg.requestId,
      type: 'ERROR',
      payload: {
        code: WorkerErrorCode.UNKNOWN,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof Error ? error.stack : undefined,
      },
    });
  }
};
