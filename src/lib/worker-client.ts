import type {
  WorkerRequest,
  WorkerResponse,
  WorkerErrorCode,
} from '../types/worker-protocol';
import { generateRequestId } from './request-id';

const DEFAULT_TIMEOUT_MS = 60_000;

type StreamCallback = (response: WorkerResponse) => void;

export interface PendingRequest {
  requestId: string;
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onStream?: StreamCallback;
}

export class WorkerClient {
  private worker: Worker;
  private pending = new Map<string, PendingRequest>();
  private lastRequestId: string | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleWorkerError.bind(this);
  }

  async request<T extends WorkerResponse>(
    type: WorkerRequest['type'],
    payload: unknown,
    options: {
      timeoutMs?: number;
      onStream?: StreamCallback;
      transfer?: Transferable[];
    } = {}
  ): Promise<T> {
    const requestId = generateRequestId();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.lastRequestId = requestId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(`Request ${requestId} timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        requestId,
        resolve: resolve as (v: WorkerResponse) => void,
        reject,
        timer,
        onStream: options.onStream,
      });

      const message = { requestId, type, payload } as WorkerRequest;

      if (options.transfer?.length) {
        this.worker.postMessage(message, options.transfer);
      } else {
        this.worker.postMessage(message);
      }
    });
  }

  getLastRequestId(): string | null {
    return this.lastRequestId;
  }

  cancel(targetRequestId: string): void {
    const pending = this.pending.get(targetRequestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(targetRequestId);
    pending.reject(new Error(`Request ${targetRequestId} was cancelled`));

    const cancelId = generateRequestId();
    this.worker.postMessage({
      requestId: cancelId,
      type: 'CANCEL',
      payload: { targetRequestId },
    } satisfies WorkerRequest);
  }

  destroy(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Worker client destroyed'));
    }
    this.pending.clear();
    this.worker.terminate();
  }

  private handleMessage(event: MessageEvent<WorkerResponse>): void {
    const response = event.data;
    const { requestId, type } = response;

    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    if (type === 'LOAD_CSV_PROGRESS') {
      pending.onStream?.(response);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    if (type === 'ERROR') {
      pending.reject(
        new WorkerRequestError(
          response.payload.code,
          response.payload.message
        )
      );
    } else {
      pending.resolve(response);
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    const error = new Error(`Worker error: ${event.message}`);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class WorkerRequestError extends Error {
  code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.name = 'WorkerRequestError';
    this.code = code;
  }
}
