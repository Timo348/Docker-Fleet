import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { AppConfig, HostConfig, LogLine } from '../shared/types.js';
import type { AgentTransport } from './agent-client.js';
import { ApiError } from './errors.js';

interface ActiveStream {
  user: string;
  host: HostConfig;
  controller: AbortController;
}
export function cleanLogText(text: string): string {
  // Strip CSI and OSC escape sequences and neutralize remaining terminal controls.
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
export class LogStreams {
  private active = new Map<string, ActiveStream>();
  constructor(
    private config: AppConfig,
    private transport: AgentTransport,
  ) {}
  configure(config: AppConfig): void {
    for (const stream of this.active.values()) {
      const host = config.hosts.find((host) => host.id === stream.host.id);
      if (
        !host?.enabled ||
        host.agentUrl !== stream.host.agentUrl ||
        host.credentialRef !== stream.host.credentialRef ||
        JSON.stringify(config.logs) !== JSON.stringify(this.config.logs)
      )
        stream.controller.abort();
    }
    this.config = config;
  }
  async open(
    host: HostConfig,
    containerId: string,
    user: string,
    tail: number,
    follow: boolean,
    clientSignal: AbortSignal,
  ): Promise<Readable> {
    const limits = this.config.logs;
    if (
      this.active.size >= limits.maxStreamsTotal ||
      [...this.active.values()].filter((stream) => stream.user === user).length >=
        limits.maxStreamsPerUser
    )
      throw new ApiError(
        429,
        'LOG_STREAM_LIMIT',
        'The concurrent log stream limit has been reached. Close another log view first.',
      );
    const streamId = randomUUID();
    const controller = new AbortController();
    this.active.set(streamId, { user, host, controller });
    const abort = () => controller.abort();
    clientSignal.addEventListener('abort', abort, { once: true });
    const ttl = setTimeout(abort, limits.maxStreamSeconds * 1000);
    ttl.unref();
    const release = () => {
      clearTimeout(ttl);
      clientSignal.removeEventListener('abort', abort);
      this.active.delete(streamId);
    };
    let source: Readable;
    try {
      source = await this.transport.logs(host, containerId, tail, follow, controller.signal);
    } catch (error) {
      release();
      throw error;
    }
    const destroy = () => source.destroy();
    controller.signal.addEventListener('abort', destroy, { once: true });
    if (controller.signal.aborted || clientSignal.aborted) {
      source.destroy();
      release();
      throw new ApiError(408, 'LOG_CANCELLED', 'The log request was cancelled.');
    }
    let emittedBytes = 0;
    const output = Readable.from(
      (async function* () {
        const decoder = new StringDecoder('utf8');
        let pending = '';
        function serialize(line: string): string {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new ApiError(502, 'INVALID_LOG_DATA', 'The agent returned invalid log data.');
          }
          if (!parsed || typeof parsed !== 'object')
            throw new ApiError(502, 'INVALID_LOG_DATA', 'The agent returned invalid log data.');
          const value = parsed as Partial<LogLine>;
          if (
            !['stdout', 'stderr', 'console'].includes(value.stream || '') ||
            typeof value.text !== 'string'
          )
            throw new ApiError(502, 'INVALID_LOG_DATA', 'The agent returned invalid log data.');
          let text = cleanLogText(value.text);
          let truncated = value.truncated === true;
          if (Buffer.byteLength(text) > limits.maxLineBytes) {
            text = Buffer.from(text).subarray(0, limits.maxLineBytes).toString('utf8');
            truncated = true;
          }
          const dto: LogLine = {
            stream: value.stream!,
            text,
            ...(typeof value.timestamp === 'string' && value.timestamp.length <= 64
              ? { timestamp: value.timestamp }
              : {}),
            ...(truncated ? { truncated: true } : {}),
          };
          return `${JSON.stringify(dto)}\n`;
        }
        try {
          for await (const chunk of source) {
            if (controller.signal.aborted) break;
            pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            if (Buffer.byteLength(pending) > limits.maxBufferBytes)
              throw new ApiError(
                502,
                'LOG_BUFFER_LIMIT',
                'The agent log buffer exceeded its limit.',
              );
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
              const raw = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (!raw.trim()) continue;
              const line = serialize(raw);
              emittedBytes += Buffer.byteLength(line);
              // A download is bounded as a whole; follow streams are bounded in memory and duration.
              if (!follow && emittedBytes > limits.maxBufferBytes) {
                yield `${JSON.stringify({ stream: 'console', text: 'Log excerpt reached its size limit.', truncated: true })}\n`;
                return;
              }
              yield line;
            }
          }
          pending += decoder.end();
          if (pending.trim() && !controller.signal.aborted) {
            const line = serialize(pending);
            if (follow || emittedBytes + Buffer.byteLength(line) <= limits.maxBufferBytes)
              yield line;
          }
          if (controller.signal.aborted && !clientSignal.aborted)
            yield `${JSON.stringify({ stream: 'console', text: 'Log stream stopped: time limit or configuration changed. Open the view again to continue.' })}\n`;
        } catch {
          if (!clientSignal.aborted)
            yield `${JSON.stringify({ stream: 'console', text: controller.signal.aborted ? 'Log stream stopped: time limit or configuration changed.' : 'Log stream ended because the agent connection or log format failed.' })}\n`;
        } finally {
          controller.abort();
          source.destroy();
          release();
        }
      })(),
      { highWaterMark: Math.min(limits.maxBufferBytes, 65536), objectMode: false },
    );
    output.once('close', () => {
      controller.abort();
      release();
    });
    return output;
  }
  close(): void {
    for (const stream of this.active.values()) stream.controller.abort();
    this.active.clear();
  }
  get count(): number {
    return this.active.size;
  }
}
