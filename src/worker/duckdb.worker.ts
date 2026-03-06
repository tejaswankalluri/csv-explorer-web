import type {
  WorkerRequest,
  WorkerResponse,
  WorkerError,
  InitDuckDBReady,
} from '../types/worker-protocol';
import { WorkerErrorCode } from '../types/worker-protocol';
import { initializeDuckDB } from './duckdb-init';

interface RuntimeWorkerMessage {
  requestId?: unknown;
  type?: unknown;
  payload?: unknown;
}

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

      // LOAD_CSV, QUERY_PAGE, GET_STATS, CANCEL
      // will be implemented in Phase 2 and Phase 3

      case 'LOAD_CSV':
      case 'QUERY_PAGE':
      case 'GET_STATS':
      case 'CANCEL': {
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
