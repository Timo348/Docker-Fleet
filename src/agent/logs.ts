import type { Readable } from 'node:stream';
import type { LogLine } from '../shared/types.js';
import { AgentError } from './docker.js';

type Channel = LogLine['stream'];
interface Payload {
  stream: Channel;
  data: Buffer;
}

/** Incremental Docker demultiplexer: never allocates a frame-sized buffer. */
export async function* dockerPayloads(source: Readable, tty: boolean): AsyncGenerator<Payload> {
  let header = Buffer.alloc(0),
    remaining = 0;
  let channel: Channel = 'stdout';
  for await (const part of source) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    if (tty) {
      yield { stream: 'console', data: chunk };
      continue;
    }
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining === 0) {
        const take = Math.min(8 - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (header.length < 8) continue;
        if (
          (header[0] !== 1 && header[0] !== 2) ||
          header[1] !== 0 ||
          header[2] !== 0 ||
          header[3] !== 0
        )
          throw new AgentError('LOG_FORMAT_INVALID', 'Docker returned an invalid log frame.');
        channel = header[0] === 1 ? 'stdout' : 'stderr';
        remaining = header.readUInt32BE(4);
        header = Buffer.alloc(0);
        if (remaining > 16 * 1024 * 1024)
          throw new AgentError(
            'LOG_FRAME_LIMIT',
            'A Docker log frame exceeded the safe size limit.',
            413,
          );
        if (!remaining) continue;
      }
      const take = Math.min(remaining, chunk.length - offset);
      yield { stream: channel, data: chunk.subarray(offset, offset + take) };
      offset += take;
      remaining -= take;
    }
  }
  if (!tty && (header.length || remaining))
    throw new AgentError(
      'LOG_FORMAT_INVALID',
      'The Docker log stream ended in an incomplete frame.',
    );
}

export function safeLogText(text: string): string {
  // Text-only rendering is still required downstream; remove common ANSI/OSC/control bytes here too.
  return text
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-_])/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\r/g, '');
}

interface PartialLine {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

/** Keeps at most maxLineBytes per stdout/stderr channel, including lines without newlines. */
export async function* decodeLogLines(
  source: Readable,
  tty: boolean,
  maxLineBytes: number,
): AsyncGenerator<LogLine> {
  const partial = new Map<Channel, PartialLine>();
  function lineFor(channel: Channel): PartialLine {
    let value = partial.get(channel);
    if (!value) {
      value = { chunks: [], bytes: 0, truncated: false };
      partial.set(channel, value);
    }
    return value;
  }
  function append(line: PartialLine, data: Buffer): void {
    const take = Math.min(data.length, Math.max(0, maxLineBytes - line.bytes));
    // Copy bounded content; subarray views must not retain a potentially huge upstream chunk.
    if (take) {
      line.chunks.push(Buffer.from(data.subarray(0, take)));
      line.bytes += take;
    }
    if (take < data.length) line.truncated = true;
  }
  function finish(channel: Channel, line: PartialLine): LogLine {
    const value = safeLogText(Buffer.concat(line.chunks, line.bytes).toString('utf8'));
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) (.*)$/.exec(
      value,
    );
    const timestamp = match && Number.isFinite(Date.parse(match[1]!)) ? match[1] : undefined;
    return {
      stream: channel,
      text: timestamp ? match![2]! : value,
      ...(timestamp ? { timestamp } : {}),
      ...(line.truncated ? { truncated: true } : {}),
    };
  }
  for await (const payload of dockerPayloads(source, tty)) {
    let offset = 0;
    while (offset < payload.data.length) {
      const line = lineFor(payload.stream);
      const end = payload.data.indexOf(10, offset);
      append(line, payload.data.subarray(offset, end < 0 ? payload.data.length : end));
      if (end < 0) break;
      yield finish(payload.stream, line);
      partial.delete(payload.stream);
      offset = end + 1;
    }
  }
  for (const [channel, line] of partial)
    if (line.bytes || line.truncated) yield finish(channel, line);
}
