/*
File purpose: Manage the CSV worker and correlate asynchronous engine requests with responses.
*/
import { Worker } from 'node:worker_threads';
import type { EngineRequest, EngineResult, Metadata, WorkerResponse } from './protocol';

export class EngineClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: EngineResult) => void; reject: (reason: Error) => void }>();
  private closed = false;
  onMetadata: (metadata: Metadata) => void = () => {};
  onError: (error: Error) => void = () => {};

  constructor(workerPath: string) {
    this.worker = new Worker(workerPath);
    this.worker.on('message', (message: WorkerResponse) => {
      if ('event' in message) {
        if (message.event === 'metadata') this.onMetadata(message.data);
        else this.onError(new Error(message.message));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result ?? null);
    });
    this.worker.on('error', reason => { const error = reason instanceof Error ? reason : new Error(String(reason)); this.closed = true; this.fail(error); this.onError(error); });
    this.worker.on('exit', code => {
      if (!this.closed) { const error = new Error(`CSV worker stopped (${code}).`); this.closed = true; this.fail(error); this.onError(error); }
    });
  }

  request(request: EngineRequest): Promise<EngineResult> {
    if (this.closed) return Promise.reject(new Error('The CSV document is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  dispose(): void {
    this.closed = true;
    this.fail(new Error('The CSV document is closed.'));
    void this.worker.terminate();
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
