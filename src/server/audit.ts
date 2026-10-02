import { mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action } from '../shared/types.js';

export interface AuditEvent {
  time: string;
  user: string;
  host: string;
  containerId: string;
  action: Action;
  result: 'pending' | 'success' | 'failure' | 'unknown';
  requestId: string;
}
export class AuditLog {
  private queue = Promise.resolve();
  private path: string;
  constructor(
    private directory: string,
    private maxBytes: number,
  ) {
    this.path = join(directory, 'audit.jsonl');
  }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(this.path, 'a', 0o600);
    await file.close();
  }
  record(event: Omit<AuditEvent, 'time'>): Promise<void> {
    const task = this.queue.then(async () => {
      // Deliberately construct the record: errors, headers, secrets and logs can never be serialized here.
      const line = `${JSON.stringify({ time: new Date().toISOString(), user: event.user, host: event.host, containerId: event.containerId, action: event.action, result: event.result, requestId: event.requestId } satisfies AuditEvent)}\n`;
      const size = (await stat(this.path).catch(() => ({ size: 0 }))).size;
      if (size + Buffer.byteLength(line) > this.maxBytes)
        await rename(this.path, `${this.path}.1`).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      const file = await open(this.path, 'a', 0o600);
      try {
        await file.writeFile(line, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  async close(): Promise<void> {
    await this.queue;
  }
}
