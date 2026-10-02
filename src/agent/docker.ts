import http, { type IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

export class AgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

export interface EngineVersion {
  Version: string;
  ApiVersion: string;
  MinAPIVersion?: string;
  Os?: string;
}
export interface DockerClientOptions {
  socketPath: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Only agent-owned routes call this client; no browser-controlled Docker paths. */
export class DockerClient {
  private readonly pool = new http.Agent({
    keepAlive: true,
    maxSockets: 12,
    maxTotalSockets: 12,
    maxFreeSockets: 4,
  });
  private versionPromise: Promise<{ version: EngineVersion; prefix: string }> | undefined;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  constructor(readonly options: DockerClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
  }

  async version(): Promise<EngineVersion> {
    return (await this.negotiate()).version;
  }
  private negotiate(): Promise<{ version: EngineVersion; prefix: string }> {
    if (!this.versionPromise) {
      this.versionPromise = this.rawJson<EngineVersion>('GET', '/version')
        .then((version) => {
          const parse = (value: string | undefined, fallback: number) => {
            if (value === undefined) return fallback;
            const match = /^1\.(\d+)$/.exec(value);
            if (!match)
              throw new AgentError(
                'ENGINE_VERSION_UNSUPPORTED',
                'The Docker Engine API version is invalid.',
              );
            return Number(match[1]);
          };
          const selected = Math.min(parse(version.ApiVersion, 0), 56);
          if (selected < 41 || parse(version.MinAPIVersion, 41) > selected) {
            throw new AgentError(
              'ENGINE_VERSION_UNSUPPORTED',
              'This agent requires a compatible Docker Engine API between 1.41 and 1.56.',
            );
          }
          if (version.Os && version.Os !== 'linux')
            throw new AgentError(
              'ENGINE_PLATFORM_UNSUPPORTED',
              'Version 1 of this agent supports Linux Docker hosts.',
            );
          return { version, prefix: `/v1.${selected}` };
        })
        .catch((error) => {
          this.versionPromise = undefined;
          throw error;
        });
    }
    return this.versionPromise;
  }

  async json<T>(
    method: 'GET' | 'POST',
    path: string,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const { prefix } = await this.negotiate();
    return this.rawJson<T>(method, prefix + path, signal, timeoutMs);
  }

  async stream(path: string, signal: AbortSignal): Promise<IncomingMessage> {
    const { prefix } = await this.negotiate();
    return this.open('GET', prefix + path, signal, this.timeoutMs, true);
  }

  private async rawJson<T>(
    method: 'GET' | 'POST',
    path: string,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const response = await this.open(method, path, signal, timeoutMs, false);
    const data = await readBounded(response, this.maxResponseBytes);
    if (!data.length) return undefined as T;
    try {
      return JSON.parse(data.toString('utf8')) as T;
    } catch {
      throw new AgentError('ENGINE_INVALID_RESPONSE', 'Docker returned an invalid JSON response.');
    }
  }

  private open(
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    streaming: boolean,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      let receivedHeaders = false;
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path,
          method,
          agent: this.pool,
          signal,
          headers: {
            Accept: 'application/json',
            ...(method === 'POST' ? { 'Content-Length': '0' } : {}),
          },
        },
        (response) => {
          receivedHeaders = true;
          if (streaming) clearTimeout(deadline);
          const status = response.statusCode ?? 502;
          if ((status >= 200 && status < 300) || (status === 304 && method === 'POST')) {
            resolve(response);
            return;
          }
          void readBounded(response, 64 * 1024)
            .then((body) => {
              let dockerMessage = '';
              try {
                dockerMessage = String(
                  (JSON.parse(body.toString('utf8')) as { message?: unknown }).message ?? '',
                );
              } catch {
                /* Never forward raw error bodies. */
              }
              if (status === 404)
                reject(
                  new AgentError(
                    'RESOURCE_NOT_FOUND',
                    'The selected Docker resource no longer exists.',
                    404,
                  ),
                );
              else if (
                /configured logging driver does not support reading|does not support reading/i.test(
                  dockerMessage,
                )
              )
                reject(
                  new AgentError(
                    'LOGS_UNAVAILABLE',
                    'This logging driver does not expose container logs. Check whether dual logging is enabled.',
                    422,
                  ),
                );
              else if (status === 409 || status === 304)
                reject(
                  new AgentError(
                    'STATE_CONFLICT',
                    'The container state changed or does not allow this action.',
                    409,
                  ),
                );
              else
                reject(
                  new AgentError(
                    'ENGINE_REQUEST_FAILED',
                    `Docker could not complete the requested operation (HTTP ${status}).`,
                    502,
                  ),
                );
            })
            .catch(reject);
        },
      );
      const deadline = setTimeout(
        () =>
          request.destroy(
            new AgentError(
              'ENGINE_TIMEOUT',
              'Docker did not respond before the request deadline.',
              504,
            ),
          ),
        timeoutMs,
      );
      deadline.unref();
      request.on('error', (error) => {
        clearTimeout(deadline);
        if (error instanceof AgentError) reject(error);
        else if (signal?.aborted)
          reject(new AgentError('REQUEST_CANCELLED', 'The request was cancelled.', 499));
        else
          reject(
            new AgentError(
              'ENGINE_UNREACHABLE',
              'The local Docker socket could not be reached. Check socket path and permissions.',
              503,
            ),
          );
      });
      request.on('close', () => {
        if (!receivedHeaders || !streaming) clearTimeout(deadline);
      });
      request.end();
    });
  }

  close(): void {
    this.pool.destroy();
  }
}

export async function readBounded(stream: Readable, maxBytes: number): Promise<Buffer> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += buffer.length;
    if (length > maxBytes) {
      stream.destroy();
      throw new AgentError(
        'RESPONSE_LIMIT_EXCEEDED',
        'The Docker response exceeded the configured size limit.',
        413,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

export async function mapLimit<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        result[index] = await task(values[index]!);
      }
    }),
  );
  return result;
}
