import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { TLSSocket } from 'node:tls';
import type { Action, LogLine } from '../shared/types.js';
import { AgentError, DockerClient, readBounded } from './docker.js';
import { Inventory, type DockerInspect } from './inventory.js';
import { decodeLogLines } from './logs.js';

export interface AgentOptions {
  hostId: string;
  bind: string;
  port: number;
  dockerSocket: string;
  development: boolean;
  tls?: { ca: Buffer; cert: Buffer; key: Buffer; allowedClientNames: string[] };
  maxStreams: number;
  maxLogBytes: number;
  maxLineBytes: number;
  maxTail: number;
  streamSeconds: number;
}

export function loadAgentOptions(env: NodeJS.ProcessEnv = process.env): AgentOptions {
  function required(name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  }
  function integer(name: string, fallback: number, min: number, max: number): number {
    const raw = env[name];
    if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error(`${name} must be an integer.`);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be between ${min} and ${max}.`);
    return value;
  }
  const hostId = required('AGENT_HOST_ID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(hostId))
    throw new Error(
      'AGENT_HOST_ID must be a stable ID containing letters, digits, underscores or hyphens.',
    );
  const development = env.AGENT_DEV_MODE === '1';
  if (env.AGENT_DEV_MODE !== undefined && !['0', '1'].includes(env.AGENT_DEV_MODE))
    throw new Error('AGENT_DEV_MODE must be 0 or 1.');
  const bind = env.AGENT_BIND ?? (development ? '127.0.0.1' : '0.0.0.0');
  if (development && bind !== '127.0.0.1')
    throw new Error('AGENT_DEV_MODE requires AGENT_BIND=127.0.0.1.');
  let tls: AgentOptions['tls'];
  if (!development) {
    const names = required('AGENT_ALLOWED_CLIENT_NAMES')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length || names.some((name) => name === '*' || name.length > 128))
      throw new Error('AGENT_ALLOWED_CLIENT_NAMES must contain explicit certificate common names.');
    const read = (name: string) => {
      try {
        return fs.readFileSync(required(name));
      } catch {
        throw new Error(`${name} must reference a readable TLS file.`);
      }
    };
    tls = {
      ca: read('AGENT_TLS_CA'),
      cert: read('AGENT_TLS_CERT'),
      key: read('AGENT_TLS_KEY'),
      allowedClientNames: names,
    };
  }
  return {
    hostId,
    bind,
    development,
    ...(tls ? { tls } : {}),
    port: integer('AGENT_PORT', 9443, 1, 65535),
    dockerSocket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    maxStreams: integer('AGENT_MAX_STREAMS', 4, 1, 32),
    maxLogBytes: integer('AGENT_MAX_LOG_BYTES', 2_097_152, 1024, 32 * 1024 * 1024),
    maxLineBytes: integer('AGENT_MAX_LINE_BYTES', 65_536, 256, 1024 * 1024),
    maxTail: integer('AGENT_MAX_TAIL', 5000, 1, 10_000),
    streamSeconds: integer('AGENT_STREAM_SECONDS', 600, 1, 3600),
  };
}

interface Dedup {
  key: string;
  expires: number;
  settled: boolean;
  promise: Promise<void>;
}

export class Actions {
  private readonly locked = new Set<string>();
  private readonly dedup = new Map<string, Dedup>();
  constructor(
    readonly docker: DockerClient,
    readonly inventory: Inventory,
    readonly maxEntries = 1024,
  ) {}
  run(id: string, action: Action, requestId: string): Promise<void> {
    const now = Date.now();
    for (const [key, value] of this.dedup)
      if (value.settled && value.expires <= now) this.dedup.delete(key);
    const key = `${id}:${action}`;
    const existing = this.dedup.get(requestId);
    if (existing) {
      if (existing.key !== key)
        return Promise.reject(
          new AgentError(
            'REQUEST_ID_CONFLICT',
            'This request ID was already used for a different operation.',
            409,
          ),
        );
      return existing.promise;
    }
    if (this.locked.has(id))
      return Promise.reject(
        new AgentError(
          'ACTION_IN_PROGRESS',
          'Another action is already running for this container.',
          409,
        ),
      );
    while (this.dedup.size >= this.maxEntries) {
      const oldest = [...this.dedup].find(([, value]) => value.settled);
      if (!oldest)
        return Promise.reject(
          new AgentError('ACTION_LIMIT_EXCEEDED', 'Too many operations are in progress.', 429),
        );
      this.dedup.delete(oldest[0]);
    }
    this.locked.add(id);
    const entry: Dedup = {
      key,
      expires: now + 600_000,
      settled: false,
      promise: Promise.resolve(),
    };
    entry.promise = this.execute(id, action).finally(() => {
      this.locked.delete(id);
      entry.settled = true;
      entry.expires = Date.now() + 600_000;
    });
    this.dedup.set(requestId, entry);
    return entry.promise;
  }
  private async execute(id: string, action: Action): Promise<void> {
    const before = await this.docker.json<DockerInspect>('GET', `/containers/${id}/json`);
    const state = before.State?.Status;
    const allowed =
      action === 'start' ? state === 'created' || state === 'exited' : state === 'running';
    if (!allowed)
      throw new AgentError(
        'STATE_CONFLICT',
        `The current container state does not allow ${action}. Refresh the container list.`,
        409,
      );
    await this.docker.json<unknown>(
      'POST',
      `/containers/${id}/${action}${action === 'start' ? '' : '?t=10'}`,
      undefined,
      30_000,
    );
    this.inventory.invalidate(id);
    const after = await this.docker.json<DockerInspect>('GET', `/containers/${id}/json`);
    const confirmed =
      action === 'stop' ? after.State?.Running === false : after.State?.Running === true;
    if (
      !confirmed ||
      (action === 'restart' &&
        (!after.State?.StartedAt || after.State.StartedAt === before.State?.StartedAt))
    ) {
      throw new AgentError(
        'STATE_NOT_CONFIRMED',
        'Docker accepted the action, but the resulting state could not be confirmed. Refresh before another action.',
        409,
      );
    }
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function writeLine(
  response: ServerResponse,
  line: LogLine,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed)
    throw new AgentError('REQUEST_CANCELLED', 'The log connection was closed.', 499);
  if (response.write(JSON.stringify(line) + '\n')) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      response.off('drain', drained);
      response.off('close', closed);
      signal.removeEventListener('abort', closed);
      error ? reject(error) : resolve();
    };
    const drained = () => finish();
    const closed = () =>
      finish(new AgentError('REQUEST_CANCELLED', 'The log connection was closed.', 499));
    const timer = setTimeout(
      () =>
        finish(
          new AgentError(
            'LOG_CONSUMER_TOO_SLOW',
            'The log stream closed because the client could not keep up.',
          ),
        ),
      2000,
    );
    timer.unref();
    response.once('drain', drained);
    response.once('close', closed);
    signal.addEventListener('abort', closed, { once: true });
  });
}

export function createAgent(
  options: AgentOptions,
  client?: DockerClient,
): { server: http.Server | https.Server; docker: DockerClient; close: () => Promise<void> } {
  if (options.development && options.bind !== '127.0.0.1')
    throw new Error('Development agent may only bind to 127.0.0.1.');
  if (!options.development && (!options.tls || !options.tls.allowedClientNames.length))
    throw new Error(
      'A production agent requires TLS and an explicit client certificate allowlist.',
    );
  const docker = client ?? new DockerClient({ socketPath: options.dockerSocket });
  const inventory = new Inventory(docker, options.hostId);
  const actions = new Actions(docker, inventory);
  let streams = 0,
    ordinaryRequests = 0;
  const activeStreams = new Set<AbortController>();
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let ordinary = false;
    try {
      const url = new URL(request.url ?? '/', 'https://agent.invalid');
      if (url.pathname === '/healthz' && request.method === 'GET') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (!options.development) {
        const socket = request.socket;
        const cn =
          socket instanceof TLSSocket ? socket.getPeerCertificate().subject?.CN : undefined;
        if (
          !(socket instanceof TLSSocket) ||
          !socket.authorized ||
          typeof cn !== 'string' ||
          !options.tls!.allowedClientNames.includes(cn)
        )
          throw new AgentError(
            'CLIENT_UNAUTHORIZED',
            'A trusted, explicitly authorized client certificate is required.',
            403,
          );
      }
      if (!url.pathname.startsWith('/v1/'))
        throw new AgentError('NOT_FOUND', 'Unknown agent endpoint.', 404);
      if (ordinaryRequests >= 32)
        throw new AgentError(
          'REQUEST_LIMIT_EXCEEDED',
          'The agent is handling too many requests.',
          429,
        );
      ordinaryRequests++;
      ordinary = true;
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, { hostId: options.hostId, version: 1 });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/snapshot') {
        sendJson(response, 200, await inventory.snapshot());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/stats') {
        sendJson(response, 200, await inventory.stats());
        return;
      }
      const match = /^\/v1\/containers\/([a-f0-9]{64})\/(start|stop|restart|logs)$/.exec(
        url.pathname,
      );
      if (!match)
        throw new AgentError(
          'NOT_FOUND',
          'Unknown agent endpoint or invalid full container ID.',
          404,
        );
      const id = match[1]!,
        action = match[2]!;
      if (action !== 'logs' && request.method === 'POST') {
        if (url.search)
          throw new AgentError('INVALID_INPUT', 'Action query parameters are not allowed.', 400);
        if (!request.headers['content-type']?.startsWith('application/json'))
          throw new AgentError('INVALID_INPUT', 'Actions require application/json.', 415);
        const raw = await readBounded(request, 1024);
        let body: unknown;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new AgentError('INVALID_INPUT', 'The action body must be valid JSON.', 400);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new AgentError('INVALID_INPUT', 'The action body must be an object.', 400);
        const record = body as Record<string, unknown>;
        if (
          Object.keys(record).some((key) => !['requestId', 'actor'].includes(key)) ||
          typeof record.requestId !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            record.requestId,
          ) ||
          (record.actor !== undefined &&
            (typeof record.actor !== 'string' || record.actor.length > 256))
        )
          throw new AgentError(
            'INVALID_INPUT',
            'A valid requestId UUID and only supported action fields are required.',
            400,
          );
        await actions.run(id, action as Action, record.requestId);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (action === 'logs' && request.method === 'GET') {
        if (
          [...url.searchParams.keys()].some((key) => !['tail', 'follow'].includes(key)) ||
          url.searchParams.getAll('tail').length > 1 ||
          url.searchParams.getAll('follow').length > 1
        )
          throw new AgentError(
            'INVALID_INPUT',
            'Only one tail and follow parameter are allowed.',
            400,
          );
        const rawTail = url.searchParams.get('tail') ?? '200';
        const follow = url.searchParams.get('follow') ?? 'false';
        if (
          !/^\d+$/.test(rawTail) ||
          Number(rawTail) < 1 ||
          Number(rawTail) > options.maxTail ||
          !['true', 'false'].includes(follow)
        )
          throw new AgentError(
            'INVALID_INPUT',
            `tail must be 1–${options.maxTail} and follow must be true or false.`,
            400,
          );
        if (streams >= options.maxStreams)
          throw new AgentError(
            'STREAM_LIMIT_EXCEEDED',
            'This host has reached its concurrent log stream limit.',
            429,
          );
        const controller = new AbortController();
        activeStreams.add(controller);
        streams++;
        const closed = () => controller.abort();
        response.once('close', closed);
        let timeLimit = false;
        const timer = setTimeout(() => {
          timeLimit = true;
          controller.abort();
        }, options.streamSeconds * 1000);
        timer.unref();
        let source: IncomingMessage | undefined;
        try {
          const inspect = await docker.json<DockerInspect>(
            'GET',
            `/containers/${id}/json`,
            controller.signal,
          );
          if (inspect.HostConfig?.LogConfig?.Type === 'none')
            throw new AgentError(
              'LOGGING_DISABLED',
              'Logging is disabled for this container.',
              422,
            );
          source = await docker.stream(
            `/containers/${id}/logs?stdout=true&stderr=true&timestamps=true&details=false&tail=${Number(rawTail)}&follow=${follow}`,
            controller.signal,
          );
          response.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Accel-Buffering': 'no',
          });
          response.flushHeaders();
          let bytes = 0;
          for await (const line of decodeLogLines(
            source,
            inspect.Config?.Tty === true,
            options.maxLineBytes,
          )) {
            const size = Buffer.byteLength(JSON.stringify(line)) + 1;
            if (bytes + size > options.maxLogBytes) {
              await writeLine(
                response,
                {
                  stream: 'console',
                  text: 'Log stream limit reached. Reopen the view for a new bounded excerpt.',
                  truncated: true,
                },
                controller.signal,
              );
              break;
            }
            bytes += size;
            await writeLine(response, line, controller.signal);
          }
        } catch (error) {
          if (!response.headersSent) throw error;
          if (!response.destroyed && !response.writableEnded) {
            const message = timeLimit
              ? 'Log stream time limit reached. Resume to reconnect.'
              : error instanceof AgentError
                ? error.message
                : 'The Docker log connection was interrupted. Resume to reconnect.';
            // One bounded terminal notice; do not wait on a disconnected or slow client.
            if (response.writableLength < 256 * 1024)
              response.write(
                JSON.stringify({
                  stream: 'console',
                  text: message,
                  truncated: true,
                } satisfies LogLine) + '\n',
              );
          }
        } finally {
          clearTimeout(timer);
          source?.destroy();
          controller.abort();
          response.off('close', closed);
          activeStreams.delete(controller);
          streams--;
          if (response.headersSent && !response.destroyed) response.end();
        }
        return;
      }
      throw new AgentError(
        'METHOD_NOT_ALLOWED',
        'This endpoint does not allow the requested HTTP method.',
        405,
      );
    } catch (error) {
      const failure =
        error instanceof AgentError
          ? error
          : new AgentError(
              'AGENT_INTERNAL_ERROR',
              'The agent could not complete this request.',
              500,
            );
      if (!response.headersSent)
        sendJson(response, failure.status === 499 ? 408 : failure.status, {
          code: failure.code,
          message: failure.message,
        });
      else if (!response.destroyed) response.end();
    } finally {
      if (ordinary) ordinaryRequests--;
    }
  };
  const server = options.development
    ? http.createServer((req, res) => void handler(req, res))
    : https.createServer(
        { ...options.tls!, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' },
        (req, res) => void handler(req, res),
      );
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => docker.close());
  return {
    server,
    docker,
    close: () =>
      new Promise((resolve) => {
        for (const controller of activeStreams) controller.abort();
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}
